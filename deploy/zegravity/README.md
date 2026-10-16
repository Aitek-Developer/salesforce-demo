# ZeGravity CRM — deployment

White-labelled build of [Twenty](https://github.com/twentyhq/twenty) (AGPLv3).
The image is built by `.github/workflows/zegravity-image.yaml` on every push to the
`zegravity` branch and published to `ghcr.io/aitek-developer/zegravity-crm`.

## How the branding works

`brand/branding.json` holds every white-label text edit and `brand/zegravity-mark.svg`
the logo. The image workflow applies them to the upstream code (`apply-branding.py`),
regenerates the icons (`generate-icons.py`), theme tokens and translation catalogs,
then builds. To take an upstream Twenty update: sync `main`, merge it into
`zegravity`, push. If an edit no longer applies, the build stops and names the file.

## First install on the VPS

```bash
mkdir -p /opt/zegravity-crm && cd /opt/zegravity-crm
# copy docker-compose.yml and .env.example from this folder, then:
cp .env.example .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^PG_DATABASE_PASSWORD=.*|PG_DATABASE_PASSWORD=$(openssl rand -hex 24)|" .env
docker compose up -d
```

The app listens on `127.0.0.1:3000`; put a reverse proxy with HTTPS in front of it
for `crm.zegravity.com`. Keep the `.env` file backed up — losing `ENCRYPTION_KEY`
makes stored secrets unreadable.

## Update

```bash
cd /opt/zegravity-crm && docker compose pull && docker compose up -d && docker exec nginx-proxy-nginx-1 nginx -s reload
```

## Licence

Most of the code is AGPLv3: the modified source must stay available to users of
the hosted service (this public repository satisfies that). Files marked
`@license Enterprise` require a Twenty Enterprise subscription in production and
must not be relied on.
