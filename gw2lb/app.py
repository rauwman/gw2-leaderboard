"""HTTP API and a small public leaderboard page.

Players authenticate with a bearer token (one per friend, created with `python -m gw2lb.admin add`).
Scores come from the game client, so anyone with a token can submit any score: this is built for
friends, not for strangers.
"""

import collections
import hmac
import html
import os
import threading
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from . import db

app = FastAPI(title="GW2 Leaderboard", docs_url=None, redoc_url=None, openapi_url=None)

MAX_BOARD_ROWS = 100


def current_player(authorization: str | None = Header(default=None)):
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Bearer token required", headers={"WWW-Authenticate": "Bearer"})
    with db.connect() as conn:
        player = db.player_by_token(conn, token.strip())
    if player is None:
        raise HTTPException(401, "Unknown token", headers={"WWW-Authenticate": "Bearer"})
    return dict(player)


class Rename(BaseModel):
    name: str = Field(max_length=64)


class ScoreEntry(BaseModel):
    view: int = Field(ge=0, le=max(db.MODES))
    score: int = Field(ge=1, le=db.MAX_SCORE)


class ScoreBatch(BaseModel):
    # A client that was offline sends everything it has in one go.
    scores: list[ScoreEntry] = Field(min_length=1, max_length=len(db.MODES))


class Register(BaseModel):
    name: str = Field(max_length=64)
    invite: str = Field(max_length=128)


# Every attempt counts, wrong invite codes included, so the code cannot be guessed by brute force.
REGISTER_ATTEMPTS = 10
REGISTER_WINDOW = 3600
# The launcher asks while the player types, so this one is generous.
CHECK_ATTEMPTS = 120
CHECK_WINDOW = 60
_limit_lock = threading.Lock()
_hits: dict[tuple[str, str], list[float]] = collections.defaultdict(list)


def _allowed(bucket: str, client: str, attempts: int, window: int) -> bool:
    now = time.monotonic()
    with _limit_lock:
        hits = [t for t in _hits[(bucket, client)] if now - t < window]
        allowed = len(hits) < attempts
        if allowed:
            hits.append(now)
        _hits[(bucket, client)] = hits
        return allowed


def _client(request: Request) -> str:
    return request.client.host if request.client else "?"


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/v1/name-available")
def name_available(name: str, request: Request):
    """For the launcher's live check while the player types. Needs no token: names are public on the board anyway."""
    if not _allowed("check", _client(request), CHECK_ATTEMPTS, CHECK_WINDOW):
        raise HTTPException(429, "Too many requests", headers={"Retry-After": "60"})
    try:
        db.check_name(name)
    except db.NameError_ as exc:
        return {"available": False, "reason": "invalid", "message": str(exc)}
    with db.connect() as conn:
        taken = db.name_taken(conn, name)
    return {"available": not taken, "reason": "taken" if taken else None}


@app.post("/v1/register", status_code=201)
def register(body: Register, request: Request):
    """Self-service sign-up from the game's launcher: the right invite code plus a free name gives a token.

    The invite code is the shared secret of the friend group (GW2_INVITE_CODE). Without it set, sign-up is closed.
    """
    code = os.environ.get("GW2_INVITE_CODE", "")
    if not code:
        raise HTTPException(403, "Registration is closed")
    if not _allowed("register", _client(request), REGISTER_ATTEMPTS, REGISTER_WINDOW):
        raise HTTPException(429, "Too many attempts, try again later", headers={"Retry-After": "3600"})
    if not hmac.compare_digest(body.invite.encode(), code.encode()):
        raise HTTPException(403, "Wrong invite code")
    try:
        with db.connect() as conn:
            xuid, token = db.add_player(conn, body.name)
    except db.NameError_ as exc:
        raise HTTPException(422, str(exc))
    except db.NameTaken:
        raise HTTPException(409, "That name is already taken")
    return {"xuid": xuid, "name": body.name, "token": token}


@app.get("/v1/me")
def me(player=Depends(current_player)):
    return {"xuid": player["xuid"], "name": player["name"]}


@app.put("/v1/me")
def set_name(body: Rename, player=Depends(current_player)):
    try:
        with db.connect() as conn:
            db.rename(conn, player["id"], body.name)
    except db.NameError_ as exc:
        raise HTTPException(422, str(exc))
    except db.NameTaken:
        raise HTTPException(409, "That name is already taken")
    return {"xuid": player["xuid"], "name": body.name}


@app.post("/v1/scores")
def post_scores(body: ScoreBatch, player=Depends(current_player)):
    seen: dict[int, int] = {}
    for entry in body.scores:  # a batch may repeat a mode; only its best counts
        seen[entry.view] = max(entry.score, seen.get(entry.view, 0))
    with db.connect() as conn:
        results = [db.submit_score(conn, player["id"], view, score) for view, score in sorted(seen.items())]
        revision = db.revision(conn)
    return {"revision": revision, "results": results}


@app.get("/v1/boards")
def boards(
    request: Request,
    response: Response,
    limit: int = MAX_BOARD_ROWS,
    player=Depends(current_player),
    if_none_match: str | None = Header(default=None),
):
    """Every mode's top rows in one answer, so a client can refresh its cache with a single request."""
    limit = max(1, min(limit, MAX_BOARD_ROWS))
    with db.connect() as conn:
        revision = db.revision(conn)
        etag = f'"{revision}-{limit}"'
        if if_none_match == etag:
            return Response(status_code=304, headers={"ETag": etag})
        views = {str(v): db.board(conn, v, limit) for v in db.MODES}
    response.headers["ETag"] = etag
    return {"revision": revision, "me": player["xuid"], "views": views}


@app.get("/", response_class=HTMLResponse)
def page():
    """A read-only page for browsers. Set GW2_PUBLIC_BOARD=0 to turn it off."""
    if os.environ.get("GW2_PUBLIC_BOARD", "1") == "0":
        raise HTTPException(404)
    sections = []
    with db.connect() as conn:
        for view, mode in db.MODES.items():
            data = db.board(conn, view, 20)
            if data["rows"]:
                rows = "".join(
                    f"<tr><td>{r['rank']}</td><td>{html.escape(r['name'])}</td><td class=n>{r['score']:,}</td></tr>"
                    for r in data["rows"]
                )
            else:
                rows = "<tr><td colspan=3>No scores yet</td></tr>"
            sections.append(f"<section><h2>{mode}</h2><table>{rows}</table></section>")
    return (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>GW2 Leaderboard</title><style>"
        ":root{color-scheme:light dark}body{font:16px system-ui;margin:0 auto;max-width:720px;padding:16px}"
        "section{margin:0 0 24px}table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid #8884}"
        ".n{text-align:right;font-variant-numeric:tabular-nums}h2{margin:16px 0 4px}"
        "</style><h1>Geometry Wars: Retro Evolved 2</h1>" + "".join(sections)
    )
