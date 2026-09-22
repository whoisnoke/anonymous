FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx wget \
  && pip install --no-cache-dir flask flask-cors spacy presidio-analyzer phonenumbers \
  && python -m spacy download de_core_news_sm \
  && rm -rf /var/lib/apt/lists/*

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY dictionary.json /usr/share/nginx/html/dictionary.json
COPY vendor /usr/share/nginx/html/vendor
COPY ner_server.py /app/ner_server.py
COPY presidio_server.py /app/presidio_server.py

WORKDIR /app

# 8080 = nginx (die App selbst) — für die normale Docker-Nutzung reicht dieser EINE
# Port: index.html spricht NER-/Presidio-Server zuerst über einen relativen Pfad an,
# den nginx intern an 5001/5002 weiterleitet (siehe nginx.conf). 5001/5002 selbst sind
# nur zusätzlich freigegeben, falls man sie mal direkt von außerhalb ansprechen will
# (siehe docker-compose.yml) — für die App-Funktion nicht nötig.
EXPOSE 8080 5001 5002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

# Presidio lädt bei jedem Start ein eigenes spaCy-Modell und braucht dadurch spürbar
# länger als der schlanke NER-Server — beide laufen unabhängig voneinander, ein
# langsamer/fehlender Presidio-Start blockiert also nicht die restliche App.
CMD python ner_server.py & python presidio_server.py & nginx -g 'daemon off;'
