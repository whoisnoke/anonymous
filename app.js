// ===========================
// STATE
// ===========================
let tokens = []; // { id, text, type, redacted, suggested }
let tokenById = new Map(); // id -> token object, O(1) lookup (perf)
let spanById = new Map();  // id -> DOM span element, O(1) partial re-render (perf)
let history = []; // stack of token-state snapshots for undo
let isEditorMode = false;
let selectionStart = null;
let customTerms = []; // user-defined { text, replacement } to redact
let candidates = []; // auto-detected candidates (dates/emails/names), grouped by unique text, each with optional .replacement
let dictionaryTerms = []; // flat list of names/terms loaded from dictionary.json + gelernte Begriffe
let dictionaryLoadPromise = null;
let viewMode = 'redacted'; // 'redacted' = schwarzer Balken, 'replaced' = Platzhaltertext anzeigen
let tokenPlaceholder = new Map(); // tokenId -> spezifischer Platzhaltertext (von Begriff/Kandidat übernommen)
let defaultPlaceholder = '[ANONYMISIERT]'; // Fallback-Platzhalter für Tokens ohne eigenen Begriff
let learnedTerms = new Set(); // Begriffe, die durch Schwärzen automatisch "gelernt" wurden

// ---------------------------
// Python-NER-Server (optional, siehe ner_server.py)
// ---------------------------
const NER_SERVER_URL = 'http://127.0.0.1:5001/detect-names';
let useNerServer = false;
let nerServerStatus = 'unknown'; // 'unknown' | 'ok' | 'error'

// Lädt dictionary.json — erwartetes Format: flaches Array von Strings,
// z.B. ["Max Mustermann", "Erika Musterfrau", "Musterstraße"].
// fetch() von lokalen Dateien wird von manchen Browsern bei file:// blockiert (CORS) —
// in diesem Fall bleibt dictionaryTerms leer und es erscheint einmalig ein Hinweis-Toast.
// Checkbox "Python-NER-Server verwenden" wurde umgeschaltet
function onNerToggle(checked) {
  useNerServer = checked;
  try { localStorage.setItem('redactomat_use_ner', checked ? '1' : '0'); } catch (e) {}
  if (checked) checkNerServerHealth();
}

// Kurzer Health-Check (mit Timeout), damit die Statusanzeige stimmt und
// eine spätere Analyse nicht unnötig lange auf einen toten Server wartet.
async function checkNerServerHealth() {
  const statusEl = document.getElementById('nerStatus');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(NER_SERVER_URL.replace('/detect-names', '/health'), { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    nerServerStatus = 'ok';
    if (statusEl) { statusEl.className = 'ner-status ner-status-ok'; statusEl.title = 'NER-Server erreichbar'; }
  } catch (e) {
    nerServerStatus = 'error';
    if (statusEl) { statusEl.className = 'ner-status ner-status-error'; statusEl.title = 'NER-Server nicht erreichbar — läuft "python ner_server.py"?'; }
  }
}

// Schickt den vollständigen Text an den lokalen Python-NER-Server und
// mischt die gefundenen Personennamen als zusätzliche "Name"-Kandidaten
// in die bereits (per Heuristik) berechnete Kandidatenliste ein.
// Läuft NACH der normalen (schnellen) Analyse, damit die Oberfläche sofort
// reagiert und die NER-Ergebnisse einfach "nachträglich" ergänzt werden.
async function runNerDetection(text) {
  if (!useNerServer) return;
  const statusEl = document.getElementById('nerStatus');
  const loadingRow = document.getElementById('nerLoadingRow');
  if (loadingRow) loadingRow.style.display = 'flex';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(NER_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    nerServerStatus = 'ok';
    if (statusEl) { statusEl.className = 'ner-status ner-status-ok'; statusEl.title = 'NER-Server erreichbar'; }

    const names = Array.isArray(data.names) ? data.names : [];
    if (names.length === 0) return;
    mergeNerNamesIntoCandidates(names);
  } catch (e) {
    nerServerStatus = 'error';
    if (statusEl) { statusEl.className = 'ner-status ner-status-error'; statusEl.title = 'NER-Server nicht erreichbar — läuft "python ner_server.py"?'; }
    console.warn('NER-Server nicht erreichbar:', e);
  } finally {
    if (loadingRow) loadingRow.style.display = 'none';
  }
}

// Fügt vom NER-Server gemeldete Namen als Kandidaten hinzu (falls noch nicht
// über die Heuristik gefunden) und aktualisiert Vorschlags-Markierung + Liste.
function mergeNerNamesIntoCandidates(names) {
  const map = new Map(candidates.map(c => [c.key, c]));
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');
  let addedCount = 0;

  names.forEach(entry => {
    const termWords = String(entry).trim().split(/\s+/).filter(Boolean);
    if (termWords.length === 0) return;
    const key = 'name|' + entry.toLowerCase();

    forEachTermMatch(wordIndices, termWords, (idxArray) => {
      if (!map.has(key)) { map.set(key, { key, type: 'name', text: entry, tokenIds: [], occurrences: 0 }); addedCount++; }
      map.get(key).tokenIds.push(...idxArray);
      map.get(key).occurrences++;
    });
  });

  if (addedCount === 0) return; // alles bereits durch Heuristik gefunden

  candidates = Array.from(map.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.text.localeCompare(b.text, 'de');
  });
  markCandidatesAsSuggested();
  renderCandidatesList();
  tokens.forEach(t => { if (t.type === 'word') updateTokenSpanClass(t); });
  showToast(`${addedCount} zusätzliche(r) Name(n) per NER erkannt.`, 'sparkles');
}

async function loadDictionary() {
  try {
    const res = await fetch('dictionary.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (Array.isArray(data)) {
      dictionaryTerms = data.filter(x => typeof x === 'string' && x.trim().length > 0);
    } else {
      console.warn('dictionary.json hat nicht das erwartete Format (flaches Array von Strings).');
    }
  } catch (e) {
    console.warn('dictionary.json konnte nicht geladen werden:', e);
    showToast('dictionary.json konnte nicht geladen werden. Falls du die Seite per Doppelklick öffnest, starte stattdessen einen lokalen Server (z.B. "python3 -m http.server" im Ordner) und öffne die Seite über http://localhost.', 'alert-circle');
  } finally {
    // Gelernte Begriffe (localStorage) werden UNABHÄNGIG davon eingebunden, ob
    // dictionary.json erfolgreich geladen werden konnte — so funktioniert das
    // automatische Lernen auch dann, wenn die JSON-Datei per file:// blockiert wird.
    loadLearnedTerms();
    mergeLearnedIntoDictionary();
    buildDictionaryIndex();
  }
}

const LEARNED_TERMS_KEY = 'redactomat_learned_terms';

function loadLearnedTerms() {
  try {
    const raw = localStorage.getItem(LEARNED_TERMS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    learnedTerms = new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    learnedTerms = new Set();
  }
}

function saveLearnedTerms() {
  try {
    localStorage.setItem(LEARNED_TERMS_KEY, JSON.stringify([...learnedTerms]));
  } catch (e) { /* Speicher nicht verfügbar — gelernte Begriffe bleiben nur für diese Sitzung erhalten */ }
}

function mergeLearnedIntoDictionary() {
  const existing = new Set(dictionaryTerms.map(t => t.toLowerCase()));
  learnedTerms.forEach(term => {
    if (!existing.has(term.toLowerCase())) {
      dictionaryTerms.push(term);
      existing.add(term.toLowerCase());
    }
  });
}

// Merkt sich einen geschwärzten Begriff dauerhaft (localStorage) und nimmt ihn
// sofort ins aktive Wörterbuch auf, damit er bei der nächsten Analyse
// automatisch als Kandidat vorgeschlagen wird.
function learnTerm(text) {
  const clean = String(text || '').trim();
  // Nur sinnvolle Wort-/Namensbestandteile lernen, keine Ein-Zeichen-Reste
  if (clean.replace(/[^\p{L}]/gu, '').length < 2) return;
  const key = clean.toLowerCase();
  if (learnedTerms.has(clean)) return;
  // Groß-/Kleinschreibungs-Duplikate vermeiden
  for (const existing of learnedTerms) {
    if (existing.toLowerCase() === key) return;
  }
  learnedTerms.add(clean);
  saveLearnedTerms();
  mergeLearnedIntoDictionary();
  buildDictionaryIndex();
}

// Gruppiert alle Wörterbuch-Einträge nach ihrem (kleingeschriebenen) ersten Wort.
// Damit muss beim Erkennen nicht mehr jeder Eintrag den kompletten Text absuchen
// (O(Einträge × Wörter)), sondern es reicht EIN Durchlauf über den Text, bei dem
// pro Wortposition nur die wenigen dazu passenden Einträge geprüft werden.
let dictionaryIndex = new Map();
function buildDictionaryIndex() {
  dictionaryIndex = new Map();
  dictionaryTerms.forEach(entry => {
    const words = String(entry).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const firstLower = words[0].toLowerCase();
    if (!dictionaryIndex.has(firstLower)) dictionaryIndex.set(firstLower, []);
    dictionaryIndex.get(firstLower).push({ words, entry });
  });
}

// Shared helper: strip ANY surrounding non-letter/non-digit characters before matching
// (handles <>, «», „", (), [], etc. — not just a hardcoded punctuation list)
function stripPunct(s) {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

// Nach jeder Neuzuweisung von `tokens` (tokenize, undo, reset, …) aufrufen,
// damit tokenById wieder mit dem aktuellen Array übereinstimmt.
function rebuildTokenIndex() {
  tokenById = new Map(tokens.map(t => [t.id, t]));
}

// ===========================
// INIT LUCIDE
// ===========================
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  loadCustomTerms();
  renderCustomTermsList();
  dictionaryLoadPromise = loadDictionary();
  setupEditorPaneEvents();
  setupDragAndDrop();

  try {
    const savedPlaceholder = localStorage.getItem('redactomat_default_placeholder');
    if (savedPlaceholder) {
      defaultPlaceholder = savedPlaceholder;
      const input = document.getElementById('defaultPlaceholderInput');
      if (input) input.value = savedPlaceholder;
    }
  } catch (e) { /* Speicher nicht verfügbar — Standard-Platzhalter bleibt [ANONYMISIERT] */ }

  try {
    const savedUseNer = localStorage.getItem('redactomat_use_ner');
    if (savedUseNer === '1') {
      useNerServer = true;
      const cb = document.getElementById('nerToggle');
      if (cb) cb.checked = true;
      checkNerServerHealth();
    }
  } catch (e) {}
});

// ===========================
// ANALYSIS
// ===========================
// ===========================
// DATEI-UPLOAD (.txt / .docx)
// ===========================
function showUploadStatus(text) {
  const el = document.getElementById('uploadStatus');
  document.getElementById('uploadStatusText').textContent = text;
  el.style.display = 'flex';
}
function hideUploadStatus() {
  document.getElementById('uploadStatus').style.display = 'none';
}

async function handleFileUpload(fileList) {
  const file = fileList && fileList[0];
  if (!file) return;

  const name = file.name.toLowerCase();
  showUploadStatus(`Lese „${file.name}" …`);

  try {
    let text;
    if (name.endsWith('.docx')) {
      if (typeof mammoth === 'undefined') {
        throw new Error('mammoth.js konnte nicht geladen werden (keine Internetverbindung?)');
      }
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      text = result.value;
    } else if (name.endsWith('.txt') || file.type === 'text/plain' || !name.includes('.')) {
      text = await file.text();
    } else {
      throw new Error('Nicht unterstütztes Dateiformat. Bitte .txt oder .docx verwenden.');
    }

    document.getElementById('inputTextarea').value = text;
    hideUploadStatus();
    showToast(`„${file.name}" geladen (${text.length.toLocaleString('de-DE')} Zeichen).`, 'file-check');
  } catch (e) {
    hideUploadStatus();
    console.error('Datei-Upload fehlgeschlagen:', e);
    showToast('Datei konnte nicht gelesen werden: ' + e.message, 'alert-circle');
  } finally {
    document.getElementById('fileUploadInput').value = '';
  }
}

function setupDragAndDrop() {
  const textarea = document.getElementById('inputTextarea');
  ['dragenter', 'dragover'].forEach(evt => {
    textarea.addEventListener(evt, (e) => {
      e.preventDefault();
      textarea.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    textarea.addEventListener(evt, (e) => {
      e.preventDefault();
      textarea.classList.remove('drag-over');
    });
  });
  textarea.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files);
    }
  });
}

async function startAnalysis() {
  const text = document.getElementById('inputTextarea').value.trim();
  if (!text) {
    showToast('Bitte zuerst Text eingeben.', 'alert-circle');
    return;
  }
  if (dictionaryLoadPromise) await dictionaryLoadPromise;
  tokenize(text);
  renderEditor();
  switchToEditorMode();

  // Läuft im Hintergrund weiter, blockiert die Oberfläche nicht — die schnelle
  // Heuristik ist sofort sichtbar, NER-Treffer ergänzen die Liste kurz danach.
  if (useNerServer) runNerDetection(text);
}

function tokenize(text) {
  tokens = [];
  let id = 0;

  // Split by word boundaries, preserving whitespace and newlines as tokens
  const regex = /(\r?\n|\s+|[^\s\r\n]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const t = match[0];
    let type = 'word';
    if (/^\r?\n$/.test(t)) type = 'newline';
    else if (/^\s+$/.test(t)) type = 'whitespace';

    tokens.push({ id: id++, text: t, type, redacted: false, suggested: false });
  }
  rebuildTokenIndex();

  // Auto-suggest patterns
  suggestPatterns();
  detectCandidates();
  markCandidatesAsSuggested();
}

function suggestPatterns() {
  const dateRx  = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
  const emailRx = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  tokens.forEach(t => {
    if (t.type === 'word') {
      const clean = stripPunct(t.text);
      if (dateRx.test(clean) || emailRx.test(clean)) {
        t.suggested = true;
      }
    }
  });
  markCustomTermSuggestions();
}

// ===========================
// RENDER EDITOR
// ===========================
function renderEditor() {
  const pane = document.getElementById('editorPane');
  pane.innerHTML = '';
  spanById = new Map();

  if (tokens.length === 0) {
    pane.innerHTML = '<div class="empty-state"><p>Kein Text vorhanden.</p></div>';
    return;
  }

  // DocumentFragment sammelt alle Knoten im Speicher und wird erst am Ende
  // in einem Rutsch ins DOM eingehängt — vermeidet N einzelne Reflows.
  const fragment = document.createDocumentFragment();

  tokens.forEach((tok, idx) => {
    if (tok.type === 'newline') {
      fragment.appendChild(document.createElement('br'));
      return;
    }

    if (tok.type === 'whitespace') {
      const span = document.createElement('span');
      span.className = 'token whitespace';
      span.textContent = tok.text;
      fragment.appendChild(span);
      return;
    }

    const span = document.createElement('span');
    span.dataset.id = tok.id;
    span.dataset.idx = idx;
    // Klick-/Auswahl-Verhalten läuft über EINEN delegierten Listener auf
    // dem Pane-Container (siehe setupEditorPaneEvents) statt 3 Listenern
    // pro einzelnem Wort — bei großen Texten sonst ein Perf-Killer.
    fragment.appendChild(span);
    spanById.set(tok.id, span);
    updateTokenSpanClass(tok); // setzt Klasse + Text passend zum aktuellen viewMode
  });

  pane.appendChild(fragment);

  updateStatsAndMeter();
  updateHistory();
  renderCandidatesList();
}

// Aktualisiert nur die CSS-Klasse (und ggf. den sichtbaren Text) eines
// einzelnen Token-Spans, ohne das komplette Pane neu zu rendern. Für
// Aktionen, die nur wenige Tokens betreffen (Klick, Kandidat togglen, …).
function updateTokenSpanClass(tok) {
  const span = spanById.get(tok.id);
  if (!span) return;

  if (tok.redacted && viewMode === 'replaced') {
    span.className = 'token replaced';
    span.textContent = tokenPlaceholder.get(tok.id) || defaultPlaceholder;
  } else {
    span.className = 'token' + (tok.redacted ? ' redacted' : (tok.suggested ? ' suggested' : ''));
    span.textContent = tok.text;
  }
}

// Wechselt zwischen "Schwärzen" (schwarzer Balken, Originaltext bleibt im
// DOM verdeckt) und "Ersetzen" (zeigt den zugewiesenen Platzhaltertext an).
function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('btnViewRedacted').classList.toggle('active', mode === 'redacted');
  document.getElementById('btnViewReplaced').classList.toggle('active', mode === 'replaced');
  tokens.forEach(t => { if (t.type === 'word' && t.redacted) updateTokenSpanClass(t); });
}

// Einmalig beim Laden der Seite registriert (siehe DOMContentLoaded):
// EIN Klick-/Auswahl-Handler für das gesamte Editor-Pane statt tausender
// einzelner Listener pro Wort.
function setupEditorPaneEvents() {
  const pane = document.getElementById('editorPane');

  pane.addEventListener('click', (e) => {
    const span = e.target.closest('.token');
    if (!span || span.classList.contains('whitespace') || !span.dataset.id) return;
    e.stopPropagation();
    toggleToken(parseInt(span.dataset.id, 10));
  });

  pane.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const span = e.target.closest('.token');
    if (!span || span.classList.contains('whitespace') || !span.dataset.idx) return;
    selectionStart = parseInt(span.dataset.idx, 10);
  });

  pane.addEventListener('mouseup', (e) => {
    const span = e.target.closest('.token');
    if (!span || span.classList.contains('whitespace') || !span.dataset.idx) {
      selectionStart = null;
      return;
    }
    const idx = parseInt(span.dataset.idx, 10);
    if (selectionStart !== null && selectionStart !== idx) {
      const from = Math.min(selectionStart, idx);
      const to = Math.max(selectionStart, idx);
      redactRange(from, to);
    }
    selectionStart = null;
  });
}

// ===========================
// TOGGLE / REDACT
// ===========================
// Aktualisiert Statistik/Meter/Verlauf/Kandidatenliste, OHNE die Wort-Spans
// neu zu erzeugen — für Aktionen, die die betroffenen Spans bereits selbst
// per updateTokenSpanClass() aktualisiert haben.
function refreshEditorUI() {
  updateStatsAndMeter();
  updateHistory();
  renderCandidatesList();
}

function toggleToken(id) {
  const tok = tokenById.get(id);
  if (!tok || tok.type !== 'word') return;
  saveHistory(`"${tok.text.substring(0, 20)}"`);
  tok.redacted = !tok.redacted;
  tok.suggested = false;
  if (tok.redacted) {
    const clean = stripPunct(tok.text);
    learnTerm(clean);
    registerManualRedaction(clean);
  } else {
    tokenPlaceholder.delete(tok.id);
  }
  updateTokenSpanClass(tok);
  refreshEditorUI();
}

function redactRange(from, to) {
  saveHistory('Phrasenauswahl');
  let changed = false;
  const phraseWords = [];
  for (let i = from; i <= to; i++) {
    if (tokens[i] && tokens[i].type === 'word') {
      tokens[i].redacted = true;
      tokens[i].suggested = false;
      phraseWords.push(stripPunct(tokens[i].text));
      updateTokenSpanClass(tokens[i]);
      changed = true;
    }
  }
  if (changed) {
    // Die gesamte markierte Phrase (z.B. "Max Mustermann") als EIN Begriff lernen,
    // nicht als Einzelwörter — das entspricht eher dem, was tatsächlich markiert wurde.
    const phrase = phraseWords.filter(Boolean).join(' ');
    learnTerm(phrase);
    registerManualRedaction(phrase);
    refreshEditorUI();
  }
}

// Trägt einen manuell geschwärzten Begriff automatisch in "Eigene Begriffe" ein,
// damit sofort ein Platzhalter dafür gesetzt werden kann — auch wenn der Begriff
// vorher NICHT als Kandidat (Datum/E-Mail/Name) vorgeschlagen wurde.
function registerManualRedaction(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const exists = customTerms.some(t => t.text.toLowerCase() === clean.toLowerCase());
  if (exists) return;
  customTerms.push({ text: clean, replacement: '' });
  saveCustomTermsToStorage();
  renderCustomTermsList();
}

// ===========================
// AUTO DETECT (Kandidatenliste)
// ===========================
const CANDIDATE_TYPE_META = {
  email:   { label: 'E-Mail',   icon: 'at-sign' },
  date:    { label: 'Datum',    icon: 'calendar' },
  name:    { label: 'Name',     icon: 'user' },
  phone:   { label: 'Telefon',  icon: 'phone' },
  iban:    { label: 'IBAN',     icon: 'credit-card' },
  address: { label: 'Adresse',  icon: 'map-pin' }
};

function detectCandidates() {
  const dateRx  = /^\d{1,2}\.\d{1,2}\.\d{2,4}$/;
  const emailRx = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  const map = new Map();

  tokens.forEach(tok => {
    if (tok.type !== 'word') return;
    const clean = stripPunct(tok.text);
    if (!clean) return;

    let type = null;
    if (emailRx.test(clean)) type = 'email';
    else if (dateRx.test(clean)) type = 'date';
    if (!type) return;

    const key = type + '|' + clean.toLowerCase();
    if (!map.has(key)) map.set(key, { key, type, text: clean, tokenIds: [], occurrences: 0 });
    map.get(key).tokenIds.push(tok.id);
    map.get(key).occurrences++;
  });

  detectNameCandidates(map);
  detectDictionaryCandidates(map);
  detectWrittenDateCandidates(map);
  detectPhoneCandidates(map);
  detectIbanCandidates(map);
  detectAddressCandidates(map);

  candidates = Array.from(map.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.text.localeCompare(b.text, 'de');
  });
}

function addCandidate(map, type, tokenIds, text) {
  if (!tokenIds.length) return;
  const key = type + '|' + text.toLowerCase();
  if (!map.has(key)) map.set(key, { key, type, text, tokenIds: [], occurrences: 0 });
  map.get(key).tokenIds.push(...tokenIds);
  map.get(key).occurrences++;
}

// Baut den Anzeigetext für einen mehrwortigen Treffer und entfernt dabei
// Satzzeichen NUR am Ende des letzten Tokens (z.B. den Punkt nach "Mai." oder
// das Komma nach "12,") — interne Formatierung (z.B. "1." beim Tag, "0171-")
// bleibt erhalten.
function joinTokensCleanEnd(idxArray) {
  return idxArray.map((idx, pos) =>
    pos === idxArray.length - 1 ? stripPunct(tokens[idx].text) : tokens[idx].text
  ).join(' ');
}

// ---------------------------
// Ausgeschriebene Datumsformate: "1. Januar 1980", "01. Jan 1980", "1. Mai"
// ---------------------------
const MONTH_NAMES_DE = {
  'januar': 1, 'jan': 1,
  'februar': 2, 'feb': 2,
  'märz': 3, 'maerz': 3, 'mrz': 3, 'mär': 3,
  'april': 4, 'apr': 4,
  'mai': 5,
  'juni': 6, 'jun': 6,
  'juli': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'oktober': 10, 'okt': 10,
  'november': 11, 'nov': 11,
  'dezember': 12, 'dez': 12
};

function detectWrittenDateCandidates(map) {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');
  const dayRx = /^\d{1,2}\.?$/;
  const yearRx = /^\d{4}$/;

  for (let i = 0; i < wordIndices.length; i++) {
    const dayIdx = wordIndices[i];
    const dayClean = stripPunct(tokens[dayIdx].text);
    if (!dayRx.test(dayClean)) continue;
    const dayNum = parseInt(dayClean, 10);
    if (dayNum < 1 || dayNum > 31) continue;

    if (i + 1 >= wordIndices.length) continue;
    const monthIdx = wordIndices[i + 1];
    const monthClean = stripPunct(tokens[monthIdx].text).toLowerCase();
    if (!(monthClean in MONTH_NAMES_DE)) continue;

    const matchedIdx = [dayIdx, monthIdx];
    let nextWi = i + 2;
    // Jahr ist optional, aber wird mitgenommen wenn vorhanden
    if (nextWi < wordIndices.length) {
      const yearIdx = wordIndices[nextWi];
      const yearClean = stripPunct(tokens[yearIdx].text);
      if (yearRx.test(yearClean)) {
        matchedIdx.push(yearIdx);
        nextWi++;
      }
    }

    const text = joinTokensCleanEnd(matchedIdx);
    addCandidate(map, 'date', matchedIdx, text);
    i = wordIndices.indexOf(matchedIdx[matchedIdx.length - 1]);
  }
}

// ---------------------------
// Telefonnummern (deutsche Formate: 030 12345678, +49 171 1234567,
// (030) 12345678, 0171-1234567, 0171/1234567, …)
// ---------------------------
const PHONE_SEGMENT_RX = /^[+]?[\d\-\/()]{2,}$/;

function detectPhoneCandidates(map) {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  for (let i = 0; i < wordIndices.length; i++) {
    if (!PHONE_SEGMENT_RX.test(tokens[wordIndices[i]].text)) continue;

    const matchedIdx = [];
    let digitCount = 0;
    let wi = i;
    while (wi < wordIndices.length && matchedIdx.length < 6) {
      const idx = wordIndices[wi];
      const raw = tokens[idx].text;
      if (!PHONE_SEGMENT_RX.test(raw)) break;
      matchedIdx.push(idx);
      digitCount += (raw.match(/\d/g) || []).length;
      wi++;
    }

    if (digitCount >= 6 && digitCount <= 15) {
      const text = joinTokensCleanEnd(matchedIdx);
      addCandidate(map, 'phone', matchedIdx, text);
    }
    i = wordIndices.indexOf(matchedIdx[matchedIdx.length - 1]);
  }
}

// ---------------------------
// IBAN (einzelnes Token ohne Leerzeichen, oder in Gruppen geschrieben).
// Bewusst auf deutsche IBANs beschränkt (DE + 20 Ziffern, feste Länge 22) —
// das macht die Erkennung eindeutig (kein Weiterfressen nachfolgender Wörter)
// und deckt den in deutschen Dokumenten weit überwiegenden Fall ab.
// ---------------------------
const IBAN_DE_FULL_RX = /^DE\d{20}$/;
const IBAN_DE_START_RX = /^DE\d{2}$/;
const IBAN_DIGIT_GROUP_RX = /^\d{1,4}$/;
const IBAN_DE_LENGTH = 22; // "DE" + 2 Prüfziffern + 18 Kontoziffern

function detectIbanCandidates(map) {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  for (let i = 0; i < wordIndices.length; i++) {
    const idx = wordIndices[i];
    const clean = stripPunct(tokens[idx].text).toUpperCase();

    // Fall 1: komplette IBAN in einem Token, ohne Leerzeichen
    if (IBAN_DE_FULL_RX.test(clean)) {
      addCandidate(map, 'iban', [idx], clean);
      continue;
    }

    // Fall 2: in Gruppen geschrieben, z.B. "DE12 3456 7890 1234 5678 90"
    if (!IBAN_DE_START_RX.test(clean)) continue;
    let combined = clean;
    const matchedIdx = [idx];
    let wi = i + 1;
    let matched = false;

    while (wi < wordIndices.length && combined.length < IBAN_DE_LENGTH) {
      const nextIdx = wordIndices[wi];
      const nextClean = stripPunct(tokens[nextIdx].text);
      if (!IBAN_DIGIT_GROUP_RX.test(nextClean)) break; // nur reine Zifferngruppen anhängen
      combined += nextClean;
      matchedIdx.push(nextIdx);
      wi++;
    }

    // Nur akzeptieren, wenn die Gruppen exakt auf die deutsche IBAN-Länge summieren —
    // kein Raten bei zu kurzen/zu langen Resten, kein Weiterlaufen über den Treffer hinaus.
    if (combined.length === IBAN_DE_LENGTH && IBAN_DE_FULL_RX.test(combined)) {
      matched = true;
      const text = matchedIdx.map(x => stripPunct(tokens[x].text).toUpperCase()).join(' ');
      addCandidate(map, 'iban', matchedIdx, text);
    }

    if (matched) i = wordIndices.indexOf(matchedIdx[matchedIdx.length - 1]);
  }
}

// ---------------------------
// Adressen: Straßenname (endet auf -straße/-weg/-platz/…) + Hausnummer
// ---------------------------
const STREET_SUFFIXES = ['straße', 'strasse', 'str', 'weg', 'allee', 'platz', 'gasse', 'ring', 'damm', 'ufer', 'steig', 'pfad'];
const HOUSE_NUMBER_RX = /^\d{1,4}[a-zA-Z]?$/;

function detectAddressCandidates(map) {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  for (let i = 0; i < wordIndices.length; i++) {
    const idx = wordIndices[i];
    const clean = stripPunct(tokens[idx].text).toLowerCase().replace(/\.$/, '');
    const isStreet = STREET_SUFFIXES.some(suf => clean.length > suf.length && clean.endsWith(suf));
    if (!isStreet) continue;
    if (i + 1 >= wordIndices.length) continue;

    const numIdx = wordIndices[i + 1];
    const numClean = stripPunct(tokens[numIdx].text);
    if (!HOUSE_NUMBER_RX.test(numClean)) continue;

    const matchedIdx = [idx, numIdx];
    const text = joinTokensCleanEnd(matchedIdx);
    addCandidate(map, 'address', matchedIdx, text);
    i = wordIndices.indexOf(numIdx);
  }
}

// ---------------------------
// Wörterbuch (dictionary.json) — flaches Array von Strings
// ---------------------------
function detectDictionaryCandidates(map) {
  if (!dictionaryIndex || dictionaryIndex.size === 0) return;

  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  for (let i = 0; i < wordIndices.length; i++) {
    const firstClean = stripPunct(tokens[wordIndices[i]].text).toLowerCase();
    const candidates_ = dictionaryIndex.get(firstClean);
    if (!candidates_) continue;

    for (const { words, entry } of candidates_) {
      let ok = true;
      const matchedIdx = [];
      let wi = i;
      for (let w = 0; w < words.length; w++) {
        if (wi >= wordIndices.length) { ok = false; break; }
        const tIdx = wordIndices[wi];
        const clean = stripPunct(tokens[tIdx].text).toLowerCase();
        if (clean !== words[w].toLowerCase()) { ok = false; break; }
        matchedIdx.push(tIdx);
        wi++;
      }
      if (!ok) continue;

      const key = 'name|' + entry.toLowerCase();
      if (!map.has(key)) map.set(key, { key, type: 'name', text: entry, tokenIds: [], occurrences: 0 });
      map.get(key).tokenIds.push(...matchedIdx);
      map.get(key).occurrences++;
    }
  }
}

// ---------------------------
// Namens-Heuristik (Titel- und Grußformel-basiert)
// ---------------------------
const NAME_TITLES = ['herr', 'herrn', 'frau', 'fräulein', 'dr', 'prof', 'mag', 'ing'];
const NAME_GREETING_PHRASES = [
  ['mit', 'freundlichen', 'grüßen'],
  ['mit', 'besten', 'grüßen'],
  ['freundliche', 'grüße'],
  ['viele', 'grüße'],
  ['beste', 'grüße'],
  ['herzliche', 'grüße']
];
// Häufige Wörter, die nach einer Grußformel stehen können, aber keine Namen sind
const NAME_STOPWORDS = new Set([
  'der', 'die', 'das', 'wir', 'ich', 'sie', 'bitte', 'vielen', 'für', 'diese',
  'dieser', 'dieses', 'anbei', 'hiermit', 'bei', 'mit', 'ihre', 'ihr', 'unser',
  'unsere', 'sehr', 'beste', 'viele', 'herzliche', 'freundliche', 'freundlichen',
  'grüßen', 'grüße', 'dank', 'danke', 'p', 's', 'ps'
]);
// Nachnamen-Partikel, die innerhalb eines Namens vorkommen können ("von", "van der" …)
const NAME_PARTICLES = new Set(['von', 'van', 'de', 'zu', 'der', 'den']);

// Sammelt eine Folge großgeschriebener Wort-Token ab wordIndices[startWi]
function collectCapitalizedRun(wordIndices, startWi, maxWords) {
  const ids = [];
  const words = [];
  let wi = startWi;
  while (wi < wordIndices.length && words.length < maxWords) {
    const idx = wordIndices[wi];
    const clean = stripPunct(tokens[idx].text);
    if (!clean) break;
    const isCapitalized = /^\p{Lu}/u.test(clean);

    if (!isCapitalized) {
      const lower = clean.toLowerCase();
      const nextIdx = wordIndices[wi + 1];
      const nextClean = nextIdx !== undefined ? stripPunct(tokens[nextIdx].text) : '';
      // Namenspartikel wie "von"/"van" nur mitnehmen, wenn davor UND danach ein Name steht
      if (NAME_PARTICLES.has(lower) && words.length > 0 && /^\p{Lu}/u.test(nextClean)) {
        ids.push(idx);
        words.push(clean);
        wi++;
        continue;
      }
      break;
    }
    ids.push(idx);
    words.push(clean);
    wi++;
  }
  if (words.length === 0) return null;
  return { tokenIds: ids, text: words.join(' '), nextWi: wi };
}

function detectNameCandidates(map) {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  function addName(tokenIds, text) {
    if (!text || text.replace(/[^\p{L}]/gu, '').length < 2) return;
    const key = 'name|' + text.toLowerCase();
    if (!map.has(key)) map.set(key, { key, type: 'name', text, tokenIds: [], occurrences: 0 });
    map.get(key).tokenIds.push(...tokenIds);
    map.get(key).occurrences++;
  }

  // 1) Titel-basiert: "Herr/Frau/Dr./Prof. [Dr.] Vorname Nachname" — sehr zuverlässig
  for (let wi = 0; wi < wordIndices.length; wi++) {
    const clean = stripPunct(tokens[wordIndices[wi]].text).toLowerCase().replace(/\.$/, '');
    if (!NAME_TITLES.includes(clean)) continue;

    // Mehrere aneinandergereihte Titel überspringen (z.B. "Frau Prof. Dr.")
    let wi2 = wi + 1;
    while (wi2 < wordIndices.length) {
      const c2 = stripPunct(tokens[wordIndices[wi2]].text).toLowerCase().replace(/\.$/, '');
      if (NAME_TITLES.includes(c2)) wi2++; else break;
    }

    const run = collectCapitalizedRun(wordIndices, wi2, 3);
    if (run) {
      addName(run.tokenIds, run.text);
      wi = run.nextWi - 1;
    }
  }

  // 2) Grußformel-basiert: Name in der Unterschrift nach "Mit freundlichen Grüßen" o.ä.
  for (let wi = 0; wi < wordIndices.length; wi++) {
    for (const phrase of NAME_GREETING_PHRASES) {
      let matches = true;
      for (let p = 0; p < phrase.length; p++) {
        const wIdx = wi + p;
        if (wIdx >= wordIndices.length) { matches = false; break; }
        const c = stripPunct(tokens[wordIndices[wIdx]].text).toLowerCase();
        if (c !== phrase[p]) { matches = false; break; }
      }
      if (!matches) continue;

      const run = collectCapitalizedRun(wordIndices, wi + phrase.length, 3);
      if (run) {
        const firstWord = run.text.split(' ')[0].toLowerCase();
        if (!NAME_STOPWORDS.has(firstWord)) addName(run.tokenIds, run.text);
      }
      break;
    }
  }
}

// Markiert alle erkannten Kandidaten (Datum/E-Mail/Name) im Editor gelb, ohne sie zu schwärzen
function markCandidatesAsSuggested() {
  candidates.forEach(cand => {
    cand.tokenIds.forEach(id => {
      const t = tokenById.get(id);
      if (t && !t.redacted) t.suggested = true;
    });
  });
}

// Ermittelt, ob alle / einige / keine Vorkommen eines Kandidaten aktuell geschwärzt sind
function getCandidateState(cand) {
  let allRedacted = true;
  let anyRedacted = false;
  cand.tokenIds.forEach(id => {
    const t = tokenById.get(id);
    if (t && t.redacted) anyRedacted = true; else allRedacted = false;
  });
  if (cand.tokenIds.length === 0) return 'none';
  if (allRedacted) return 'all';
  if (anyRedacted) return 'partial';
  return 'none';
}

function renderCandidatesList() {
  const container = document.getElementById('candidatesList');
  if (!container) return;

  if (!candidates || candidates.length === 0) {
    container.innerHTML = isEditorMode
      ? '<p class="no-history" style="width:100%; padding:6px 0;">Keine Muster (Datum/E-Mail) erkannt</p>'
      : '<p class="no-history" style="width:100%; padding:6px 0;">Noch keine Analyse durchgeführt</p>';
    return;
  }

  container.innerHTML = '';
  candidates.forEach(cand => {
    const state = getCandidateState(cand);
    const meta = CANDIDATE_TYPE_META[cand.type];
    const safeKey = cand.key.replace(/'/g, "\\'");
    const row = document.createElement('div');
    row.className = 'candidate-row-wrap';
    row.innerHTML = `
      <div class="candidate-row">
        <span class="candidate-check ${state === 'all' ? 'checked' : (state === 'partial' ? 'partial' : '')}"
          onclick="toggleCandidate('${safeKey}')" title="Schwärzung für alle Vorkommen umschalten">
          <span class="cc-box"></span>
        </span>
        <i data-lucide="${meta.icon}" size="12" style="flex-shrink:0; color:#94A3B8;"></i>
        <span class="candidate-text" title="${escapeHtml(cand.text)}">${escapeHtml(cand.text)}</span>
        ${cand.occurrences > 1 ? `<span class="candidate-count">${cand.occurrences}×</span>` : ''}
      </div>
      ${`<input type="text" class="tc-placeholder-input" placeholder="Platzhalter (optional), auch vor dem Schwärzen setzbar"
        value="${escapeHtml(cand.replacement || '')}"
        oninput="setCandidateReplacement('${safeKey}', this.value)">`}
    `;
    container.appendChild(row);
  });
  lucide.createIcons();
}

function setCandidateReplacement(key, value) {
  const cand = candidates.find(c => c.key === key);
  if (!cand) return;
  cand.replacement = value;
  const placeholder = value && value.trim() ? value.trim() : null;
  cand.tokenIds.forEach(id => {
    const t = tokenById.get(id);
    if (!t || !t.redacted) return;
    if (placeholder) tokenPlaceholder.set(t.id, placeholder);
    else tokenPlaceholder.delete(t.id);
    updateTokenSpanClass(t);
  });
}

function toggleCandidate(key) {
  const cand = candidates.find(c => c.key === key);
  if (!cand) return;
  const makeRedacted = getCandidateState(cand) !== 'all';
  const placeholder = cand.replacement && cand.replacement.trim() ? cand.replacement.trim() : null;

  saveHistory(`${makeRedacted ? 'Schwärzen' : 'Aufheben'}: "${cand.text.substring(0, 20)}"`);
  cand.tokenIds.forEach(id => {
    const t = tokenById.get(id);
    if (!t) return;
    t.redacted = makeRedacted;
    t.suggested = false;
    if (makeRedacted && placeholder) tokenPlaceholder.set(t.id, placeholder);
    else tokenPlaceholder.delete(t.id);
    updateTokenSpanClass(t);
  });
  // Namen automatisch ins Wörterbuch übernehmen (Datum/E-Mail sind für die
  // Namenserkennung nicht relevant und würden das Wörterbuch nur aufblähen)
  if (makeRedacted && cand.type === 'name') learnTerm(cand.text);
  refreshEditorUI();
}

function toggleAllCandidates(makeRedacted) {
  if (!isEditorMode) {
    showToast('Bitte zuerst Analyse starten.', 'alert-circle');
    return;
  }
  if (!candidates || candidates.length === 0) {
    showToast('Keine Kandidaten vorhanden.', 'info');
    return;
  }

  saveHistory(makeRedacted ? 'Alle Kandidaten schwärzen' : 'Alle Kandidaten aufheben');
  let count = 0;
  candidates.forEach(cand => {
    const placeholder = cand.replacement && cand.replacement.trim() ? cand.replacement.trim() : null;
    let matched = false;
    cand.tokenIds.forEach(id => {
      const t = tokenById.get(id);
      if (t && t.redacted !== makeRedacted) {
        t.redacted = makeRedacted;
        t.suggested = false;
        if (makeRedacted && placeholder) tokenPlaceholder.set(t.id, placeholder);
        else tokenPlaceholder.delete(t.id);
        updateTokenSpanClass(t);
        count++;
        matched = true;
      }
    });
    if (makeRedacted && matched && cand.type === 'name') learnTerm(cand.text);
  });
  refreshEditorUI();
  showToast(makeRedacted ? `${count} Vorkommen geschwärzt.` : `${count} Vorkommen aufgehoben.`, makeRedacted ? 'check-circle' : 'eraser');
}

// ===========================
// CUSTOM TERMS (eigene zu schwärzende Begriffe)
// ===========================
const CUSTOM_TERMS_KEY = 'redactomat_custom_terms';

function loadCustomTerms() {
  try {
    const raw = localStorage.getItem(CUSTOM_TERMS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // Migration: ältere Version speicherte reine Strings statt {text, replacement}
    customTerms = parsed.map(t => typeof t === 'string' ? { text: t, replacement: '' } : t);
  } catch (e) {
    customTerms = [];
  }
}

function saveCustomTermsToStorage() {
  try {
    localStorage.setItem(CUSTOM_TERMS_KEY, JSON.stringify(customTerms));
  } catch (e) { /* Speicher nicht verfügbar — Liste bleibt nur für diese Sitzung erhalten */ }
}

function renderCustomTermsList() {
  const container = document.getElementById('customTermsList');
  if (customTerms.length === 0) {
    container.innerHTML = '<p class="no-history" style="width:100%; padding:6px 0;">Noch keine eigenen Begriffe</p>';
    return;
  }
  container.innerHTML = '';
  customTerms.forEach((term, i) => {
    const row = document.createElement('div');
    row.className = 'term-chip term-chip-row';
    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px; width:100%;">
        <span title="${escapeHtml(term.text)}" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(term.text)}</span>
        <span class="tc-remove" title="Entfernen" onclick="removeCustomTerm(${i})">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </span>
      </div>
      <input type="text" class="tc-placeholder-input" placeholder="Platzhalter (optional), z.B. [PERSON]"
        value="${escapeHtml(term.replacement || '')}"
        oninput="setCustomTermReplacement(${i}, this.value)">
    `;
    container.appendChild(row);
  });
}

function setCustomTermReplacement(index, value) {
  if (!customTerms[index]) return;
  customTerms[index].replacement = value;
  saveCustomTermsToStorage();
  // Falls der Begriff bereits geschwärzt im Dokument steht, Platzhalter live nachziehen
  if (isEditorMode) applyCustomTermPlaceholders();
}

function addCustomTerm() {
  const input = document.getElementById('customTermInput');
  const value = input.value.trim();
  if (!value) return;

  const exists = customTerms.some(t => t.text.toLowerCase() === value.toLowerCase());
  if (exists) {
    showToast('Begriff ist bereits in der Liste.', 'info');
    input.value = '';
    return;
  }

  customTerms.push({ text: value, replacement: '' });
  saveCustomTermsToStorage();
  renderCustomTermsList();
  input.value = '';
  input.focus();

  if (isEditorMode) {
    markCustomTermSuggestions();
    renderEditor();
  }
  showToast(`„${value}" zur Liste hinzugefügt.`, 'plus');
}

function removeCustomTerm(index) {
  const removed = customTerms.splice(index, 1);
  saveCustomTermsToStorage();
  renderCustomTermsList();
  if (isEditorMode && removed.length) {
    // Vorschlags-Markierungen neu berechnen (bereits geschwärzte Wörter bleiben unangetastet)
    tokens.forEach(t => { if (t.type === 'word') t.suggested = false; });
    suggestPatterns();
    markCandidatesAsSuggested();
    renderEditor();
  }
}

// Markiert Tokens, die zu einem eigenen Begriff passen, als "Vorschlag" (gelb),
// ohne sie automatisch zu schwärzen.
function markCustomTermSuggestions() {
  if (customTerms.length === 0) return;
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  customTerms.forEach(term => {
    const termWords = term.text.trim().split(/\s+/).filter(Boolean);
    if (termWords.length === 0) return;
    forEachTermMatch(wordIndices, termWords, (idxArray) => {
      idxArray.forEach(idx => { if (!tokens[idx].redacted) tokens[idx].suggested = true; });
    });
  });
}

// Trägt für bereits geschwärzte Vorkommen eigener Begriffe den (ggf. geänderten)
// Platzhaltertext in tokenPlaceholder ein und aktualisiert die Anzeige live.
function applyCustomTermPlaceholders() {
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');
  customTerms.forEach(term => {
    const termWords = term.text.trim().split(/\s+/).filter(Boolean);
    if (termWords.length === 0) return;
    forEachTermMatch(wordIndices, termWords, (idxArray) => {
      idxArray.forEach(idx => {
        const tok = tokens[idx];
        if (!tok.redacted) return;
        if (term.replacement && term.replacement.trim()) tokenPlaceholder.set(tok.id, term.replacement.trim());
        else tokenPlaceholder.delete(tok.id);
        updateTokenSpanClass(tok);
      });
    });
  });
}

// Findet Vorkommen einer (ggf. mehrwortigen) Begriffsfolge in der Tokenliste
// und ruft für jedes gefundene Vorkommen onMatch(idxArray) EINMAL auf
// (idxArray enthält alle Wort-Token-Indizes dieses einen Vorkommens).
function forEachTermMatch(wordIndices, termWords, onMatch) {
  const targets = termWords.map(w => w.toLowerCase());
  for (let i = 0; i < wordIndices.length; i++) {
    let ok = true;
    const matchedIdx = [];
    let wi = i;
    for (let w = 0; w < targets.length; w++) {
      if (wi >= wordIndices.length) { ok = false; break; }
      const idx = wordIndices[wi];
      const clean = stripPunct(tokens[idx].text).toLowerCase();
      if (clean !== targets[w]) { ok = false; break; }
      matchedIdx.push(idx);
      wi++;
    }
    if (ok) onMatch(matchedIdx);
  }
}

function redactCustomTerms() {
  if (!isEditorMode) {
    showToast('Bitte zuerst Analyse starten.', 'alert-circle');
    return;
  }
  if (customTerms.length === 0) {
    showToast('Bitte zuerst eigene Begriffe hinzufügen.', 'alert-circle');
    return;
  }

  saveHistory('Eigene Begriffe');
  let count = 0;
  const wordIndices = tokens.map((t, i) => i).filter(i => tokens[i].type === 'word');

  customTerms.forEach(term => {
    const termWords = term.text.trim().split(/\s+/).filter(Boolean);
    if (termWords.length === 0) return;
    const hasReplacement = term.replacement && term.replacement.trim();
    let termMatched = false;
    forEachTermMatch(wordIndices, termWords, (idxArray) => {
      idxArray.forEach(idx => {
        if (!tokens[idx].redacted) {
          tokens[idx].redacted = true;
          tokens[idx].suggested = false;
          if (hasReplacement) tokenPlaceholder.set(tokens[idx].id, term.replacement.trim());
          updateTokenSpanClass(tokens[idx]);
          count++;
          termMatched = true;
        }
      });
    });
    if (termMatched) learnTerm(term.text);
  });

  refreshEditorUI();
  showToast(count > 0 ? `${count} Wort(e) aus eigener Liste geschwärzt.` : 'Keine Treffer für eigene Begriffe gefunden.', count > 0 ? 'check-circle' : 'info');
}

// ===========================
// UNDO
// ===========================
function saveHistory(label) {
  history.push({ label, snapshot: tokens.map(t => ({ ...t })) });
  if (history.length > 50) history.shift();
}

function undo() {
  if (history.length === 0) {
    showToast('Keine weiteren Schritte.', 'info');
    return;
  }
  const prev = history.pop();
  tokens = prev.snapshot;
  rebuildTokenIndex();
  renderEditor();
  showToast('Rückgängig gemacht.', 'undo-2');
}

// ===========================
// CLEAR
// ===========================
function clearAll() {
  saveHistory('Alle aufheben');
  tokens.forEach(t => { t.redacted = false; t.suggested = false; });
  tokenPlaceholder.clear();
  renderEditor();
  showToast('Alle Schwärzungen aufgehoben.', 'eraser');
}

// ===========================
// EXPORT: TEXT
// ===========================
// fallbackOverride: optionaler Platzhalter, der statt defaultPlaceholder verwendet
// wird, wenn für ein Token kein eigener (Begriffs-/Kandidaten-)Platzhalter gesetzt ist.
function getProcessedText(fallbackOverride) {
  const fallback = fallbackOverride || defaultPlaceholder;
  return tokens.map(t => {
    if (!t.redacted) return t.text;
    return tokenPlaceholder.get(t.id) || fallback;
  }).join('');
}

function copyText() {
  const text = getProcessedText();
  navigator.clipboard.writeText(text).then(() => {
    showToast('Text kopiert!', 'clipboard-copy');
  });
}

function copyTextXXX() {
  const text = getProcessedText('[XXX]');
  navigator.clipboard.writeText(text).then(() => {
    showToast('Text mit [XXX] kopiert!', 'clipboard');
  });
}

function downloadTxt() {
  const text = getProcessedText();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `redact-o-mat-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Datei wird heruntergeladen.', 'download');
}

// Globalen Standard-Platzhalter setzen (für alle Tokens ohne eigenen Begriffs-Platzhalter)
function setDefaultPlaceholder(value) {
  defaultPlaceholder = value.trim() || '[ANONYMISIERT]';
  try { localStorage.setItem('redactomat_default_placeholder', defaultPlaceholder); } catch (e) {}
  if (isEditorMode && viewMode === 'replaced') {
    tokens.forEach(t => { if (t.type === 'word' && t.redacted) updateTokenSpanClass(t); });
  }
}

// Lädt das komplette aktuelle Wörterbuch (dictionary.json-Basis + automatisch
// gelernte Begriffe) als Datei herunter — damit lässt sich die eigene
// dictionary.json dauerhaft aktualisieren (echtes Zurückschreiben auf die
// Festplatte ist aus dem Browser heraus aus Sicherheitsgründen nicht möglich).
function downloadDictionary() {
  const merged = [...new Set(dictionaryTerms)].sort((a, b) => a.localeCompare(b, 'de'));
  const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'dictionary.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Wörterbuch mit ${merged.length} Begriffen wird heruntergeladen.`, 'download');
}

// ===========================
// EXPORT: PDF (via pdf-lib, clientseitig)
// ===========================
function showExportOverlay() {
  if (!isEditorMode) {
    showToast('Bitte zuerst Analyse starten.', 'alert-circle');
    return;
  }
  document.getElementById('exportOverlay').classList.add('show');
  setTimeout(() => lucide.createIcons(), 50);
}
function hideExportOverlay() {
  document.getElementById('exportOverlay').classList.remove('show');
}

async function exportPDF() {
  const btn = document.getElementById('btnExportPDF');
  btn.disabled = true;
  btn.innerHTML = '<span style="opacity:.6">Erstelle PDF…</span>';

  try {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(document.getElementById('pdfTitle').value || 'Redact-o-Mat Export');
    pdfDoc.setAuthor('Redact-o-Mat (DSGVO)');
    pdfDoc.setCreator('Redact-o-Mat v1.0');

    const font      = await pdfDoc.embedFont(StandardFonts.Courier);
    const fontBold  = await pdfDoc.embedFont(StandardFonts.CourierBold);

    // Page setup (A4)
    const PAGE_W = 595.28, PAGE_H = 841.89;
    const MARGIN = 56;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const FONT_SIZE = 11;
    const LINE_H    = FONT_SIZE * 1.7;
    const HEADER_H  = 48;
    const FOOTER_H  = 32;
    const USABLE_H  = PAGE_H - MARGIN - HEADER_H - FOOTER_H;
    const REDACT_PAD_X = 2, REDACT_PAD_Y = 1.5;

    // Color constants
    const cNavy   = rgb(0.118, 0.161, 0.231);
    const cBlack  = rgb(0.059, 0.090, 0.122);
    const cGray   = rgb(0.392, 0.455, 0.545);
    const cAmber  = rgb(0.851, 0.467, 0.024);
    const cWhite  = rgb(1, 1, 1);
    const cBgLine = rgb(0.969, 0.980, 0.988);

    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let pageNum = 1;
    const totalPages = () => pdfDoc.getPageCount();

    function drawPageChrome(p, pn) {
      // Header bar
      p.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: cNavy });
      p.drawText('REDACT-O-MAT', { x: MARGIN, y: PAGE_H - HEADER_H + 18, size: 13, font: fontBold, color: cWhite });
      const badge = 'DSGVO-EXPORT';
      const bw = fontBold.widthOfTextAtSize(badge, 8);
      p.drawRectangle({ x: MARGIN + 120, y: PAGE_H - HEADER_H + 15, width: bw + 10, height: 13, color: cAmber });
      p.drawText(badge, { x: MARGIN + 125, y: PAGE_H - HEADER_H + 18, size: 8, font: fontBold, color: cWhite });

      const docTitle = document.getElementById('pdfTitle').value || 'Schwärzungsdokument';
      p.drawText(docTitle, { x: MARGIN, y: PAGE_H - HEADER_H + 5, size: 8, font, color: rgb(0.6, 0.65, 0.72) });

      // Footer
      p.drawLine({ start: { x: MARGIN, y: FOOTER_H }, end: { x: PAGE_W - MARGIN, y: FOOTER_H }, thickness: 0.5, color: cGray, opacity: 0.3 });
      const now = new Date().toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
      p.drawText(`Erstellt: ${now} · Alle geschwärzten Bereiche sind unwiderruflich entfernt`, { x: MARGIN, y: FOOTER_H - 14, size: 7, font, color: cGray });
      p.drawText(`Seite ${pn}`, { x: PAGE_W - MARGIN - 30, y: FOOTER_H - 14, size: 7, font, color: cGray });
    }

    drawPageChrome(page, pageNum);

    // Build word-wrapped lines from tokens
    // Each line = array of {text, redacted}
    function buildLines() {
      const lines = [];
      let currentLine = [];
      let currentWidth = 0;

      function pushLine() {
        lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
      }

      tokens.forEach(tok => {
        if (tok.type === 'newline') {
          pushLine();
          return;
        }
        if (tok.type === 'whitespace') {
          // Add space width
          const spaceW = font.widthOfTextAtSize(' ', FONT_SIZE);
          currentLine.push({ text: tok.text, redacted: false, width: spaceW * tok.text.length });
          currentWidth += spaceW * tok.text.length;
          return;
        }
        const w = font.widthOfTextAtSize(tok.text, FONT_SIZE);
        if (currentWidth + w > CONTENT_W && currentLine.length > 0) {
          pushLine();
        }
        currentLine.push({ text: tok.text, redacted: tok.redacted, width: w });
        currentWidth += w;
      });
      if (currentLine.length > 0) pushLine();
      return lines;
    }

    const lines = buildLines();
    let y = PAGE_H - HEADER_H - MARGIN;

    lines.forEach((line, li) => {
      // New page if needed
      if (y - LINE_H < FOOTER_H + 10) {
        pageNum++;
        page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        drawPageChrome(page, pageNum);
        y = PAGE_H - HEADER_H - MARGIN;
      }

      // Subtle alternating line bg every 3 lines for readability
      if (Math.floor(li / 1) % 2 === 0) {
        page.drawRectangle({ x: MARGIN - 4, y: y - LINE_H + 3, width: CONTENT_W + 8, height: LINE_H, color: cBgLine, opacity: 0.5 });
      }

      let x = MARGIN;
      line.forEach(chunk => {
        if (chunk.redacted) {
          // Solid black redaction bar — slightly taller than text
          page.drawRectangle({
            x: x - REDACT_PAD_X,
            y: y - FONT_SIZE - REDACT_PAD_Y + 1,
            width: chunk.width + REDACT_PAD_X * 2,
            height: FONT_SIZE + REDACT_PAD_Y * 2,
            color: cBlack
          });
        } else {
          page.drawText(chunk.text, { x, y, size: FONT_SIZE, font, color: cNavy });
        }
        x += chunk.width;
      });

      y -= LINE_H;
    });

    // Save & download
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redact-o-mat-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);

    hideExportOverlay();
    showToast('PDF erfolgreich erstellt!', 'file-down');
  } catch (err) {
    console.error(err);
    showToast('Fehler beim PDF-Export.', 'alert-circle');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="file-down" size="13"></i> PDF erstellen';
    lucide.createIcons();
  }
}

// ===========================
// UI SWITCHES
// ===========================
function switchToEditorMode() {
  isEditorMode = true;
  document.getElementById('inputTextarea').style.display = 'none';
  document.getElementById('editorPane').style.display = 'block';
  document.getElementById('inputToolbar').style.display = 'none';
  document.getElementById('editorToolbar').style.display = 'flex';
  document.getElementById('statsBar').style.display = 'flex';
  document.getElementById('meterBar').style.display = 'block';
  document.getElementById('panelTitle').textContent = 'Schwärzungs-Editor';
  lucide.createIcons();
}

function resetToInput() {
  isEditorMode = false;
  tokens = [];
  rebuildTokenIndex();
  history = [];
  candidates = [];
  tokenPlaceholder.clear();
  document.getElementById('inputTextarea').style.display = 'block';
  document.getElementById('editorPane').style.display = 'none';
  document.getElementById('inputToolbar').style.display = 'flex';
  document.getElementById('editorToolbar').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.getElementById('meterBar').style.display = 'none';
  document.getElementById('panelTitle').textContent = 'Texteingabe';
  document.getElementById('historyList').innerHTML = '<p class="no-history">Noch keine Schwärzungen</p>';
  renderCandidatesList();
  lucide.createIcons();
}

// ===========================
// STATS + METER
// ===========================
// Ein einziger Durchlauf über alle Tokens statt vorher 5 separaten
// .filter()-Durchläufen (updateStats + updateMeter kombiniert) — macht
// bei großen Texten spürbar etwas aus, weil das bei jedem Klick läuft.
function updateStatsAndMeter() {
  let total = 0, redacted = 0, suggested = 0;
  for (const t of tokens) {
    if (t.type !== 'word') continue;
    total++;
    if (t.redacted) redacted++;
    else if (t.suggested) suggested++;
  }

  document.getElementById('statTotal').textContent = `${total} Token`;
  document.getElementById('statRedacted').textContent = `${redacted} geschwärzt`;
  document.getElementById('statSuggested').textContent = `${suggested} Vorschläge`;

  const pct = total > 0 ? (redacted / total * 100) : 0;
  document.getElementById('meterFill').style.width = pct + '%';
}

// ===========================
// HISTORY LIST
// ===========================
function updateHistory() {
  const container = document.getElementById('historyList');
  if (history.length === 0) {
    container.innerHTML = '<p class="no-history">Noch keine Schwärzungen</p>';
    return;
  }
  container.innerHTML = '';
  [...history].reverse().slice(0, 20).forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'history-entry';
    div.innerHTML = `
      <span class="he-text">${escapeHtml(entry.label)}</span>
      <span class="he-badge">●</span>
      <span class="he-undo" title="Rückgängig" onclick="undoToStep(${history.length - 1 - i})">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 14 4 9 9 4"></polyline>
          <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
        </svg>
      </span>
    `;
    container.appendChild(div);
  });
}

function undoToStep(targetIdx) {
  while (history.length > targetIdx + 1) history.pop();
  if (history[targetIdx]) {
    tokens = history[targetIdx].snapshot.map(t => ({ ...t }));
    rebuildTokenIndex();
    history.pop();
    renderEditor();
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===========================
// TOAST
// ===========================
let toastTimer;
function showToast(msg, icon = 'check-circle') {
  const toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  toast.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"></svg><span id="toastMsg">${msg}</span>`;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ===========================
// KEYBOARD SHORTCUTS
// ===========================
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c' && isEditorMode) {
    // Only intercept if not selecting text in textarea
    if (document.activeElement !== document.getElementById('inputTextarea')) {
      e.preventDefault();
      copyText();
    }
  }
  if (e.key === 'Escape') {
    hideExportOverlay();
  }
});

// Re-init icons after DOM mutations
const iconObserver = new MutationObserver(() => lucide.createIcons());
iconObserver.observe(document.getElementById('historyList'), { childList: true });
