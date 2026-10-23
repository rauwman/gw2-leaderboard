// Friends: a request by friend code, accepted by the other player. Only then do both see each other on the Friends board.

import { MAX_FRIENDS, MAX_OPEN_INCOMING, MAX_OPEN_OUTGOING } from "./config.js";
import {
  HttpError, authenticate, bumpRevision, formatFriendCode, json, normalizeFriendCode, now, readJson, tooMany,
  withinLimit,
} from "./common.js";
import { ensureFriendCode } from "./accounts.js";

const pair = (x, y) => (x < y ? [x, y] : [y, x]);

const countFriends = async (env, id) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships WHERE a_id = ?1 OR b_id = ?1").bind(id).first()).n;

const publicPlayer = ({ xuid, name }) => ({ xuid, name });

async function playerByXuid(env, xuid) {
  if (typeof xuid !== "string" || !/^[0-9A-Fa-f]{16}$/.test(xuid)) throw new HttpError(422, "Unknown player");
  const row = await env.DB.prepare("SELECT * FROM players WHERE xuid = ?").bind(xuid.toUpperCase()).first();
  if (!row) throw new HttpError(404, "Unknown player");
  return row;
}

// The friend code, the friends, and the requests waiting for an answer in either direction.
export async function overview(request, env) {
  const player = await authenticate(request, env);
  const code = await ensureFriendCode(env, player);
  const [friends, incoming, outgoing] = await env.DB.batch([
    env.DB.prepare(
      "SELECT p.xuid AS xuid, p.name AS name FROM players p WHERE p.hidden = 0 AND p.id IN " +
        "(SELECT CASE WHEN a_id = ?1 THEN b_id ELSE a_id END FROM friendships WHERE a_id = ?1 OR b_id = ?1) " +
        "ORDER BY p.name_lc",
    ).bind(player.id),
    env.DB.prepare(
      "SELECT p.xuid AS xuid, p.name AS name FROM friend_requests r JOIN players p ON p.id = r.from_id " +
        "WHERE r.to_id = ? AND r.state = 'pending' AND p.hidden = 0 ORDER BY r.created_at",
    ).bind(player.id),
    env.DB.prepare(
      "SELECT p.xuid AS xuid, p.name AS name FROM friend_requests r JOIN players p ON p.id = r.to_id " +
        "WHERE r.from_id = ? AND r.state = 'pending' ORDER BY r.created_at",
    ).bind(player.id),
  ]);
  return json({
    friend_code: formatFriendCode(code),
    friends: friends.results,
    incoming: incoming.results,
    outgoing: outgoing.results,
  });
}

// Asks the owner of a friend code to be friends. Answers are the same whether the other side can see the request or
// not, so a player cannot find out that someone ignored or blocked them.
export async function sendRequest(request, env) {
  const me = await authenticate(request, env);
  const code = normalizeFriendCode((await readJson(request)).code);
  if (code.length < 10) throw new HttpError(422, "That is not a friend code");
  if (!(await withinLimit(env, "friend_request", String(me.id)))) throw tooMany("friend_request");

  const target = await env.DB.prepare("SELECT * FROM players WHERE friend_code = ?").bind(code).first();
  if (!target) throw new HttpError(404, "No player has that friend code");
  if (target.id === me.id) throw new HttpError(422, "That is your own friend code");

  const [a, b] = pair(me.id, target.id);
  const friends = await env.DB.prepare("SELECT 1 AS x FROM friendships WHERE a_id = ? AND b_id = ?").bind(a, b).first();
  if (friends) return json({ status: "friends", ...publicPlayer(target) });

  // The other player already asked me: both want it, so it is settled.
  const theirs = await env.DB.prepare(
    "SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND state = 'pending'",
  ).bind(target.id, me.id).first();
  if (theirs) {
    await makeFriends(env, me, target);
    return json({ status: "friends", ...publicPlayer(target) });
  }

  const reply = { status: "sent", ...publicPlayer(target) };
  const mine = await env.DB.prepare("SELECT state FROM friend_requests WHERE from_id = ? AND to_id = ?")
    .bind(me.id, target.id)
    .first();
  if (mine) return json(reply); // already asked, or answered with no: nothing to add

  const [openOut, openIn, myFriends, theirFriends] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ? AND state = 'pending'").bind(me.id).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE to_id = ? AND state = 'pending'").bind(target.id).first(),
    countFriends(env, me.id),
    countFriends(env, target.id),
  ]);
  if (openOut.n >= MAX_OPEN_OUTGOING) throw new HttpError(429, "You have too many open requests");
  if (myFriends >= MAX_FRIENDS) throw new HttpError(409, "Your friend list is full");

  // A request that cannot or must not arrive is stored as declined: the sender sees "sent" either way.
  const deliverable = !me.hidden && openIn.n < MAX_OPEN_INCOMING && theirFriends < MAX_FRIENDS;
  await env.DB.prepare("INSERT INTO friend_requests (from_id, to_id, state, created_at) VALUES (?, ?, ?, ?)")
    .bind(me.id, target.id, deliverable ? "pending" : "declined", now())
    .run();
  return json(reply, 201);
}

async function makeFriends(env, me, other) {
  if ((await countFriends(env, me.id)) >= MAX_FRIENDS) throw new HttpError(409, "Your friend list is full");
  if ((await countFriends(env, other.id)) >= MAX_FRIENDS) throw new HttpError(409, "Their friend list is full");
  const [a, b] = pair(me.id, other.id);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)").bind(a, b, now()),
    env.DB.prepare(
      "DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
    ).bind(me.id, other.id),
    bumpRevision(env),
  ]);
}

export async function accept(request, env) {
  const me = await authenticate(request, env);
  const other = await playerByXuid(env, (await readJson(request)).xuid);
  const open = await env.DB.prepare(
    "SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND state = 'pending'",
  ).bind(other.id, me.id).first();
  if (!open) throw new HttpError(404, "There is no open request from that player");
  await makeFriends(env, me, other);
  return json({ status: "friends", ...publicPlayer(other) });
}

// Declining keeps a silent marker, so the same player cannot send the request again and again.
export async function decline(request, env) {
  const me = await authenticate(request, env);
  const other = await playerByXuid(env, (await readJson(request)).xuid);
  const done = await env.DB.prepare(
    "UPDATE friend_requests SET state = 'declined' WHERE from_id = ? AND to_id = ? AND state = 'pending'",
  ).bind(other.id, me.id).run();
  if (!done.meta.changes) throw new HttpError(404, "There is no open request from that player");
  return json({ status: "declined" });
}

// Takes back a request of mine that was not answered yet.
export async function cancel(request, env) {
  const me = await authenticate(request, env);
  const other = await playerByXuid(env, (await readJson(request)).xuid);
  await env.DB.prepare("DELETE FROM friend_requests WHERE from_id = ? AND to_id = ? AND state = 'pending'")
    .bind(me.id, other.id)
    .run();
  return json({ status: "cancelled" });
}

export async function remove(request, env) {
  const me = await authenticate(request, env);
  const other = await playerByXuid(env, (await readJson(request)).xuid);
  const [a, b] = pair(me.id, other.id);
  const [done] = await env.DB.batch([
    env.DB.prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?").bind(a, b),
    bumpRevision(env),
  ]);
  if (!done.meta.changes) throw new HttpError(404, "You are not friends");
  return json({ status: "removed" });
}
