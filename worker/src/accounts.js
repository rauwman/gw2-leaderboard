// Players: sign-up, name checks, rename, friend code, deleting an account.

import {
  HttpError, authenticate, bumpRevision, checkName, clientKey, formatFriendCode, isUnique, json, newFriendCode,
  newToken, newXuid, now, readJson, sha256Hex, tooMany, withinLimit,
} from "./common.js";

export async function nameAvailable(request, env, url) {
  const name = url.searchParams.get("name") ?? "";
  try {
    checkName(name);
  } catch (error) {
    return json({ available: false, reason: "invalid", message: error.message });
  }
  const taken = await env.DB.prepare("SELECT 1 AS x FROM players WHERE name_lc = ?").bind(name.toLowerCase()).first();
  return json({ available: !taken, reason: taken ? "taken" : null });
}

// Open sign-up: a free name is all it takes (`invite`, which the first version of the game still sends, is ignored).
// The account key is returned once; only its hash is stored.
export async function register(request, env) {
  if (env.REGISTRATION === "closed") throw new HttpError(403, "Registration is closed");
  const body = await readJson(request);
  const name = checkName(body.name);
  if (!(await withinLimit(env, "register_ip", await clientKey(request)))) throw tooMany("register_ip");
  if (!(await withinLimit(env, "register_all", "all"))) throw tooMany("register_all");

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = newToken();
    const xuid = newXuid();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO players (xuid, name, name_lc, token_hash, friend_code, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(xuid, name, name.toLowerCase(), await sha256Hex(token), newFriendCode(), now()),
        bumpRevision(env),
      ]);
      return json({ xuid, name, token }, 201);
    } catch (error) {
      if (isUnique(error, "players.name_lc")) throw new HttpError(409, "That name is already taken");
      // A clash of the random xuid or friend code is practically impossible, but costs nothing to retry.
      if (!isUnique(error, "players.xuid") && !isUnique(error, "players.friend_code")) throw error;
    }
  }
  throw new HttpError(500, "Could not create the account, try again");
}

// Accounts imported from the old server have no friend code yet: they get one the first time it is needed.
export async function ensureFriendCode(env, player) {
  if (player.friend_code) return player.friend_code;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newFriendCode();
    try {
      await env.DB.prepare("UPDATE players SET friend_code = ? WHERE id = ? AND friend_code IS NULL")
        .bind(code, player.id)
        .run();
    } catch (error) {
      if (isUnique(error, "players.friend_code")) continue;
      throw error;
    }
    const row = await env.DB.prepare("SELECT friend_code FROM players WHERE id = ?").bind(player.id).first();
    return row.friend_code;
  }
  throw new HttpError(500, "Could not create a friend code, try again");
}

export async function me(request, env) {
  const player = await authenticate(request, env);
  const code = await ensureFriendCode(env, player);
  return json({ xuid: player.xuid, name: player.name, friend_code: formatFriendCode(code) });
}

export async function rename(request, env) {
  const player = await authenticate(request, env);
  const name = checkName((await readJson(request)).name);
  if (!(await withinLimit(env, "rename", String(player.id)))) throw tooMany("rename");
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE players SET name = ?, name_lc = ? WHERE id = ?").bind(name, name.toLowerCase(), player.id),
      bumpRevision(env),
    ]);
  } catch (error) {
    if (isUnique(error, "players.name_lc")) throw new HttpError(409, "That name is already taken");
    throw error;
  }
  return json({ xuid: player.xuid, name });
}

// A new friend code; the old one stops working. Friends and open requests stay.
export async function newCode(request, env) {
  const player = await authenticate(request, env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newFriendCode();
    try {
      await env.DB.prepare("UPDATE players SET friend_code = ? WHERE id = ?").bind(code, player.id).run();
      return json({ friend_code: formatFriendCode(code) });
    } catch (error) {
      if (!isUnique(error, "players.friend_code")) throw error;
    }
  }
  throw new HttpError(500, "Could not create a friend code, try again");
}

// Removes the player, their scores, friendships and requests. Needs {"confirm": "DELETE"} so it cannot happen by accident.
export async function deleteMe(request, env) {
  const player = await authenticate(request, env);
  const body = await readJson(request);
  if (body.confirm !== "DELETE") throw new HttpError(400, 'Send {"confirm": "DELETE"} to delete the account');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE player_id = ?").bind(player.id),
    env.DB.prepare("DELETE FROM friendships WHERE a_id = ?1 OR b_id = ?1").bind(player.id),
    env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1").bind(player.id),
    env.DB.prepare("DELETE FROM players WHERE id = ?").bind(player.id),
    bumpRevision(env),
  ]);
  return json({ deleted: player.xuid });
}
