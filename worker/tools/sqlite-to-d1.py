#!/usr/bin/env python3
"""One-time copy of the old server's SQLite database (gw2lb) into SQL for the new D1 database.

    python3 tools/sqlite-to-d1.py leaderboard.db --skip TestFreund --befriend-all
    npx wrangler d1 execute gw2-leaderboard --remote --file import.sql

Players keep their ids, xuids and account keys (the stored hashes are the same SHA-256), so nobody has to sign up again
and every key a friend holds still works. Their scores come along.

--skip NAME       leave a player out (repeatable), e.g. test accounts
--befriend-all    make all imported players friends of each other, so a group that saw each other on the old
                  server's board keeps seeing each other on the Friends board
Run it once, into an empty database: the INSERTs fail on a second run instead of duplicating anything.
"""

import argparse
import itertools
import re
import sqlite3
import sys

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,14}$")
XUID_RE = re.compile(r"^[0-9A-F]{16}$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


def quote(value) -> str:
    if isinstance(value, int):
        return str(value)
    text = str(value)
    if any(ord(c) < 32 for c in text):
        raise ValueError(f"control character in {text!r}")
    return "'" + text.replace("'", "''") + "'"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("database", help="the old server's SQLite file (data/leaderboard.db)")
    parser.add_argument("-o", "--output", default="import.sql")
    parser.add_argument("--skip", action="append", default=[], metavar="NAME")
    parser.add_argument("--befriend-all", action="store_true")
    args = parser.parse_args(argv)

    skip = {name.lower() for name in args.skip}
    conn = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    players = [dict(r) for r in conn.execute("SELECT id, xuid, name, name_lc, token_hash, created_at FROM players ORDER BY id")]
    skipped = [p for p in players if p["name_lc"] in skip]
    players = [p for p in players if p["name_lc"] not in skip]
    missing = skip - {p["name_lc"] for p in skipped}
    if missing:
        print(f"Warning: no player named {', '.join(sorted(missing))}", file=sys.stderr)

    for p in players:
        if not (NAME_RE.match(p["name"]) and p["name"] == p["name"].rstrip()):
            raise SystemExit(f"Player {p['name']!r} has a name the new server would refuse")
        if not XUID_RE.match(p["xuid"]) or not HASH_RE.match(p["token_hash"]):
            raise SystemExit(f"Player {p['name']!r} has an unexpected xuid or key hash")
        if p["name_lc"] != p["name"].lower():
            raise SystemExit(f"Player {p['name']!r}: name_lc does not match")

    ids = {p["id"] for p in players}
    scores = [dict(r) for r in conn.execute("SELECT player_id, view, score, updated_at FROM scores ORDER BY player_id, view")]
    scores = [s for s in scores if s["player_id"] in ids]

    lines = []
    for p in players:
        lines.append(
            "INSERT INTO players (id, xuid, name, name_lc, token_hash, created_at) VALUES "
            f"({quote(p['id'])}, {quote(p['xuid'])}, {quote(p['name'])}, {quote(p['name_lc'])}, "
            f"{quote(p['token_hash'])}, {quote(p['created_at'])});"
        )
    for s in scores:
        lines.append(
            "INSERT INTO scores (player_id, view, score, updated_at) VALUES "
            f"({quote(s['player_id'])}, {quote(s['view'])}, {quote(s['score'])}, {quote(s['updated_at'])});"
        )
    friendships = 0
    if args.befriend_all:
        created = max((p["created_at"] for p in players), default=0)
        for a, b in itertools.combinations(sorted(ids), 2):
            lines.append(f"INSERT INTO friendships (a_id, b_id, created_at) VALUES ({a}, {b}, {created});")
            friendships += 1
    lines.append("UPDATE meta SET value = value + 1 WHERE key = 'revision';")

    with open(args.output, "w", encoding="utf-8", newline="\n") as out:
        out.write("\n".join(lines) + "\n")
    print(
        f"{len(players)} player(s), {len(scores)} score(s), {friendships} friendship(s) -> {args.output}"
        + (f" ({len(skipped)} skipped)" if skipped else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
