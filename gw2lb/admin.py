"""Manage players: python -m gw2lb.admin <command>."""

import argparse
import sys

from . import db


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gw2lb.admin", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="show all players")
    p = sub.add_parser("add", help="create a player and print the token (shown once)")
    p.add_argument("name")
    p = sub.add_parser("rotate-token", help="issue a new token, the old one stops working")
    p.add_argument("name")
    p = sub.add_parser("remove", help="delete a player and all their scores")
    p.add_argument("name")
    p = sub.add_parser("delete-score", help="remove one score, e.g. a cheated one")
    p.add_argument("name")
    p.add_argument("view", type=int, choices=sorted(db.MODES), help="mode id")
    args = parser.parse_args(argv)

    with db.connect() as conn:
        if args.cmd == "list":
            for r in conn.execute("SELECT id, xuid, name FROM players ORDER BY id"):
                best = conn.execute("SELECT COUNT(*) FROM scores WHERE player_id = ?", (r["id"],)).fetchone()[0]
                print(f"{r['xuid']}  {r['name']:<16} {best} score(s)")
            return 0

        if args.cmd == "add":
            try:
                xuid, token = db.add_player(conn, args.name)
            except db.NameError_ as exc:
                print(f"Invalid name: {exc}", file=sys.stderr)
                return 2
            except db.NameTaken:
                print("That name is taken.", file=sys.stderr)
                return 2
            print(f"Player {args.name} ({xuid})\nToken (give it to the player, it is not shown again):\n{token}")
            return 0

        row = conn.execute("SELECT id FROM players WHERE name_lc = ?", (args.name.lower(),)).fetchone()
        if row is None:
            print("No such player.", file=sys.stderr)
            return 1
        if args.cmd == "rotate-token":
            import secrets

            token = secrets.token_urlsafe(24)
            conn.execute("UPDATE players SET token_hash = ? WHERE id = ?", (db.hash_token(token), row["id"]))
            print(f"New token for {args.name}:\n{token}")
        elif args.cmd == "remove":
            conn.execute("DELETE FROM players WHERE id = ?", (row["id"],))
            db.bump_revision(conn)
            print(f"Removed {args.name}.")
        elif args.cmd == "delete-score":
            cur = conn.execute("DELETE FROM scores WHERE player_id = ? AND view = ?", (row["id"], args.view))
            if cur.rowcount:
                db.bump_revision(conn)
            print(f"Deleted {cur.rowcount} score(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
