# GW2 leaderboard on Cloudflare (Worker + D1)

The global leaderboard for the [Geometry Wars: Retro Evolved 2 PC port fork](https://github.com/rauwman/geometry-wars-retro-evolved-2-recompiled).
A Cloudflare Worker with a D1 (SQLite) database keeps every player's best score per mode. It replaces the FastAPI
server in the parent folder and speaks the same `/v1` API, plus global boards and friends.

> **Vibe-coded.** Written with heavy AI assistance (Claude), directed and tested by hand by its maintainer. Scores come
> from players' own PCs, so a determined player can fake one: these boards are for fun, not a tournament.

## What it does

- **Open sign-up.** A free name is enough; no invite code. The player gets a private account key (shown once, only its
  SHA-256 is stored) that the launcher keeps. Sign-ups are limited per address and overall.
- **Global boards** per mode with the top rows, the player's own place and the rows around it.
- **Friends, only with consent.** A player is asked by name; the request counts only after the other player accepts. The game's Friends
  board then shows exactly the accepted friends and you. Declined requests are silent for the sender and block repeats.
- **Moderation:** a `hidden` flag (shadow ban: the player still sees themselves, nobody else does), deleting a score,
  renaming, replacing an account key, removing a player.
- **Delete my account** (`POST /v1/me/delete`): removes the player, scores, friendships and requests.

## API

All answers are JSON; errors are `{"detail": "..."}`. Everything but sign-up and the name check needs
`Authorization: Bearer <account key>`.

| Call | Purpose |
| --- | --- |
| `POST /v1/register` `{name}` | New account: `{xuid, name, token}` |
| `GET /v1/name-available?name=` | For the launcher's check while typing |
| `GET /v1/me`, `PUT /v1/me` `{name}` | Own name and xuid; rename |
| `POST /v1/me/delete` `{confirm:"DELETE"}` | Delete the account |
| `POST /v1/scores` `{scores:[{view,score}]}` | Upload bests (the server keeps the better value) |
| `GET /v1/boards?limit=` | Per mode: `total`, `rows`, `mine`, `around`, `friends`; plus the friend list. ETag / 304 |
| `GET /v1/friends` | Friends, open incoming and outgoing requests |
| `POST /v1/friends/request` `{to}` | Ask the player with that name. Answers `sent` or `friends` |
| `POST /v1/friends/accept`, `decline`, `cancel`, `remove` `{xuid}` | Answer, take back or end |
| `GET /`, `GET /healthz` | Read-only web page (`PUBLIC_BOARD=0` turns it off), health check |

`GET /v1/boards` keeps the shape of the first version (`revision`, `me`, `views.<mode>.total/rows`), so the game's
first version should keep working against this server (sign-up with any invite text, restore, rename, upload, boards);
it simply sees the global top rows as its "friends". This is checked against the first version's calls in the tests, not
against the real game.

## Deploy

Needs Node.js 22+ and a free Cloudflare account.

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create gw2-leaderboard            # put the database_id it prints into wrangler.toml
npx wrangler d1 execute gw2-leaderboard --remote --file schema.sql
npx wrangler secret put ADMIN_TOKEN               # a long random string; without it /admin answers 404
npx wrangler deploy
```

Test locally first with `npm test` (starts the Worker with a local D1 database and runs about 30 end-to-end checks) or
`npx wrangler dev`.

### Your own domain

Uncomment `routes` in `wrangler.toml` and set your hostname. Cloudflare creates the DNS record itself, so a record that
already points that hostname somewhere else (for example to the old server) must be deleted first. Plain
`*.workers.dev` also works. The Worker reads the client address from Cloudflare's `CF-Connecting-IP` header, so it must run
on Cloudflare (as it does in both cases), not behind another proxy.

Optional: add a Cloudflare rate-limiting rule for `/v1/name-available` (the launcher asks while the player types).

### Settings

| Variable (`[vars]` in `wrangler.toml`) | Meaning |
| --- | --- |
| `REGISTRATION` | `closed` stops new sign-ups. Default: open |
| `PUBLIC_BOARD` | `0` turns the web page at `/` off. Default: on |
| `ADMIN_TOKEN` (secret) | Enables `/admin` |

Limits (scores per mode, upload interval, friend list size, sign-up rates) are constants in `src/config.js`.

## Moving over from the old server

1. Copy `data/leaderboard.db` from the old container to your PC.
2. `python3 tools/sqlite-to-d1.py leaderboard.db --skip TestFreund --befriend-all` writes `import.sql`.
   Players keep their id, xuid and account key (the stored hash is the same), so friends sign in as before.
   `--befriend-all` makes the imported players friends of each other; leave it out to start with empty friend lists.
3. `npx wrangler d1 execute gw2-leaderboard --remote --file import.sql` (once, into the fresh database).
4. Switch the hostname to the Worker (see above), then stop the old container.

`import.sql` holds account-key hashes: keep it private and delete it afterwards.

## Backup

D1 data lives with Cloudflare and survives redeploys, but not a deleted database, an account problem or a bad `DELETE`.
D1's own point-in-time restore (Time Travel) covers only a short period on the free plan; check Cloudflare's current
documentation. `tools/backup.sh <folder>` writes a dated SQL dump and keeps the newest 30; run it from cron on the Docker
host or an LXC with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set. To restore, run the dump with
`wrangler d1 execute --remote --file` into a new, empty database (the dump contains the tables).

## Moderation

With `ADMIN_TOKEN` set, `Authorization: Bearer <ADMIN_TOKEN>` opens these calls. `player` is a name or an xuid.

```sh
H='authorization: Bearer YOUR_ADMIN_TOKEN'; U=https://gw2.example.org
curl -H "$H" "$U/admin/players?q=name"
curl -H "$H" -d '{"player":"Name"}' $U/admin/hide                  # hide; add "hidden": false to undo
curl -H "$H" -d '{"player":"Name","view":3}' $U/admin/delete-score
curl -H "$H" -d '{"player":"Name","name":"NewName"}' $U/admin/rename
curl -H "$H" -d '{"player":"Name"}' $U/admin/rotate-token          # for a player who lost their key
curl -H "$H" -d '{"player":"Name"}' $U/admin/remove
```

## What is stored

Per player: a random public id, the name, a hash of the account key, and the best score per mode with its
time. Friendships and open friend requests. No e-mail address, no password. Addresses are never stored: sign-up limits
use a truncated hash of the address that is deleted within a day. Players can delete everything with
`POST /v1/me/delete` (the game's launcher can call it once the client supports it).

## Limits of the free plan

Roughly, as of this writing (check Cloudflare's current limits): 100,000 Worker requests and 100,000 D1 rows written
per day, 5 million D1 rows read per day, 5 GB of storage, and a maximum of 50 D1 queries per request (every call here
stays far below that). A poll that finds nothing new costs two small reads, because the answer is cached per revision
inside the Worker. Reads grow with the number of players, since ranks are counted from the score index: this is fine for
many hundreds of players; for tens of thousands, cache the per-player part as well.

## Not affiliated

Unofficial fan project, no game files, not affiliated with or endorsed by the makers or publishers of Geometry Wars.
