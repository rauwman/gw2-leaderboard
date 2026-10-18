"""SQLite storage: players, best score per player and mode, and a global revision counter."""

import hashlib
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager

# The game's own leaderboard views (see docs/offline-live.md in the port).
MODES = {0: "Deadline", 1: "Evolved", 2: "Sequence", 3: "Waves", 4: "Pacifism", 5: "King"}

# The game's gamertag buffer is 16 bytes including the terminator. ASCII only: the game's font is
# not known to cover more.
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,14}$")

MAX_SCORE = 2**62

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    xuid       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    name_lc    TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    view       INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, view)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', 1);
"""


class NameError_(ValueError):
    """The name breaks the rules (format)."""


class NameTaken(ValueError):
    """Another player already has this name."""


def db_path() -> str:
    return os.environ.get("GW2_DB", "data/leaderboard.db")


@contextmanager
def connect(path: str | None = None):
    path = path or db_path()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_name(name: str) -> str:
    if not NAME_RE.match(name) or name != name.rstrip():
        raise NameError_("1-15 characters: letters, digits, space, _ . -; must start with a letter or digit")
    return name


def bump_revision(conn: sqlite3.Connection) -> int:
    conn.execute("UPDATE meta SET value = value + 1 WHERE key = 'revision'")
    return revision(conn)


def revision(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT value FROM meta WHERE key = 'revision'").fetchone()[0]


def name_taken(conn: sqlite3.Connection, name: str, except_player: int | None = None) -> bool:
    row = conn.execute("SELECT id FROM players WHERE name_lc = ?", (name.lower(),)).fetchone()
    return row is not None and row["id"] != except_player


def add_player(conn: sqlite3.Connection, name: str) -> tuple[str, str]:
    """Creates a player. Returns (xuid, token); the token is shown once and only its hash is kept."""
    check_name(name)
    token = secrets.token_urlsafe(24)
    # Real XUIDs of retail accounts start with 0009 or E000; E000 + 12 random hex digits looks the same to the game.
    xuid = "E000" + secrets.token_hex(6).upper()
    try:
        conn.execute(
            "INSERT INTO players (xuid, name, name_lc, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (xuid, name, name.lower(), hash_token(token), int(time.time())),
        )
    except sqlite3.IntegrityError as exc:
        raise NameTaken(name) from exc
    bump_revision(conn)
    return xuid, token


def player_by_token(conn: sqlite3.Connection, token: str):
    return conn.execute("SELECT * FROM players WHERE token_hash = ?", (hash_token(token),)).fetchone()


def rename(conn: sqlite3.Connection, player_id: int, name: str) -> None:
    check_name(name)
    try:
        cur = conn.execute("UPDATE players SET name = ?, name_lc = ? WHERE id = ?", (name, name.lower(), player_id))
    except sqlite3.IntegrityError as exc:
        raise NameTaken(name) from exc
    if cur.rowcount:
        bump_revision(conn)


def submit_score(conn: sqlite3.Connection, player_id: int, view: int, score: int) -> dict:
    """Keeps the better of the stored and the submitted score. Returns the best and whether it improved."""
    row = conn.execute("SELECT score FROM scores WHERE player_id = ? AND view = ?", (player_id, view)).fetchone()
    improved = row is None or score > row["score"]
    if improved:
        conn.execute(
            "INSERT INTO scores (player_id, view, score, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (player_id, view) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at",
            (player_id, view, score, int(time.time())),
        )
        bump_revision(conn)
    best = score if improved else row["score"]
    rank = conn.execute(
        "SELECT COUNT(*) + 1 FROM scores s WHERE s.view = ? AND (s.score > ? OR "
        "(s.score = ? AND s.updated_at < (SELECT updated_at FROM scores WHERE player_id = ? AND view = ?)))",
        (view, best, best, player_id, view),
    ).fetchone()[0]
    return {"view": view, "score": best, "rank": rank, "improved": improved}


def board(conn: sqlite3.Connection, view: int, limit: int) -> dict:
    """Best score per player, highest first; an earlier score wins a tie."""
    total = conn.execute("SELECT COUNT(*) FROM scores WHERE view = ?", (view,)).fetchone()[0]
    rows = conn.execute(
        "SELECT p.xuid, p.name, s.score FROM scores s JOIN players p ON p.id = s.player_id "
        "WHERE s.view = ? ORDER BY s.score DESC, s.updated_at ASC, p.id ASC LIMIT ?",
        (view, limit),
    ).fetchall()
    return {
        "total": total,
        "rows": [
            {"rank": i + 1, "xuid": r["xuid"], "name": r["name"], "score": r["score"]} for i, r in enumerate(rows)
        ],
    }
