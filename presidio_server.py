"""
Redact-o-Mat – lokaler Presidio-Server für erweiterte PII-Erkennung
====================================================================

Nutzt Microsoft Presidio (presidio-analyzer) mit einem deutschen spaCy-Modell,
um über die reine Namenserkennung von ner_server.py hinaus ein breites
Spektrum personenbezogener Daten zu erkennen: Personen, Orte, Organisationen,
Datumsangaben, E-Mails, Telefonnummern, IBANs, Kreditkarten, IP-Adressen,
URLs und Krypto-Wallet-Adressen.

Läuft bewusst NEBEN ner_server.py als dritte, unabhängige Option (eigener
Port, eigener Toggle in index.html) — beide Server sind optional und
unabhängig voneinander an-/abschaltbar. Die eigentliche Schwärzung (Platz-
halter, Nummerierung, Undo, Export) bleibt vollständig in index.html; dieser
Server liefert nur ERKENNUNGEN (Presidio-Analyzer), keine Textersetzung
(presidio-anonymizer wird bewusst NICHT verwendet — der interaktive Editor
mit an/abwählbaren Kandidaten lässt sich nicht mit bereits ersetztem Text
abbilden).

EINMALIGE EINRICHTUNG
----------------------
    pip install presidio-analyzer flask flask-cors phonenumbers
    python -m spacy download de_core_news_sm

    # Für bessere Genauigkeit (größer, langsamer beim Laden):
    # python -m spacy download de_core_news_lg
    # (dann PRESIDIO_SPACY_MODEL=de_core_news_lg setzen, siehe unten)

STARTEN
-------
    python presidio_server.py

    Läuft dann auf http://127.0.0.1:5002
    index.html fragt diesen Server automatisch ab, WENN er erreichbar UND
    der Presidio-Toggle aktiviert ist — läuft er nicht, bleibt es bei der
    JS-Heuristik (und ggf. dem separaten NER-Server für Namen).

ENDPUNKTE
---------
    POST /analyze
    Body:     {"text": "Herr Peter Zorn wohnt in Berlin."}
    Antwort:  {"entities": [
                 {"entity_type": "PERSON", "start": 5, "end": 15, "score": 0.85},
                 {"entity_type": "LOCATION", "start": 24, "end": 30, "score": 0.85}
               ], "count": 2}

    GET /presidio-health
    Antwort:  {"status": "ok", "model": "de_core_news_sm"}

Eigener Endpunktname /presidio-health (statt /health) — läuft neben
ner_server.py auf demselben nginx, /health bleibt dort exklusiv dem
NER-Server vorbehalten (siehe nginx.conf).
"""

import os

from flask import Flask, request, jsonify
from flask_cors import CORS
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import CreditCardRecognizer, PhoneRecognizer

app = Flask(__name__)
# CORS offen für lokale Nutzung — index.html läuft ggf. auf file:// (Origin "null")
# oder einem anderen Port (nginx) als dieser Server (Port 5002).
CORS(app)

MODEL_NAME = os.environ.get("PRESIDIO_SPACY_MODEL", "de_core_news_sm")

# Nur Entitäten, die in einem deutschen Geschäfts-/Behördendokument sinnvoll sind.
# Presidio bringt daneben u.a. länderspezifische Erkenner mit (US-Sozialversicherungs-
# nummer, italienischer Führerschein, koreanische Personenkennziffer, …), die für
# deutsche Dokumente nur Falschtreffer produzieren würden und hier NICHT geladen werden.
ALLOWED_ENTITIES = {
    "PERSON", "LOCATION", "ORGANIZATION", "DATE_TIME",
    "EMAIL_ADDRESS", "PHONE_NUMBER", "IBAN_CODE", "CREDIT_CARD",
    "IP_ADDRESS", "URL", "CRYPTO",
}

# Presidio bewertet jeden Treffer mit einem Konfidenzwert (0–1). Unterhalb dieser
# Schwelle sind es meist Zufallstreffer (z.B. eine kurze Ziffernfolge ohne jeden
# Kontext) — die JS-Heuristik in index.html deckt viele dieser Fälle ohnehin
# zuverlässiger ab, Presidio ergänzt hier nur mit ausreichender Sicherheit.
SCORE_THRESHOLD = float(os.environ.get("PRESIDIO_SCORE_THRESHOLD", "0.3"))

print(f"Lade spaCy-Modell '{MODEL_NAME}' für Presidio ... (kann beim ersten Start etwas dauern)")
try:
    _nlp_config = {"nlp_engine_name": "spacy", "models": [{"lang_code": "de", "model_name": MODEL_NAME}]}
    _nlp_engine = NlpEngineProvider(nlp_configuration=_nlp_config).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=_nlp_engine, supported_languages=["de"])
except OSError:
    raise SystemExit(
        f"\nModell '{MODEL_NAME}' nicht gefunden.\n"
        f"Bitte einmalig installieren mit:\n\n    python -m spacy download {MODEL_NAME}\n"
    )

# CreditCardRecognizer ist in Presidios Standard-Erkennerliste nicht automatisch
# für Deutsch aktiv (nur sprachneutrale Muster wie IBAN/E-Mail/URL/IP/Crypto sind
# es) — hier bewusst ergänzt, die Prüfung selbst (Luhn-Algorithmus) ist ohnehin
# länderunabhängig.
analyzer.registry.add_recognizer(CreditCardRecognizer(supported_language="de"))

# Der eingebaute PhoneRecognizer kennt nur englische Kontextwörter ("phone", "call", …)
# für seine Konfidenz-Erhöhung. Ohne Kontext in der Nähe bewertet er auch echte
# deutsche Telefonnummern nur mit ~0.4 — mit deutschen Kontextwörtern in der Nähe
# (z.B. "Telefon:", "erreichbar unter") steigt das auf ~0.75. Zusätzlich auf
# deutschsprachige Regionen beschränkt (sonst werden z.B. US-Nummern vorrangig geraten).
analyzer.registry.remove_recognizer("PhoneRecognizer")
analyzer.registry.add_recognizer(PhoneRecognizer(
    supported_language="de",
    supported_regions=("DE", "AT", "CH"),
    context=["telefon", "tel", "mobil", "handy", "fax", "rufnummer", "erreichbar", "durchwahl", "festnetz"],
))

print("Presidio-Analyzer bereit. Server bereit.")


# Musterbasierte Erkenner (Regex/Prüfsumme) sind für ihr jeweiliges Format eindeutig
# zuständig und sollen bei einer Überschneidung IMMER vor einer bloßen NLP-Vermutung
# gewinnen — auch wenn deren Konfidenzwert zufällig höher ausfällt (Beispiel unten).
PATTERN_ENTITY_TYPES = {
    "EMAIL_ADDRESS", "PHONE_NUMBER", "IBAN_CODE", "CREDIT_CARD",
    "IP_ADDRESS", "URL", "CRYPTO", "DATE_TIME",
}


def resolve_overlaps(results):
    """
    Verschiedene Erkenner liefern gelegentlich Treffer für DENSELBEN Textabschnitt
    (z.B. wird eine URL vom spaCy-Modell zusätzlich fälschlich als ORGANIZATION
    erkannt — dabei sogar mit höherem Score als der korrekte URL-Treffer). Ohne
    Bereinigung würde ein einzelner Text doppelt (und ggf. falsch beschriftet) in
    der Kandidatenliste auftauchen. Reihenfolge daher: zuerst musterbasierte Treffer
    (PATTERN_ENTITY_TYPES), erst dann nach Konfidenz und Länge. Ein Treffer wird nur
    behalten, wenn er sich mit KEINEM bereits akzeptierten, höher eingestuften
    Treffer überschneidet.
    """
    ordered = sorted(results, key=lambda r: (
        0 if r.entity_type in PATTERN_ENTITY_TYPES else 1, -r.score, -(r.end - r.start)
    ))
    kept = []
    for r in ordered:
        if not any(r.start < k.end and k.start < r.end for k in kept):
            kept.append(r)
    return kept


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"entities": [], "count": 0})

    results = analyzer.analyze(text=text, language="de", score_threshold=SCORE_THRESHOLD)
    results = [r for r in results if r.entity_type in ALLOWED_ENTITIES]
    results = resolve_overlaps(results)
    results.sort(key=lambda r: r.start)

    entities = [
        {"entity_type": r.entity_type, "start": r.start, "end": r.end, "score": round(r.score, 2)}
        for r in results
    ]
    return jsonify({"entities": entities, "count": len(entities)})


@app.route("/presidio-health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_NAME})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5002, debug=False)
