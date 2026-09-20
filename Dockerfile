FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx wget \
  && pip install --no-cache-dir flask flask-cors spacy \
  && python -m spacy download de_core_news_sm \
  && rm -rf /var/lib/apt/lists/*

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY dictionary.json /usr/share/nginx/html/dictionary.json
COPY vendor /usr/share/nginx/html/vendor
COPY ner_server.py /app/ner_server.py

WORKDIR /app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

CMD python ner_server.py & nginx -g 'daemon off;'
