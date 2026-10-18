import pytest
from fastapi.testclient import TestClient

from gw2lb import admin, db
from gw2lb import app as app_module
from gw2lb.app import app


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("GW2_DB", str(tmp_path / "t.db"))
    monkeypatch.delenv("GW2_INVITE_CODE", raising=False)
    app_module._hits.clear()
    return TestClient(app)


def make_player(name):
    with db.connect() as conn:
        xuid, token = db.add_player(conn, name)
    return xuid, {"Authorization": f"Bearer {token}"}


def test_auth_required(env):
    assert env.get("/v1/me").status_code == 401
    assert env.get("/v1/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert env.get("/v1/boards").status_code == 401


def test_me_and_rename(env):
    xuid, h = make_player("Yann")
    assert env.get("/v1/me", headers=h).json() == {"xuid": xuid, "name": "Yann"}
    assert env.put("/v1/me", json={"name": "Yann_R"}, headers=h).status_code == 200
    assert env.get("/v1/me", headers=h).json()["name"] == "Yann_R"


@pytest.mark.parametrize("bad", ["", " Yann", "Yann ", "x" * 16, "Ünal", "a/b", "ab\n"])
def test_rename_rejects_bad_names(env, bad):
    _, h = make_player("Yann")
    assert env.put("/v1/me", json={"name": bad}, headers=h).status_code == 422


def test_name_unique_case_insensitive(env):
    _, h1 = make_player("Yann")
    _, h2 = make_player("Max")
    assert env.put("/v1/me", json={"name": "yann"}, headers=h2).status_code == 409
    # keeping or re-casing one's own name is fine
    assert env.put("/v1/me", json={"name": "YANN"}, headers=h1).status_code == 200


def test_keeps_best_score_only(env):
    _, h = make_player("Yann")
    r = env.post("/v1/scores", json={"scores": [{"view": 1, "score": 1000}]}, headers=h).json()["results"][0]
    assert r == {"view": 1, "score": 1000, "rank": 1, "improved": True}
    r = env.post("/v1/scores", json={"scores": [{"view": 1, "score": 400}]}, headers=h).json()["results"][0]
    assert r == {"view": 1, "score": 1000, "rank": 1, "improved": False}
    r = env.post("/v1/scores", json={"scores": [{"view": 1, "score": 2000}]}, headers=h).json()["results"][0]
    assert r["score"] == 2000 and r["improved"]


def test_batch_with_repeated_mode_uses_the_best(env):
    _, h = make_player("Yann")
    body = {"scores": [{"view": 0, "score": 5}, {"view": 0, "score": 9}, {"view": 3, "score": 7}]}
    results = env.post("/v1/scores", json=body, headers=h).json()["results"]
    assert [(r["view"], r["score"]) for r in results] == [(0, 9), (3, 7)]


@pytest.mark.parametrize(
    "entry", [{"view": 6, "score": 1}, {"view": -1, "score": 1}, {"view": 0, "score": 0}, {"view": 0, "score": -5}]
)
def test_rejects_invalid_scores(env, entry):
    _, h = make_player("Yann")
    assert env.post("/v1/scores", json={"scores": [entry]}, headers=h).status_code == 422


def test_board_order_ranks_and_tie_break(env):
    xa, ha = make_player("Anna")
    xb, hb = make_player("Ben")
    xc, hc = make_player("Cleo")
    for h, s in ((ha, 500), (hb, 900), (hc, 500)):
        env.post("/v1/scores", json={"scores": [{"view": 2, "score": s}]}, headers=h)
    # Cleo reached 500 after Anna: Anna ranks above her
    data = env.get("/v1/boards", headers=ha).json()
    rows = data["views"]["2"]["rows"]
    assert [(r["rank"], r["name"], r["score"]) for r in rows] == [(1, "Ben", 900), (2, "Anna", 500), (3, "Cleo", 500)]
    assert data["views"]["2"]["total"] == 3
    assert data["views"]["0"] == {"total": 0, "rows": []}
    assert data["me"] == xa
    assert rows[0]["xuid"] == xb


def test_rank_returned_by_post_matches_board(env):
    _, ha = make_player("Anna")
    _, hb = make_player("Ben")
    env.post("/v1/scores", json={"scores": [{"view": 4, "score": 900}]}, headers=ha)
    r = env.post("/v1/scores", json={"scores": [{"view": 4, "score": 100}]}, headers=hb).json()["results"][0]
    assert r["rank"] == 2


def test_board_etag(env):
    _, h = make_player("Yann")
    first = env.get("/v1/boards", headers=h)
    etag = first.headers["etag"]
    assert env.get("/v1/boards", headers={**h, "If-None-Match": etag}).status_code == 304
    env.post("/v1/scores", json={"scores": [{"view": 0, "score": 10}]}, headers=h)
    assert env.get("/v1/boards", headers={**h, "If-None-Match": etag}).status_code == 200
    # a worse score changes nothing, so the cache stays valid
    new = env.get("/v1/boards", headers=h).headers["etag"]
    env.post("/v1/scores", json={"scores": [{"view": 0, "score": 1}]}, headers=h)
    assert env.get("/v1/boards", headers={**h, "If-None-Match": new}).status_code == 304


def test_rename_invalidates_cache(env):
    _, h = make_player("Yann")
    etag = env.get("/v1/boards", headers=h).headers["etag"]
    env.put("/v1/me", json={"name": "Other"}, headers=h)
    assert env.get("/v1/boards", headers={**h, "If-None-Match": etag}).status_code == 200


def test_public_page_escapes_names_and_can_be_disabled(env, monkeypatch):
    _, h = make_player("Yann")
    env.post("/v1/scores", json={"scores": [{"view": 1, "score": 12345}]}, headers=h)
    page = env.get("/").text
    assert "Evolved" in page and "12,345" in page and "Yann" in page
    monkeypatch.setenv("GW2_PUBLIC_BOARD", "0")
    assert env.get("/").status_code == 404


def test_admin_flow(env, capsys):
    assert admin.main(["add", "Yann"]) == 0
    token = capsys.readouterr().out.strip().splitlines()[-1]
    h = {"Authorization": f"Bearer {token}"}
    assert env.get("/v1/me", headers=h).status_code == 200
    env.post("/v1/scores", json={"scores": [{"view": 5, "score": 77}]}, headers=h)

    assert admin.main(["add", "yann"]) == 2  # name taken, case-insensitive
    assert admin.main(["rotate-token", "Yann"]) == 0
    new_token = capsys.readouterr().out.strip().splitlines()[-1]
    assert env.get("/v1/me", headers=h).status_code == 401  # old token is dead
    h2 = {"Authorization": f"Bearer {new_token}"}
    assert env.get("/v1/me", headers=h2).status_code == 200

    assert admin.main(["delete-score", "Yann", "5"]) == 0
    assert env.get("/v1/boards", headers=h2).json()["views"]["5"]["rows"] == []
    assert admin.main(["remove", "Yann"]) == 0
    assert env.get("/v1/me", headers=h2).status_code == 401


def register(env, name, invite="secret"):
    return env.post("/v1/register", json={"name": name, "invite": invite})


def test_registration_closed_without_invite_code(env):
    assert register(env, "Yann").status_code == 403
    assert register(env, "Yann", invite="").status_code == 403  # an empty code never matches an unset one


def test_register_gives_a_working_token(env, monkeypatch):
    monkeypatch.setenv("GW2_INVITE_CODE", "secret")
    r = register(env, "Yann")
    assert r.status_code == 201
    body = r.json()
    h = {"Authorization": f"Bearer {body['token']}"}
    assert env.get("/v1/me", headers=h).json() == {"xuid": body["xuid"], "name": "Yann"}
    assert env.post("/v1/scores", json={"scores": [{"view": 0, "score": 5}]}, headers=h).status_code == 200


def test_register_rejects_wrong_code_taken_and_bad_names(env, monkeypatch):
    monkeypatch.setenv("GW2_INVITE_CODE", "secret")
    assert register(env, "Yann", invite="wrong").status_code == 403
    assert register(env, "Yann").status_code == 201
    assert register(env, "yann").status_code == 409
    assert register(env, "Ünal").status_code == 422
    assert register(env, "").status_code == 422


def test_register_is_rate_limited_per_client(env, monkeypatch):
    monkeypatch.setenv("GW2_INVITE_CODE", "secret")
    codes = [register(env, "Yann", invite=f"guess{i}").status_code for i in range(10)]
    assert codes == [403] * 10
    blocked = register(env, "Yann")  # even the right code is refused once the limit is hit
    assert blocked.status_code == 429 and blocked.headers["retry-after"] == "3600"


def test_name_available_check_without_token(env):
    ok = env.get("/v1/name-available", params={"name": "Yann"}).json()
    assert ok == {"available": True, "reason": None}
    make_player("Yann")
    assert env.get("/v1/name-available", params={"name": "yann"}).json() == {"available": False, "reason": "taken"}
    bad = env.get("/v1/name-available", params={"name": "Ünal"}).json()
    assert bad["available"] is False and bad["reason"] == "invalid" and bad["message"]


def test_name_available_is_rate_limited(env):
    codes = [env.get("/v1/name-available", params={"name": f"n{i}"}).status_code for i in range(121)]
    assert codes[:120] == [200] * 120 and codes[120] == 429
