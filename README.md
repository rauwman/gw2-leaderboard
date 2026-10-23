# GW2 Leaderboard Server

> **Moving to Cloudflare.** The global version with friend codes lives in [`worker/`](worker/) (Cloudflare Worker + D1). This FastAPI server is the first, private version and stays here until the move is done.

A small private leaderboard server for the [Geometry Wars: Retro Evolved 2 PC port fork](https://github.com/rauwman/geometry-wars-retro-evolved-2-recompiled) (the friends leaderboard). FastAPI + SQLite in one Docker container. Friends sign up with an invite code from the game's launcher, their best scores are uploaded, and everyone appears on the game's own Overall / My score / Friends screens.

> **Vibe-coded.** This server was written with heavy AI assistance (Claude) and directed and tested by hand by its maintainer. It runs fine for a small group of friends, but it has had no independent security review. Use it for fun with people you know, not for anything that matters.

## Read this first

This repository is **not a hosting service and not a tutorial**. It assumes you already know how to:

- run a Docker container (Compose) and keep its data volume backed up,
- put it on the internet **safely** behind a reverse proxy that terminates HTTPS (Nginx Proxy Manager, NPMplus, Caddy, Traefik, a tunnel, ...) with your own domain,
- keep the host and the proxy patched.

If those words are new to you, this project is not the right place to learn them. Ask the person who runs your group's server instead.

## What you need to do, in short

1. Run the container (see below) with a long random `GW2_INVITE_CODE`.
2. Publish it **only via HTTPS**. Players send a private token with every request, which must never travel in plain HTTP. Do not expose port 8080 directly to the internet: the container trusts `X-Forwarded-For` from any address, so its per-address rate limits can be faked when it is reachable without your proxy.
3. Give your friends the HTTPS address and the invite code (or build them a friends ZIP of the game that has both filled in, see the game fork's `docs/online.md`).

## Run

```yaml
# compose.yaml
services:
  gw2-leaderboard:
    image: ghcr.io/rauwman/gw2-leaderboard:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./data:/data
    environment:
      GW2_INVITE_CODE: "${GW2_INVITE_CODE:?set GW2_INVITE_CODE in .env}"
      GW2_PUBLIC_BOARD: "1"
```

Copy `.env.example` to `.env`, set the invite code, then `docker compose up -d`. To build the image yourself instead of pulling it, use `build: .`.

The container listens on port 8080 and has a health check on `/healthz`.

### Settings

| Variable | Meaning |
| --- | --- |
| `GW2_INVITE_CODE` | Shared secret for sign-up. Without it, sign-up is closed. Anyone who knows it can create players. |
| `GW2_PUBLIC_BOARD` | `1` (default) shows a read-only web page at `/`; `0` turns it off. |
| `GW2_DB` | Database path inside the container, default `/data/leaderboard.db`. |

### Data

Everything is one SQLite file in `/data`. Back up that folder. One worker process is intentional.

## Admin

Run inside the container:

```sh
docker compose exec gw2-leaderboard python -m gw2lb.admin list
docker compose exec gw2-leaderboard python -m gw2lb.admin add <name>            # prints a token, shown once
docker compose exec gw2-leaderboard python -m gw2lb.admin rotate-token <name>    # new token, old one stops working
docker compose exec gw2-leaderboard python -m gw2lb.admin remove <name>          # deletes the player and all scores
docker compose exec gw2-leaderboard python -m gw2lb.admin delete-score <name> <mode id>
```

A player's token is their account key. Players can copy it in the game's launcher; after a reinstall they paste it back to get their name and scores again.

## API (used by the game)

`GET /healthz`, `GET /v1/name-available`, `POST /v1/register`, `GET`/`PUT /v1/me`, `POST /v1/scores`, `GET /v1/boards`, and `GET /` for the optional web page. Authenticated calls use `Authorization: Bearer <token>`.

## Development

```sh
python -m venv .venv && .venv/bin/pip install -r requirements.txt pytest httpx
.venv/bin/python -m pytest -q
GW2_INVITE_CODE=dev .venv/bin/uvicorn gw2lb.app:app --port 8080
```

A GitHub Action runs the tests and publishes the image to `ghcr.io` on pushes to `main`.

## Not affiliated

Unofficial fan project. It contains no game files and is not affiliated with or endorsed by the makers or publishers of Geometry Wars.

## License

MIT, see [LICENSE](LICENSE).
