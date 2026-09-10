"""
Redact-o-Mat – lokaler NER-Server für automatische Namenserkennung
====================================================================

Nutzt spaCy (deutsches Modell) für echte Named-Entity-Recognition statt
der reinen Titel-/Grußformel-Heuristik in index.html. Erkennt Personen
(PER), optional auch Orte (LOC) und Organisationen (ORG).

EINMALIGE EINRICHTUNG
----------------------
    pip install flask flask-cors spacy
    python -m spacy download de_core_news_sm

    # Für bessere Genauigkeit (größer, langsamer beim Laden):
    # python -m spacy download de_core_news_md

STARTEN
-------
    python ner_server.py

    Läuft dann auf http://127.0.0.1:5001
    index.html fragt diesen Server automatisch ab, WENN er erreichbar ist —
    läuft er nicht, fällt das Tool automatisch auf die JS-Heuristik zurück.
    Der Server muss also nur laufen, wenn du die verbesserte Erkennung willst.

ENDPUNKT
--------
    POST /detect-names
    Body:     {"text": "Ich habe mit Max Mustermann telefoniert."}
    Antwort:  {"names": ["Max Mustermann"], "count": 1}
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import spacy

app = Flask(__name__)
# CORS offen für lokale Nutzung — index.html läuft ggf. auf file:// (Origin "null")
# oder einem anderen Port (nginx) als dieser Server (Port 5001).
CORS(app)

MODEL_NAME = "de_core_news_sm"

print(f"Lade spaCy-Modell '{MODEL_NAME}' ... (kann beim ersten Start etwas dauern)")
try:
    nlp = spacy.load(MODEL_NAME)
except OSError:
    raise SystemExit(
        f"\nModell '{MODEL_NAME}' nicht gefunden.\n"
        f"Bitte einmalig installieren mit:\n\n    python -m spacy download {MODEL_NAME}\n"
    )
print("Modell geladen. Server bereit.")

# Welche spaCy-Entity-Typen sollen als "Name" ans Frontend gemeldet werden?
# PER = Person. LOC/ORG lassen sich bei Bedarf ergänzen (siehe unten).
RELEVANT_LABELS = {"PER"}

# Sehr lange Texte werden in Blöcke aufgeteilt, damit spaCy nicht bei riesigen
# Dokumenten träge wird (Performance-Aspekt, analog zur JS-Seite).
MAX_CHARS_PER_CHUNK = 20000


def extract_names(text: str) -> list[str]:
    names = set()
    for start in range(0, len(text), MAX_CHARS_PER_CHUNK):
        chunk = text[start:start + MAX_CHARS_PER_CHUNK]
        doc = nlp(chunk)
        for ent in doc.ents:
            if ent.label_ in RELEVANT_LABELS:
                cleaned = ent.text.strip()
                # Ein-Zeichen-Reste und reine Satzzeichen ignorieren
                if len(cleaned) >= 2 and any(c.isalpha() for c in cleaned):
                    names.add(cleaned)
    return sorted(names)


@app.route("/detect-names", methods=["POST"])
def detect_names():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"names": [], "count": 0})

    names = extract_names(text)
    return jsonify({"names": names, "count": len(names)})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_NAME})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)