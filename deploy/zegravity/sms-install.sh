#!/usr/bin/env bash
# Install or update the ZeGravity CRM texting bridge (Twilio) on the VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity/sms-install.sh | bash
#   ... | bash -s -- --keys     re-enter the Twilio and CRM keys
#
# Asks for any missing key with hidden typing and saves it only in /opt/zegravity-crm/.env.
# Adds one /sms/ route to the CRM's nginx site; a config nginx rejects is rolled back.
set -euo pipefail
{

APP_DIR=/opt/zegravity-crm
PROXY_DIR=/opt/nginx-proxy
PROXY_CONTAINER=nginx-proxy-nginx-1
PROXY_NETWORK=zg_proxy
RAW=https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity
REENTER=false
[ "${1:-}" = "--keys" ] && REENTER=true

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ -f "$APP_DIR/.env" ] || fail "$APP_DIR/.env not found; install the CRM first"
cd "$APP_DIR"

step "Downloading the texting bridge"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
mkdir -p sms
curl -fsSL "$RAW/sms/server.mjs" -o sms/server.mjs
cat > docker-compose.override.yml <<EOF
services:
  server:
    networks:
      default: {}
      proxy:
        aliases: [zegravity-crm]
  sms:
    networks:
      default: {}
      proxy:
        aliases: [zegravity-sms]
networks:
  proxy:
    external: true
    name: $PROXY_NETWORK
EOF

current() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
save() {
  local key="$1" value="$2"
  umask 077
  grep -v -E "^$key=" .env > .env.tmp || true
  printf '%s=%s\n' "$key" "$value" >> .env.tmp
  mv .env.tmp .env
}
# ask KEY "question" PATTERN hidden|visible
ask() {
  local key="$1" question="$2" pattern="$3" mode="$4" value=""
  if [ -n "$(current "$key")" ] && [ "$REENTER" = false ]; then echo "$key: already set"; return; fi
  for _ in 1 2 3; do
    if [ "$mode" = hidden ]; then
      printf '%s (typing is hidden): ' "$question" >/dev/tty; read -rs value </dev/tty; printf '\n' >/dev/tty
    else
      printf '%s: ' "$question" >/dev/tty; read -r value </dev/tty
    fi
    value="$(printf '%s' "$value" | tr -d '[:space:]')"
    if printf '%s' "$value" | grep -qE "^$pattern\$"; then save "$key" "$value"; echo "$key: saved"; return; fi
    echo "That does not look right (expected $pattern); try again." >/dev/tty
  done
  fail "$key was not entered"
}

step "Keys (saved only in $APP_DIR/.env)"
ask TWILIO_ACCOUNT_SID "Twilio Account SID (starts with AC)" 'AC[0-9a-f]{32}' visible
ask TWILIO_AUTH_TOKEN "Twilio Auth Token" '[0-9a-f]{32}' hidden
ask TWILIO_MESSAGING_SERVICE_SID "Twilio Messaging Service SID (starts with MG)" 'MG[0-9a-f]{32}' visible
ask SMS_CRM_API_KEY "ZeGravity CRM API key for the texting bridge" '[A-Za-z0-9._-]{20,}' hidden

step "Starting the bridge"
docker compose up -d sms </dev/null
for _ in $(seq 1 20); do
  docker compose exec -T sms wget -q -O - http://localhost:8080/sms/health </dev/null >/dev/null 2>&1 && break
  sleep 2
done

step "Routing https://<crm>/sms/ to the bridge"
SITE_FILE=$(grep -rl "zegravity-crm:3000" "$PROXY_DIR" 2>/dev/null | grep -v '\.bak' | head -1 || true)
[ -n "$SITE_FILE" ] || fail "could not find the CRM nginx site file under $PROXY_DIR"
if grep -q "zegravity-sms" "$SITE_FILE"; then
  echo "route already present in $SITE_FILE"
else
  cp "$SITE_FILE" "/tmp/$(basename "$SITE_FILE").before-sms"
  python3 - "$SITE_FILE" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
# A variable upstream resolved at request time: nginx still starts if the bridge is down.
block = """    # ZeGravity texting bridge (Twilio webhooks and the CRM "Send text" workflow)
    location /sms/ {
        resolver 127.0.0.11 valid=30s;
        set $zegravity_sms http://zegravity-sms:8080;
        proxy_pass $zegravity_sms;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 64k;
    }

"""
https_start = re.search(r"listen\s+(\[::\]:)?443", text)
if not https_start:
    sys.exit("no HTTPS server block found")
root = re.compile(r"^[ \t]*location\s+/\s*\{", re.M).search(text, https_start.end())
if not root:
    sys.exit("no 'location /' in the HTTPS server block")
open(path, "w").write(text[:root.start()] + block + text[root.start():])
PY
  if docker exec "$PROXY_CONTAINER" nginx -t </dev/null >/tmp/zg-nginx-test.log 2>&1; then
    docker exec "$PROXY_CONTAINER" nginx -s reload </dev/null
    echo "added the /sms/ route to $SITE_FILE"
  else
    cp "/tmp/$(basename "$SITE_FILE").before-sms" "$SITE_FILE"
    cat /tmp/zg-nginx-test.log >&2
    fail "nginx rejected the /sms/ route, so the site file was restored"
  fi
fi

step "Checking"
DOMAIN=$(current SERVER_URL)
sleep 2
health=$(curl -s "$DOMAIN/sms/health" || true)
echo "$DOMAIN/sms/health -> $health"
case "$health" in
  *'"ok":true'*) printf '\nDONE: texting bridge is live at %s/sms/\n' "$DOMAIN" ;;
  *) fail "the bridge did not report healthy; run: cd $APP_DIR && docker compose logs --tail 40 sms" ;;
esac
exit 0
}
