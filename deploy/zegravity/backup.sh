#!/usr/bin/env bash
# Nightly backup of ZeGravity CRM: database, uploaded files, and the .env that holds
# the encryption key (without it the database cannot be decrypted on restore).
#
#   Install once:  curl -fsSL https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity/backup.sh | bash -s -- --install
#   Run by hand:   /opt/zegravity-crm/backup.sh
set -euo pipefail
{

APP_DIR=/opt/zegravity-crm
DEST="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
SCRIPT_URL=https://raw.githubusercontent.com/Aitek-Developer/salesforce-demo/zegravity/deploy/zegravity/backup.sh
CRON_FILE=/etc/cron.d/zegravity-crm-backup
LOG_FILE=/var/log/zegravity-crm-backup.log

if [ "${1:-}" = "--install" ]; then
  curl -fsSL "$SCRIPT_URL" -o "$APP_DIR/backup.sh"
  chmod 700 "$APP_DIR/backup.sh"
  printf '# ZeGravity CRM nightly backup\n15 3 * * * root %s/backup.sh >> %s 2>&1\n' "$APP_DIR" "$LOG_FILE" > "$CRON_FILE"
  chmod 644 "$CRON_FILE"
  echo "installed $APP_DIR/backup.sh and $CRON_FILE (runs daily at 03:15 server time)"
  echo "running a first backup now..."
  exec "$APP_DIR/backup.sh" </dev/null
fi

umask 077
mkdir -p "$DEST"
cd "$APP_DIR"
stamp=$(date +%Y%m%d-%H%M)

docker compose exec -T db pg_dump -U postgres -d default -Fc </dev/null > "$DEST/db-$stamp.dump"
# An empty or tiny dump means pg_dump failed quietly; keep the old backups and stop.
[ "$(stat -c %s "$DEST/db-$stamp.dump")" -gt 10000 ] || { rm -f "$DEST/db-$stamp.dump"; echo "$(date -Is) FAILED: database dump too small" >&2; exit 1; }

docker compose exec -T server tar -czf - -C /app/packages/twenty-server/.local-storage . </dev/null > "$DEST/files-$stamp.tgz"
tar -czf "$DEST/config-$stamp.tgz" .env docker-compose.yml docker-compose.override.yml

find "$DEST" -type f \( -name 'db-*.dump' -o -name 'files-*.tgz' -o -name 'config-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) OK: $(du -sh "$DEST/db-$stamp.dump" | cut -f1) database, kept ${KEEP_DAYS} days in $DEST"
exit 0
}
