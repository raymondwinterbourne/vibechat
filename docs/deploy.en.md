# Deploying VibeChat

[中文](deploy.md)

This guide shows how to run VibeChat on a server of your own. Everything needed is in the repository's `deploy/` folder:

| File | What it is |
| --- | --- |
| `compose.yaml` | The containers to start |
| `env.example` | Sample settings; copy it to `.env` and fill it in |
| `Dockerfile` | Images for the server and the web app, built on your server |
| `Caddyfile` | The single public entry point: HTTPS, the web pages, forwarding requests to the server |
| `turnserver.conf`, `livekit.yaml` | Settings for the two services used by calls |

## 1. Pick a tier

| | Tier 1: public IP only | Tier 2: a domain with HTTPS |
| --- | --- | --- |
| Text, pictures, files, groups, admin pages | Yes | Yes |
| Voice messages, voice and video calls, screen sharing | No | Yes (start the call services as well, see section 5) |
| Browser notifications | No | Yes |
| Desktop app | No | Yes |
| You need | A server with a public IP address | That, plus a domain name pointing at the server |

Why so much is missing with an IP only: browsers only allow the microphone, camera, screen sharing and notifications on HTTPS pages, and an HTTPS certificate normally needs a domain name. The desktop app also only connects to HTTPS servers.

You can start with tier 1 and move to tier 2 once you have a domain; your data stays.

## 2. Before you start

**The server**

- Linux with Docker. 2 cores and 2 GB of memory are fine for a few dozen people; with calls, bandwidth is the main limit (section 5).
- Docker with the Compose plugin (`docker compose version` must say 2.20 or newer).
- Building the images downloads base images from Docker Hub and Rust and npm dependencies, so the server needs internet access.

**The firewall** (on a cloud server, its "security group" in the console). Open:

| Port | Used for | Which tier |
| --- | --- | --- |
| TCP 80 | The web pages; in tier 2 also for getting the certificate | Both |
| TCP 443, UDP 443 | The web pages over HTTPS | Tier 2 |
| UDP 3478, TCP 3478 | The relay for one-to-one calls | Tier 2, with calls |
| UDP 49160–49260 | Ports the relay forwards sound and pictures through | Tier 2, with calls |
| TCP 7881, UDP 7882 | Sound and pictures in group calls | Tier 2, with calls |

Keep every other port closed.

**The domain** (tier 2): add an A record, for example `chat.example.com`, pointing at the server's public IP. Wait until it works (`ping chat.example.com` shows the server's address) before going on; otherwise no certificate can be issued.

## 3. Get the code and write the settings

```bash
git clone https://github.com/raymondwinterbourne/vibechat.git
cd vibechat/deploy
cp env.example .env
```

Open `.env` in an editor and fill in the "Required" part:

| Setting | Tier 1 (IP only) | Tier 2 (domain) |
| --- | --- | --- |
| `SITE` | `:80` | Your domain, e.g. `chat.example.com` |
| `PUBLIC_URL` | `http://` and the server's IP, e.g. `http://203.0.113.10` | `https://` and the domain, e.g. `https://chat.example.com` |
| `ADMIN_EMAIL` | The administrator's email address | Same |
| `ADMIN_INITIAL_PASSWORD` | The administrator's first password; it must be changed at the first login | Same |

`.env` holds passwords: don't commit it to git and don't send it to anyone.

## 4. Start

In the `deploy` folder:

```bash
docker compose up -d --build
```

The first time downloads and compiles a lot; expect ten minutes or more. Then check:

```bash
docker compose ps
docker compose logs app --tail 20
```

When the `app` and `web` containers are both `running` and the server's log says `listening on 0.0.0.0:3488`, it is up. Open the `PUBLIC_URL` address in a browser.

**First login**: the ID is `admin` and the password is `ADMIN_INITIAL_PASSWORD`. Change the password, then create invite codes under "Admin → Invite codes" and give them to the people who should join; they register with them.

In tier 2, Caddy fetches the certificate on the first visit, which can take a few seconds. If the page doesn't open, look at `docker compose logs web`.

## 5. Calls (tier 2, optional)

Calls need two services, both on this server: a relay for one-to-one calls (coturn) and a media server for group calls (LiveKit).

1. Make sure the firewall has the "with calls" ports from section 2 open.
2. Generate two secrets:

   ```bash
   openssl rand -hex 32
   openssl rand -hex 32
   ```

3. In the "Calls" part of `.env`, fill in:
   - `PUBLIC_IP`: the server's public IP address.
   - `PRIVATE_IP`: on some clouds the machine itself only has a private address and the public one is mapped in from outside (`ip addr` does not show the public IP). Then put the machine's private address here; otherwise leave it empty.
   - `TURN_SECRET`, `LIVEKIT_API_SECRET`: the two strings from the previous step, one each.
4. Start them (this also recreates the server so it learns where the call services are):

   ```bash
   docker compose --profile calls up -d --build
   ```

5. Check: after logging in, open `https://your-domain/call-check` and `https://your-domain/group-call-check` and follow the pages. When both pass, try a call with someone.

From now on, add `--profile calls` to every `docker compose` command, or these two services won't be started and updated with the rest.

**Bandwidth**: one-to-one calls that connect directly don't go through the server; relayed ones take a few hundred kbps to a few Mbps each. Group calls always go through the server: everyone receives everyone else. The administrator can set the picture bitrates and the group call size under "Admin → System settings"; the page works out what that costs the server in bandwidth.

## 6. Optional settings

**Mail**: an administrator who forgot the password recovers it by email, and changing the administrator's email is confirmed by email. Set `SMTP_URL` (e.g. `smtps://user:password@smtp.example.com:465`) and `MAIL_FROM` (the sender address) in `.env`. Without them, mail is written to the `mail` folder of the data volume:

```bash
docker compose exec app ls /data/mail
```

**PostgreSQL**: SQLite is the default and keeps everything in one file; that's fine for hundreds of people. To use PostgreSQL, set `POSTGRES_PASSWORD` in `.env`, uncomment the `DATABASE_URL` line with the same password, and add `--profile postgres` to every command. Data already stored in SQLite is not moved over.

**Desktop app (macOS)**: needs tier 2. When packaging, `VC_SERVER_URL=https://your-domain` sets which server the app connects to; see `client/apps/desktop/README.md`. Put the resulting `.dmg` into the `desktop` folder of the data volume and people can download it under "Settings → About":

```bash
docker compose exec app mkdir -p /data/desktop
docker compose cp VibeChat-0.1.0-arm64.dmg app:/data/desktop/
```

## 7. Day to day

**Updating**:

```bash
cd vibechat
git pull
cd deploy
docker compose up -d --build       # add the --profile options you use
```

The server upgrades the database structure by itself when it starts. Pages that are already open show "VibeChat has been updated. Click to reload".

If you change the code on your own computer and want one command that pushes it to the server and redeploys, use `scripts/deploy`: see the notes at its top, and write its settings after `scripts/deploy.conf.example`.

**Backups**: all data lives in Docker volumes, mainly `vibechat-deploy_data` (the database and uploaded files). The simplest way is to stop the server and archive that volume:

```bash
docker compose stop app
docker run --rm -v vibechat-deploy_data:/data -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/vibechat-data-$(date +%F).tar.gz -C /data .
docker compose start app
```

With PostgreSQL, also back up the database with `pg_dump`.

**Logs**:

```bash
docker compose logs app --tail 100      # the server
docker compose logs web --tail 100      # the entry point; certificate problems show here
```

## 8. When something is wrong

| What you see | Where to look |
| --- | --- |
| The page doesn't open | Is port 80 open (and 443 in tier 2)? Are both containers running in `docker compose ps`? |
| Tier 2 gets no certificate | Does the domain point at this server yet? Port 80 must be reachable from outside. `docker compose logs web` |
| The page opens, but after logging in it says it can't connect | The address in the browser must match `PUBLIC_URL` exactly (`http`/`https`, `www` or not, the port) |
| The server doesn't start | `docker compose logs app`: a bad setting is named in the log |
| Calls stay on "Connecting" | The `/call-check` and `/group-call-check` pages; the UDP ports in the firewall; whether your cloud needs `PRIVATE_IP` |
| Many people are told they're trying too often | If the entry point's address and `TRUSTED_PROXIES` in `compose.yaml` don't match, the server counts everyone as one address |

The internal Docker network uses `172.31.250.0/24`. If that clashes with a network already on the server, change the subnet at the bottom of `compose.yaml`, the `ipv4_address` of `web`, and `TRUSTED_PROXIES` of `app` — all three together.
