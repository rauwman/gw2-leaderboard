// GW2 leaderboard: a Cloudflare Worker over a D1 database (schema.sql). The API is the one the game's launcher
// already speaks (/v1/...), plus global boards and friends.
//
//   POST /v1/register                 {name}                      -> {xuid, name, token}   (token shown once)
//   GET  /v1/name-available?name=
//   GET  /v1/me                                                   -> {xuid, name, friend_code}
//   PUT  /v1/me                       {name}
//   POST /v1/me/friend-code                                       -> {friend_code}   (replaces the old one)
//   POST /v1/me/delete                {confirm: "DELETE"}
//   POST /v1/scores                   {scores: [{view, score}]}
//   GET  /v1/boards?limit=            top rows, own place and friends per mode      (ETag / 304)
//   GET  /v1/friends                                              -> friend code, friends, open requests
//   POST /v1/friends/request          {code}
//   POST /v1/friends/accept | decline | cancel | remove   {xuid}
//
// Everything except register and name-available needs `Authorization: Bearer <account key>`. /admin/* is documented
// in admin.js.

import * as accounts from "./accounts.js";
import * as admin from "./admin.js";
import * as friends from "./friends.js";
import * as scores from "./scores.js";
import { DECLINED_TTL_SECONDS, REQUEST_TTL_SECONDS } from "./config.js";
import { HttpError, errorResponse, json, now } from "./common.js";
import { page } from "./page.js";

const routes = {
  "GET /healthz": () => json({ ok: true }),
  "GET /v1/name-available": (request, env, url) => accounts.nameAvailable(request, env, url),
  "POST /v1/register": accounts.register,
  "GET /v1/me": accounts.me,
  "PUT /v1/me": accounts.rename,
  "POST /v1/me/friend-code": accounts.newCode,
  "POST /v1/me/delete": accounts.deleteMe,
  "POST /v1/scores": scores.postScores,
  "GET /v1/boards": (request, env, url) => scores.boards(request, env, url),
  "GET /v1/friends": friends.overview,
  "POST /v1/friends/request": friends.sendRequest,
  "POST /v1/friends/accept": friends.accept,
  "POST /v1/friends/decline": friends.decline,
  "POST /v1/friends/cancel": friends.cancel,
  "POST /v1/friends/remove": friends.remove,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/admin/")) return await admin.handle(request, env, url);
      if (request.method === "GET" && url.pathname === "/") return await page(env);
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "Not found");
      return await route(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error);
      console.error(error);
      return errorResponse(new HttpError(500, "Server error"));
    }
  },

  // Daily housekeeping (see wrangler.toml).
  async scheduled(_event, env) {
    const time = now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(time),
      env.DB.prepare("DELETE FROM friend_requests WHERE state = 'pending' AND created_at < ?").bind(time - REQUEST_TTL_SECONDS),
      env.DB.prepare("DELETE FROM friend_requests WHERE state = 'declined' AND created_at < ?").bind(time - DECLINED_TTL_SECONDS),
    ]);
  },
};
