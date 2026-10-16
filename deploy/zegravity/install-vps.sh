#!/usr/bin/env bash
# Install or update ZeGravity CRM on the Aitek VPS behind the existing nginx-proxy.
#
#   curl -fsSL https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity/install-vps.sh | bash
#
# Safe to re-run. It only adds files for crm.zgravity.io; existing sites are never
# edited, and any nginx change that fails `nginx -t` is removed before reloading.
set -euo pipefail

DOMAIN="${DOMAIN:-crm.zgravity.io}"
APP_DIR=/opt/zegravity-crm
PROXY_DIR=/opt/nginx-proxy
PROXY_CONTAINER=nginx-proxy-nginx-1
PROXY_NETWORK=zg_proxy
TEMPLATE_SITE=kpi.zgravity.io
WEBROOT=/var/www/certbot
RAW=https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

reload_proxy_or_revert() {
  local file="$1"
  if docker exec "$PROXY_CONTAINER" nginx -t >/tmp/zg-nginx-test.log 2>&1; then
    docker exec "$PROXY_CONTAINER" nginx -s reload
  else
    rm -f "$file"
    cat /tmp/zg-nginx-test.log >&2
    fail "nginx rejected the new $DOMAIN config, so it was removed and nothing was reloaded."
  fi
}

step "Checking the server"
command -v docker >/dev/null || fail "docker is not installed"
docker inspect "$PROXY_CONTAINER" >/dev/null 2>&1 || fail "$PROXY_CONTAINER is not running"
docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1 || fail "docker network $PROXY_NETWORK not found"
# Find the live kpi site config by content, wherever it sits under the proxy folder.
TEMPLATE_PATH=$(grep -rlE "server_name[^;]*${TEMPLATE_SITE//./\\.}" "$PROXY_DIR" 2>/dev/null | xargs -r grep -l "kpi-dashboard:3000" | head -1) \
  || true
[ -n "$TEMPLATE_PATH" ] || fail "could not find the $TEMPLATE_SITE nginx config under $PROXY_DIR"
TEMPLATE_DIR=$(dirname "$TEMPLATE_PATH")
TEMPLATE_NAME=$(basename "$TEMPLATE_PATH")
case "$TEMPLATE_NAME" in
  *"$TEMPLATE_SITE"*) SITE_NAME="${TEMPLATE_NAME//$TEMPLATE_SITE/$DOMAIN}" ;;
  *.conf) SITE_NAME="$DOMAIN.conf" ;;
  *) SITE_NAME="$DOMAIN" ;;
esac
SITE_FILE="$TEMPLATE_DIR/$SITE_NAME"
docker exec "$PROXY_CONTAINER" nginx -T 2>/dev/null | grep -q "kpi-dashboard:3000" \
  || fail "nginx is not currently loading the $TEMPLATE_SITE config; not touching the proxy"
echo "template: $TEMPLATE_PATH"
echo "new site file: $SITE_FILE"

step "Installing the CRM in $APP_DIR"
mkdir -p "$APP_DIR"
cd "$APP_DIR"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
if [ ! -f .env ]; then
  umask 077
  printf 'TAG=latest\nSERVER_URL=https://%s\nENCRYPTION_KEY=%s\nPG_DATABASE_PASSWORD=%s\nSTORAGE_TYPE=local\n' \
    "$DOMAIN" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > .env
  echo "created .env with new secrets (back this file up)"
else
  echo "keeping existing .env"
fi
# Join the proxy network under a stable name so nginx can reach the app.
cat > docker-compose.override.yml <<EOF
services:
  server:
    networks:
      default: {}
      proxy:
        aliases: [zegravity-crm]
networks:
  proxy:
    external: true
    name: $PROXY_NETWORK
EOF
docker compose pull --quiet
docker compose up -d

step "Waiting for the CRM to start (first start sets up the database, up to 10 minutes)"
for _ in $(seq 1 120); do
  if docker compose exec -T server curl -sf http://localhost:3000/healthz >/dev/null 2>&1; then
    echo "CRM is healthy"; break
  fi
  sleep 5
done
docker compose exec -T server curl -sf http://localhost:3000/healthz >/dev/null 2>&1 \
  || fail "the CRM did not become healthy; run: cd $APP_DIR && docker compose logs --tail 80 server"

step "Getting the HTTPS certificate for $DOMAIN"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  if [ ! -f "$SITE_FILE" ]; then
    cat > "$SITE_FILE" <<EOF
# Temporary: answers the certificate challenge until the full site file replaces it.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 404; }
}
EOF
    reload_proxy_or_revert "$SITE_FILE"
  fi
  mkdir -p "$WEBROOT"
  if command -v certbot >/dev/null; then
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
  else
    docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/www:/var/www certbot/certbot \
      certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
  fi
fi
[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || fail "certificate for $DOMAIN was not issued"

step "Publishing $DOMAIN through nginx-proxy"
sed -E -e "s/${TEMPLATE_SITE//./\\.}/$DOMAIN/g" \
    -e "s#http://kpi-dashboard:3000#http://zegravity-crm:3000#g" \
    -e "s/client_max_body_size[^;]*;/client_max_body_size 50M;/" \
    -e "s#(ssl_(certificate|certificate_key|trusted_certificate)[[:space:]]+[^;]*/live/)[^/;]+/#\\1$DOMAIN/#" \
    "$TEMPLATE_PATH" > "/tmp/zg-site.new"
grep -q "zegravity-crm:3000" /tmp/zg-site.new || fail "could not adapt $TEMPLATE_PATH (unexpected upstream)"
mv /tmp/zg-site.new "$SITE_FILE"
reload_proxy_or_revert "$SITE_FILE"

step "Checking https://$DOMAIN"
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/healthz" || true)
echo "https://$DOMAIN/healthz -> HTTP $code"
[ "$code" = 200 ] || fail "the site did not answer over HTTPS yet (HTTP $code)"
printf '\nDONE: ZeGravity CRM is live at https://%s\nSecrets: %s/.env (back it up)\n' "$DOMAIN" "$APP_DIR"
