// End-to-end tests: starts the Worker with `wrangler dev --local` (a real local D1 database), applies schema.sql and
// talks to it over HTTP. Run with `npm test`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const ADMIN = "test-admin-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const servers = [];
const dirs = [];

async function startServer(port, vars = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gw2lb-"));
  dirs.push(dir);
  const common = ["--local", "--persist-to", dir];
  const schema = spawnSync(process.execPath, [wrangler, "d1", "execute", "gw2-leaderboard", ...common, "--file", "schema.sql"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(schema.status, 0, `schema failed: ${schema.stdout}${schema.stderr}`);
  const args = [wrangler, "dev", ...common, "--port", String(port), "--inspector-port", String(port + 1000)];
  for (const [key, value] of Object.entries({ ADMIN_TOKEN: ADMIN, SUBMIT_INTERVAL_SECONDS: "1", ...vars })) {
    args.push("--var", `${key}:${value}`);
  }
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, dir, log: () => log };
    } catch {}
    await sleep(500);
  }
  throw new Error(`Worker did not start:\n${log}`);
}

before(async () => {
  assert.ok(existsSync(wrangler), "run `npm install` first");
});
// On Windows, killing wrangler leaves its workerd child running and holding the database files, so the whole process
// tree is stopped. Cleaning up must never fail a test run: a leftover temporary folder is only reported.
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill();
}

after(async () => {
  for (const child of servers) stop(child);
  await sleep(1500);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`Could not remove ${dir} (${error.code}); it can be deleted by hand.`);
    }
  }
});

let ipCounter = 0;
function client(base) {
  const call = async (method, path, { token, body, ip, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        "cf-connecting-ip": ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers };
  };
  let names = 0;
  const unique = (prefix) => `${prefix}${Date.now().toString(36).slice(-4)}${++names}`.slice(0, 15);
  const signUp = async (prefix = "P") => {
    const name = unique(prefix);
    const r = await call("POST", "/v1/register", { body: { name } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { name, token: r.data.token, xuid: r.data.xuid };
  };
  const upload = (player, scores) => call("POST", "/v1/scores", { token: player.token, body: { scores } });
  const boards = (player, query = "") => call("GET", `/v1/boards${query}`, { token: player.token });
  const admin = (method, path, body) => call(method, path, { token: ADMIN, body });
  return { call, signUp, upload, boards, admin };
}

describe("worker", async () => {
  const { base } = await startServer(8791);
  const { call, signUp, upload, boards, admin } = client(base);

  describe("accounts", () => {
    test("health and unknown routes", async () => {
      assert.deepEqual((await call("GET", "/healthz")).data, { ok: true });
      const r = await call("GET", "/nope");
      assert.equal(r.status, 404);
      assert.equal(typeof r.data.detail, "string");
    });

    test("sign-up gives a key once, and the game's first version's invite code is ignored", async () => {
      const r = await call("POST", "/v1/register", { body: { name: "Alice1", invite: "whatever" } });
      assert.equal(r.status, 201);
      assert.match(r.data.xuid, /^E000[0-9A-F]{12}$/);
      assert.equal(r.data.name, "Alice1");
      assert.ok(r.data.token.length >= 30);
      const me = await call("GET", "/v1/me", { token: r.data.token });
      assert.equal(me.status, 200);
      assert.equal(me.data.xuid, r.data.xuid);
      assert.equal(me.data.friend_code, undefined, "there are no friend codes: friends are asked by name");
      assert.ok(!JSON.stringify(me.data).includes(r.data.token), "the key is never echoed");
    });

    test("names: unique ignoring case, format enforced", async () => {
      assert.equal((await call("POST", "/v1/register", { body: { name: "alice1" } })).status, 409);
      for (const bad of ["", " Bob", "Bob ", "x".repeat(16), "Ünal", "a/b", "a\nb", "-dash", 5, null])
        assert.equal((await call("POST", "/v1/register", { body: { name: bad } })).status, 422, JSON.stringify(bad));
      assert.equal((await call("POST", "/v1/register", { body: {} })).status, 422);
    });

    test("name-available", async () => {
      assert.deepEqual((await call("GET", "/v1/name-available?name=Alice1")).data, { available: false, reason: "taken" });
      assert.deepEqual((await call("GET", "/v1/name-available?name=Freeone")).data, { available: true, reason: null });
      const bad = (await call("GET", "/v1/name-available?name=%20x")).data;
      assert.equal(bad.available, false);
      assert.equal(bad.reason, "invalid");
    });

    test("bad bodies are refused", async () => {
      assert.equal((await call("POST", "/v1/register", { headers: { "content-type": "application/json" } })).status, 400);
      const huge = await fetch(base + "/v1/register", { method: "POST", body: "x".repeat(5000) });
      assert.equal(huge.status, 413);
    });

    test("sign-up is limited per address", async () => {
      const ip = "203.0.113.9";
      for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/v1/register", { ip, body: { name: `Lim${i}` } })).status, 201);
      const r = await call("POST", "/v1/register", { ip, body: { name: "Lim9" } });
      assert.equal(r.status, 429);
      assert.ok(r.headers.get("retry-after"));
      assert.equal((await call("POST", "/v1/register", { ip: "203.0.113.10", body: { name: "Lim9" } })).status, 201);
    });

    test("authentication", async () => {
      for (const [method, path] of [["GET", "/v1/me"], ["GET", "/v1/boards"], ["POST", "/v1/scores"], ["GET", "/v1/friends"]]) {
        assert.equal((await call(method, path)).status, 401, path);
        assert.equal((await call(method, path, { token: "nope" })).status, 401, path);
      }
    });

    test("rename: own name may change case, taken names refused, other names unaffected", async () => {
      const a = await signUp("Ren");
      const b = await signUp("Ren");
      assert.equal((await call("PUT", "/v1/me", { token: a.token, body: { name: b.name.toLowerCase() } })).status, 409);
      assert.equal((await call("PUT", "/v1/me", { token: a.token, body: { name: a.name.toUpperCase() } })).status, 200);
      assert.equal((await call("PUT", "/v1/me", { token: a.token, body: { name: " bad" } })).status, 422);
      const fresh = `${a.name}x`.slice(0, 15);
      assert.equal((await call("PUT", "/v1/me", { token: a.token, body: { name: fresh } })).status, 200);
      assert.equal((await call("GET", "/v1/me", { token: a.token })).data.name, fresh);
    });
  });

  describe("scores and boards", () => {
    test("keeps the best score and ranks players", async () => {
      const a = await signUp("Sc");
      const b = await signUp("Sc");
      let r = await upload(a, [{ view: 3, score: 1000 }]);
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.results, [{ view: 3, score: 1000, rank: 1, improved: true }]);
      r = await upload(b, [{ view: 3, score: 5000 }]);
      assert.equal(r.data.results[0].rank, 1);
      await sleep(1100);
      r = await upload(a, [{ view: 3, score: 400 }]);
      assert.deepEqual(r.data.results, [{ view: 3, score: 1000, rank: 2, improved: false }]);
      await sleep(1100);
      r = await upload(a, [{ view: 3, score: 9000 }]);
      assert.deepEqual(r.data.results, [{ view: 3, score: 9000, rank: 1, improved: true }]);
    });

    test("a batch may hold several modes and repeat one", async () => {
      const a = await signUp("Bat");
      const r = await upload(a, [{ view: 0, score: 10 }, { view: 0, score: 30 }, { view: 5, score: 7 }]);
      assert.deepEqual(r.data.results.map((x) => [x.view, x.score]), [[0, 30], [5, 7]]);
    });

    test("invalid uploads are refused", async () => {
      const a = await signUp("Bad");
      for (const scores of [[], [{ view: 6, score: 5 }], [{ view: -1, score: 5 }], [{ view: 1, score: 0 }], [{ view: 1, score: 1.5 }],
        [{ view: 1, score: 10 ** 12 }], [{ view: "1", score: 5 }], [null], "x"]) {
        assert.equal((await upload(a, scores)).status, 422, JSON.stringify(scores));
        await sleep(0);
      }
    });

    test("uploads come at most once per interval", async () => {
      const a = await signUp("Int");
      assert.equal((await upload(a, [{ view: 1, score: 5 }])).status, 200);
      const r = await upload(a, [{ view: 1, score: 6 }]);
      assert.equal(r.status, 429);
      assert.ok(r.headers.get("retry-after"));
      await sleep(1100);
      assert.equal((await upload(a, [{ view: 1, score: 6 }])).status, 200);
    });

    test("earlier score wins a tie", async () => {
      const a = await signUp("Tie");
      const b = await signUp("Tie");
      await upload(a, [{ view: 2, score: 777 }]);
      await sleep(1100);
      const r = await upload(b, [{ view: 2, score: 777 }]);
      const rankOfA = (await boards(a)).data.views["2"].mine.rank;
      assert.equal(r.data.results[0].rank, rankOfA + 1, "b is directly behind a");
      const top = (await boards(a, "?limit=100")).data.views["2"].rows.filter((row) => [a.name, b.name].includes(row.name));
      assert.deepEqual(top.map((row) => row.name), [a.name, b.name]);
    });

    test("boards: top rows, totals, own place, ETag", async () => {
      const players = [];
      for (let i = 0; i < 4; i++) players.push(await signUp("Bd"));
      // Mode 4 has not been used by earlier tests.
      for (const [i, p] of players.entries()) await upload(p, [{ view: 4, score: (i + 1) * 100 }]);
      const r = await boards(players[0], "?limit=2");
      assert.equal(r.status, 200);
      const view = r.data.views["4"];
      assert.equal(r.data.me, players[0].xuid);
      assert.equal(view.total, 4);
      assert.deepEqual(view.rows.map((x) => [x.rank, x.name, x.score]), [[1, players[3].name, 400], [2, players[2].name, 300]]);
      assert.deepEqual(view.mine, { rank: 4, score: 100 });
      assert.deepEqual(view.around.map((x) => x.rank), [1, 2, 3, 4]);
      assert.equal(view.around.at(-1).name, players[0].name);
      assert.deepEqual(r.data.views["0"].mine === null || typeof r.data.views["0"].mine === "object", true);
      assert.equal(Object.keys(r.data.views).length, 6);
      // Inside the top rows there is nothing extra to send.
      assert.deepEqual((await boards(players[3], "?limit=2")).data.views["4"].around, []);

      const etag = r.headers.get("etag");
      assert.ok(etag);
      const again = await call("GET", "/v1/boards?limit=2", { token: players[0].token, headers: { "if-none-match": etag } });
      assert.equal(again.status, 304);
      await sleep(1100);
      await upload(players[0], [{ view: 4, score: 5000 }]);
      const changed = await call("GET", "/v1/boards?limit=2", { token: players[0].token, headers: { "if-none-match": etag } });
      assert.equal(changed.status, 200);
      assert.equal(changed.data.views["4"].rows[0].name, players[0].name);
    });

    test("boards answer in the shape the game's first version reads", async () => {
      const a = await signUp("Old");
      await upload(a, [{ view: 1, score: 42 }]);
      const { data } = await boards(a);
      assert.equal(typeof data.revision, "number");
      assert.equal(typeof data.me, "string");
      for (const view of Object.values(data.views)) {
        assert.equal(typeof view.total, "number");
        for (const row of view.rows) {
          assert.equal(typeof row.xuid, "string");
          assert.equal(typeof row.name, "string");
          assert.ok(row.score > 0);
        }
      }
    });
  });

  describe("friends", () => {
        const overview = async (p) => (await call("GET", "/v1/friends", { token: p.token })).data;
    const names = (list) => list.map((x) => x.name).sort();

    test("request, accept, and the Friends board", async () => {
      const a = await signUp("Fa");
      const b = await signUp("Fb");
      const c = await signUp("Fc");
      await upload(a, [{ view: 2, score: 300 }]);
      await upload(b, [{ view: 2, score: 500 }]);
      await upload(c, [{ view: 2, score: 900 }]);

      const sent = await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      assert.equal(sent.status, 201);
      assert.deepEqual(sent.data, { status: "sent", xuid: b.xuid, name: b.name });
      assert.deepEqual(names((await overview(a)).outgoing), [b.name]);
      assert.deepEqual(names((await overview(b)).incoming), [a.name]);
      // Until b agrees, nobody is anyone's friend.
      assert.deepEqual((await boards(a)).data.friends, []);
      assert.deepEqual((await boards(b)).data.views["2"].friends.map((x) => x.name), [b.name]);

      const accepted = await call("POST", "/v1/friends/accept", { token: b.token, body: { xuid: a.xuid } });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.data.status, "friends");
      assert.deepEqual((await overview(b)).incoming, []);
      assert.deepEqual(names((await overview(a)).friends), [b.name]);
      assert.deepEqual(names((await overview(b)).friends), [a.name]);

      const forA = await boards(a);
      assert.deepEqual(forA.data.friends, [{ xuid: b.xuid, name: b.name }]);
      assert.deepEqual(forA.data.views["2"].friends.map((x) => [x.rank, x.name, x.score]), [[1, b.name, 500], [2, a.name, 300]]);
      assert.ok(!forA.data.views["2"].friends.some((x) => x.name === c.name), "strangers are not on the Friends board");
      assert.equal(forA.data.views["2"].rows[0].name, c.name, "the global board still shows everyone");

      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } })).data.status, "friends");
    });

    test("a request by name: any case, spaces around it", async () => {
      const a = await signUp("Fn");
      const b = await signUp("Fn");
      const sent = await call("POST", "/v1/friends/request", { token: a.token, body: { to: `  ${b.name.toLowerCase()} ` } });
      assert.equal(sent.status, 201);
      assert.deepEqual([sent.data.status, sent.data.xuid, sent.data.name], ["sent", b.xuid, b.name]);
      assert.deepEqual(names((await overview(b)).incoming), [a.name]);
      assert.deepEqual((await overview(a)).friends, [], "still nobody's friend until the other side accepts");
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } })).status, 200, "asking twice adds nothing");
      const back = await call("POST", "/v1/friends/request", { token: b.token, body: { to: a.name } });
      assert.equal(back.data.status, "friends");
      assert.deepEqual(names((await overview(a)).friends), [b.name]);
    });

    test("a request from both sides settles by itself", async () => {
      const a = await signUp("Fd");
      const b = await signUp("Fd");
      await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      const r = await call("POST", "/v1/friends/request", { token: b.token, body: { to: a.name } });
      assert.equal(r.data.status, "friends");
      assert.deepEqual(names((await overview(a)).friends), [b.name]);
    });

    test("declining is silent for the sender and blocks repeats", async () => {
      const a = await signUp("Fe");
      const b = await signUp("Fe");
      await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      assert.equal((await call("POST", "/v1/friends/decline", { token: b.token, body: { xuid: a.xuid } })).status, 200);
      assert.deepEqual((await overview(b)).incoming, []);
      const again = await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      assert.equal(again.data.status, "sent", "the sender cannot tell");
      assert.deepEqual((await overview(b)).incoming, []);
      assert.deepEqual((await overview(a)).outgoing, [], "a declined request is no longer shown as open");
    });

    test("cancel, remove, and mistakes", async () => {
      const a = await signUp("Ff");
      const b = await signUp("Ff");
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: a.name } })).status, 422);
      // By name: any case, spaces around it are fine; unknown names and the own name are refused.
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: "NoSuchPlayerHere" } })).status, 404);
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: a.name.toUpperCase() } })).status, 422);
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: "   " } })).status, 422);
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: {} })).status, 422);
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: "x".repeat(41) } })).status, 422);
      await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      assert.equal((await call("POST", "/v1/friends/cancel", { token: a.token, body: { xuid: b.xuid } })).status, 200);
      assert.deepEqual((await overview(b)).incoming, []);
      assert.equal((await call("POST", "/v1/friends/accept", { token: b.token, body: { xuid: a.xuid } })).status, 404);

      await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      await call("POST", "/v1/friends/accept", { token: b.token, body: { xuid: a.xuid } });
      assert.equal((await call("POST", "/v1/friends/remove", { token: a.token, body: { xuid: b.xuid } })).status, 200);
      assert.deepEqual((await overview(b)).friends, []);
      assert.equal((await call("POST", "/v1/friends/remove", { token: a.token, body: { xuid: b.xuid } })).status, 404);
      assert.equal((await call("POST", "/v1/friends/accept", { token: a.token, body: { xuid: "nothex" } })).status, 422);
      assert.equal((await call("POST", "/v1/friends/accept", { token: a.token, body: { xuid: "0000000000000000" } })).status, 404);
    });

    test("friend requests are limited per player", async () => {
      const a = await signUp("Fg");
      let last;
      for (let i = 0; i < 21; i++) last = await call("POST", "/v1/friends/request", { token: a.token, body: { to: "NoSuchPlayerHere" } });
      assert.equal(last.status, 429);
    });
  });

  describe("moderation", () => {
    test("admin routes need the operator's token", async () => {
      assert.equal((await call("GET", "/admin/players")).status, 401);
      assert.equal((await call("GET", "/admin/players", { token: "wrong" })).status, 401);
      assert.equal((await admin("GET", "/admin/players?q=alice")).status, 200);
    });

    test("hiding removes a player from other players' boards but not from their own", async () => {
      const a = await signUp("Mh");
      const b = await signUp("Mh");
      await upload(a, [{ view: 0, score: 8_000_000 }]);
      await upload(b, [{ view: 0, score: 1_000 }]);
      assert.equal((await boards(b)).data.views["0"].rows[0].name, a.name);
      assert.equal((await admin("POST", "/admin/hide", { player: a.name })).data.hidden, true);
      const seen = await boards(b);
      assert.ok(!seen.data.views["0"].rows.some((r) => r.name === a.name));
      const own = await boards(a);
      assert.equal(own.status, 200);
      assert.equal(own.data.views["0"].mine.score, 8_000_000);
      assert.equal((await upload(a, [{ view: 0, score: 9_000_000 }])).status, 429, "the interval still applies to hidden players");
      assert.ok(!(await call("GET", "/")).data.includes(a.name));
      assert.equal((await admin("POST", "/admin/hide", { player: a.xuid, hidden: false })).data.hidden, false);
      assert.equal((await boards(b)).data.views["0"].rows[0].name, a.name);
    });

    test("a hidden player's requests never arrive", async () => {
      const a = await signUp("Mi");
      const b = await signUp("Mi");
      await admin("POST", "/admin/hide", { player: a.name });
      assert.equal((await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } })).data.status, "sent");
      assert.deepEqual((await call("GET", "/v1/friends", { token: b.token })).data.incoming, []);
    });

    test("delete a score, rename, rotate a key, remove a player", async () => {
      const a = await signUp("Mj");
      await upload(a, [{ view: 1, score: 123 }, { view: 2, score: 456 }]);
      assert.equal((await admin("POST", "/admin/delete-score", { player: a.name, view: 1 })).data.deleted, 1);
      assert.equal((await boards(a)).data.views["1"].mine, null);
      assert.equal((await boards(a)).data.views["2"].mine.score, 456);

      const renamed = `${a.name}Z`.slice(0, 15);
      assert.equal((await admin("POST", "/admin/rename", { player: a.name, name: renamed })).status, 200);
      assert.equal((await call("GET", "/v1/me", { token: a.token })).data.name, renamed);

      const { token } = (await admin("POST", "/admin/rotate-token", { player: renamed })).data;
      assert.equal((await call("GET", "/v1/me", { token: a.token })).status, 401);
      assert.equal((await call("GET", "/v1/me", { token })).status, 200);

      assert.equal((await admin("POST", "/admin/remove", { player: renamed })).status, 200);
      assert.equal((await call("GET", "/v1/me", { token })).status, 401);
      assert.equal((await admin("POST", "/admin/remove", { player: renamed })).status, 404);
    });
  });

  describe("deleting an account", () => {
    test("needs a confirmation, then removes everything", async () => {
      const a = await signUp("Del");
      const b = await signUp("Del");
      await upload(a, [{ view: 5, score: 99 }]);
      await call("POST", "/v1/friends/request", { token: a.token, body: { to: b.name } });
      await call("POST", "/v1/friends/accept", { token: b.token, body: { xuid: a.xuid } });

      assert.equal((await call("POST", "/v1/me/delete", { token: a.token, body: {} })).status, 400);
      assert.equal((await call("POST", "/v1/me/delete", { token: a.token, body: { confirm: "DELETE" } })).status, 200);
      assert.equal((await call("GET", "/v1/me", { token: a.token })).status, 401);
      assert.ok(!(await boards(b)).data.views["5"].rows.some((r) => r.name === a.name));
      assert.deepEqual((await call("GET", "/v1/friends", { token: b.token })).data.friends, []);
      assert.equal((await call("GET", `/v1/name-available?name=${a.name}`)).data.available, true);
    });
  });

  describe("web page", () => {
    test("shows the boards and nothing hidden", async () => {
      const a = await signUp("Web");
      await upload(a, [{ view: 0, score: 123_456_789 }]);
      const r = await call("GET", "/");
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.ok(r.data.includes("Deadline") && r.data.includes(a.name) && r.data.includes("123,456,789"));
    });
  });
});

describe("closed registration", async () => {
  const { base } = await startServer(8792, { REGISTRATION: "closed", PUBLIC_BOARD: "0" });
  const { call } = client(base);
  test("sign-up is refused with a message the launcher understands, and the page is off", async () => {
    const r = await call("POST", "/v1/register", { body: { name: "Nobody" } });
    assert.equal(r.status, 403);
    assert.match(r.data.detail, /closed/i);
    assert.equal((await call("GET", "/")).status, 404);
  });
});

describe("import from the old server", async () => {
  // `python3` on Linux and macOS, `python` or the `py` launcher on Windows.
  const python = ["python3", "python", "py"]
    .map((command) => ({ command, run: spawnSync(command, ["--version"], { encoding: "utf8" }) }))
    .find(({ run }) => run.status === 0 && /Python 3/.test(`${run.stdout}${run.stderr}`));
  const { base, dir } = await startServer(8793);
  const { call, boards } = client(base);

  test("keeps names, scores, ids and account keys", { skip: !python && "Python 3 not found" }, async () => {
    const work = mkdtempSync(join(tmpdir(), "gw2lb-import-"));
    dirs.push(work);
    const tokens = { Old1: "old-key-one-aaaaaaaaaaaaaaaaaaaaaaaa", Old2: "old-key-two-bbbbbbbbbbbbbbbbbbbbbbbb" };
    const make = spawnSync(
      python.command,
      [
        "-c",
        `
import hashlib, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, xuid TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  name_lc TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE scores (player_id INTEGER NOT NULL, view INTEGER NOT NULL, score INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, view));
""")
h = lambda t: hashlib.sha256(t.encode()).hexdigest()
rows = [(1, "E000AAAAAAAAAAAA", "Old1", "${tokens.Old1}"), (2, "E000BBBBBBBBBBBB", "Old2", "${tokens.Old2}"),
        (3, "E000CCCCCCCCCCCC", "TestFreund", "old-key-three-cccccccccccccccccc")]
for i, x, n, t in rows:
    db.execute("INSERT INTO players VALUES (?,?,?,?,?,?)", (i, x, n, n.lower(), h(t), 1700000000))
db.execute("INSERT INTO scores VALUES (1, 0, 5000, 1700000100)")
db.execute("INSERT INTO scores VALUES (2, 0, 7000, 1700000200)")
db.execute("INSERT INTO scores VALUES (3, 0, 99999, 1700000300)")
db.commit()
`,
        join(work, "old.db"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(make.status, 0, make.stderr);
    const run = spawnSync(python.command, [join(root, "tools", "sqlite-to-d1.py"), join(work, "old.db"), "-o", join(work, "import.sql"), "--skip", "TestFreund", "--befriend-all"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /2 player\(s\), 2 score\(s\), 1 friendship\(s\)/);
    const apply = spawnSync(process.execPath, [wrangler, "d1", "execute", "gw2-leaderboard", "--local", "--persist-to", dir, "--file", join(work, "import.sql")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);

    const me = await call("GET", "/v1/me", { token: tokens.Old1 });
    assert.equal(me.status, 200, "the old account key still works");
    assert.deepEqual([me.data.xuid, me.data.name], ["E000AAAAAAAAAAAA", "Old1"]);
    assert.equal((await call("GET", "/v1/me", { token: "old-key-three-cccccccccccccccccc" })).status, 401);

    const result = await boards({ token: tokens.Old1 });
    assert.deepEqual(result.data.views["0"].rows.map((r) => [r.name, r.score]), [["Old2", 7000], ["Old1", 5000]]);
    assert.deepEqual(result.data.views["0"].friends.map((r) => r.name), ["Old2", "Old1"]);
    assert.equal((await call("POST", "/v1/register", { body: { name: "Newcomer" } })).status, 201, "new ids continue after the imported ones");
  });
});
