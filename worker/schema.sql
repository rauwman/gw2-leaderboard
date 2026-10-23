-- GW2 leaderboard (Cloudflare D1). Column names match the old SQLite server, so tools/sqlite-to-d1.py can copy rows
-- one to one. Apply with: npx wrangler d1 execute gw2-leaderboard --remote --file schema.sql

CREATE TABLE IF NOT EXISTS players (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    xuid        TEXT NOT NULL UNIQUE,        -- public id, 16 hex digits, what the game sees
    name        TEXT NOT NULL,
    name_lc     TEXT NOT NULL UNIQUE,
    token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 (hex) of the private account key
    friend_code TEXT UNIQUE,                 -- created on first use; NULL until then
    hidden      INTEGER NOT NULL DEFAULT 0,  -- 1: left out of every board but their own (moderation)
    created_at  INTEGER NOT NULL,
    last_submit INTEGER NOT NULL DEFAULT 0
);

-- Best score per player and mode (the game's view ids: 0 Deadline, 1 Evolved, 2 Sequence, 3 Waves, 4 Pacifism, 5 King).
CREATE TABLE IF NOT EXISTS scores (
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    view       INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, view)
);
CREATE INDEX IF NOT EXISTS scores_by_view ON scores (view, score DESC, updated_at ASC);

-- A friendship exists only after both sides agreed: a request, accepted by the other player.
CREATE TABLE IF NOT EXISTS friend_requests (
    from_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'declined')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_id);

CREATE TABLE IF NOT EXISTS friendships (
    a_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    b_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (a_id, b_id),
    CHECK (a_id < b_id)                      -- one row per pair, smaller id first
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (b_id);

-- Fixed-window counters for sign-ups and friend requests. `key` is a truncated hash, never an address; rows are
-- deleted by the daily housekeeping.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL,
    key    TEXT NOT NULL,
    window INTEGER NOT NULL,
    count  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,             -- end of the window
    PRIMARY KEY (bucket, key, window)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('revision', 1);
