// Moderation, for the operator only. Every call needs `Authorization: Bearer <ADMIN_TOKEN>`; ADMIN_TOKEN is a Worker
// secret (npx wrangler secret put ADMIN_TOKEN). Without it these routes answer 404 as if they did not exist.

import { MODE_IDS } from "./config.js";
import { HttpError, bumpRevision, checkName, isUnique, json, newToken, readJson, sha256Hex } from "./common.js";

async function authorize(request, env) {
  if (!env.ADMIN_TOKEN) throw new HttpError(404, "Not found");
  const header = request.headers.get("authorization") ?? "";
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  // Compare hashes: equal length, and no early exit on the first differing character.
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(env.ADMIN_TOKEN)]);
  if (!crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))) {
    throw new HttpError(401, "Unauthorized", { "www-authenticate": "Bearer" });
  }
}

// A player by xuid (16 hex digits) or by name.
async function find(env, who) {
  if (typeof who !== "string" || !who) throw new HttpError(422, "Name or xuid of the player required");
  const row = /^[0-9A-Fa-f]{16}$/.test(who)
    ? await env.DB.prepare("SELECT * FROM players WHERE xuid = ?").bind(who.toUpperCase()).first()
    : await env.DB.prepare("SELECT * FROM players WHERE name_lc = ?").bind(who.toLowerCase()).first();
  if (!row) throw new HttpError(404, "No such player");
  return row;
}

export async function handle(request, env, url) {
  await authorize(request, env);
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /admin/players") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const { results } = await env.DB.prepare(
      "SELECT p.xuid, p.name, p.hidden, p.created_at, (SELECT COUNT(*) FROM scores s WHERE s.player_id = p.id) AS scores " +
        "FROM players p WHERE p.name_lc LIKE ? ORDER BY p.id DESC LIMIT 100",
    ).bind(`%${q.replace(/[%_\\]/g, "")}%`).all();
    return json({ players: results });
  }

  if (request.method !== "POST") throw new HttpError(404, "Not found");
  const body = await readJson(request);
  const player = await find(env, body.player);

  switch (url.pathname) {
    case "/admin/hide": {
      const hidden = body.hidden === false ? 0 : 1;
      await env.DB.batch([
        env.DB.prepare("UPDATE players SET hidden = ? WHERE id = ?").bind(hidden, player.id),
        bumpRevision(env),
      ]);
      return json({ player: player.name, hidden: Boolean(hidden) });
    }
    case "/admin/delete-score": {
      if (!MODE_IDS.includes(body.view)) throw new HttpError(422, "Unknown mode");
      const [done] = await env.DB.batch([
        env.DB.prepare("DELETE FROM scores WHERE player_id = ? AND view = ?").bind(player.id, body.view),
        bumpRevision(env),
      ]);
      return json({ player: player.name, deleted: done.meta.changes });
    }
    case "/admin/rename": {
      const name = checkName(body.name);
      try {
        await env.DB.batch([
          env.DB.prepare("UPDATE players SET name = ?, name_lc = ? WHERE id = ?").bind(name, name.toLowerCase(), player.id),
          bumpRevision(env),
        ]);
      } catch (error) {
        if (isUnique(error, "players.name_lc")) throw new HttpError(409, "That name is already taken");
        throw error;
      }
      return json({ player: name });
    }
    case "/admin/rotate-token": {
      const token = newToken();
      await env.DB.prepare("UPDATE players SET token_hash = ? WHERE id = ?").bind(await sha256Hex(token), player.id).run();
      return json({ player: player.name, token });
    }
    case "/admin/remove": {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM scores WHERE player_id = ?").bind(player.id),
        env.DB.prepare("DELETE FROM friendships WHERE a_id = ?1 OR b_id = ?1").bind(player.id),
        env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1").bind(player.id),
        env.DB.prepare("DELETE FROM players WHERE id = ?").bind(player.id),
        bumpRevision(env),
      ]);
      return json({ removed: player.name });
    }
    default:
      throw new HttpError(404, "Not found");
  }
}
