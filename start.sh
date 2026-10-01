#!/bin/sh
# Trägt den DNS-Server des Containers in die nginx-Konfiguration ein (für den
# optionalen KI-Proxy, siehe nginx.conf) und startet NER-Server + nginx.
RESOLVER=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf)
sed -i "s|__RESOLVER__|${RESOLVER:-127.0.0.11}|" /etc/nginx/conf.d/default.conf
python ner_server.py &
exec nginx -g 'daemon off;'
