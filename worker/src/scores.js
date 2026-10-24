// Uploading scores and reading the boards.

import {
  AROUND_SPAN, DEFAULT_MAX_SCORE, FLAG_VS_OWN, FLAG_VS_TOP, MAX_BOARD_ROWS, MAX_SCORE, MODE_IDS, SUBMIT_INTERVAL_SECONDS,
} from "./config.js";
import { HttpError, authenticate, bumpRevision, json, now, readJson, revision } from "./common.js";

// Tie-break everywhere: the higher score first, then the older one, then the lower player id.
const ORDER = "s.score DESC, s.updated_at ASC, p.id ASC";

// The player's own score and rank in each mode they have one. Hidden players are not counted, so a hidden player's
// rank is where they would be if they were visible.
const MINE_SQL =
  "SELECT m.view AS view, m.score AS score, " +
  "(SELECT COUNT(*) FROM scores s JOIN players p ON p.id = s.player_id " +
  " WHERE s.view = m.view AND p.hidden = 0 AND s.player_id != m.player_id AND " +
  " (s.score > m.score OR (s.score = m.score AND (s.updated_at < m.updated_at OR " +
  "  (s.updated_at = m.updated_at AND s.player_id < m.player_id))))) + 1 AS rank " +
  "FROM scores m WHERE m.player_id = ?";

const maxScore = (view) => MAX_SCORE[view] ?? DEFAULT_MAX_SCORE;

export async function postScores(request, env) {
  const player = await authenticate(request, env);
  const body = await readJson(request);
  if (!Array.isArray(body.scores) || body.scores.length < 1 || body.scores.length > MODE_IDS.length) {
    throw new HttpError(422, "scores must hold 1 to 6 entries");
  }
  const best = new Map(); // a batch may repeat a mode; only its best counts
  for (const entry of body.scores) {
    const { view, score } = entry ?? {};
    if (!MODE_IDS.includes(view)) throw new HttpError(422, "Unknown mode");
    if (!Number.isSafeInteger(score) || score < 1 || score > maxScore(view)) throw new HttpError(422, "Score out of range");
    best.set(view, Math.max(score, best.get(view) ?? 0));
  }

  const time = now();
  const interval = Number(env.SUBMIT_INTERVAL_SECONDS ?? SUBMIT_INTERVAL_SECONDS); // a variable only for the tests
  if (time - player.last_submit < interval) {
    throw new HttpError(429, "Too many uploads", { "retry-after": String(Math.max(1, interval)) });
  }

  const views = [...best.keys()].sort((a, b) => a - b);

  // What stood before, to flag a score that stands out afterwards.
  const marks = views.map(() => "?").join(",");
  const [own, others] = await env.DB.batch([
    env.DB.prepare(`SELECT view, score FROM scores WHERE player_id = ? AND view IN (${marks})`).bind(player.id, ...views),
    env.DB.prepare(
      "SELECT s.view AS view, MAX(s.score) AS top FROM scores s JOIN players p ON p.id = s.player_id " +
        `WHERE p.hidden = 0 AND s.player_id != ? AND s.view IN (${marks}) GROUP BY s.view`,
    ).bind(player.id, ...views),
  ]);
  const before = new Map(own.results.map((r) => [r.view, r.score]));
  const topOthers = new Map(others.results.map((r) => [r.view, r.top]));

  const results = await env.DB.batch([
    env.DB.prepare("UPDATE players SET last_submit = ? WHERE id = ?").bind(time, player.id),
    ...views.map((view) =>
      env.DB.prepare(
        "INSERT INTO scores (player_id, view, score, updated_at) VALUES (?1, ?2, ?3, ?4) " +
          "ON CONFLICT (player_id, view) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at " +
          "WHERE excluded.score > scores.score",
      ).bind(player.id, view, best.get(view), time),
    ),
  ]);
  const improved = new Map(views.map((view, i) => [view, results[i + 1].meta.changes > 0]));
  if ([...improved.values()].some(Boolean)) await bumpRevision(env).run();

  const flags = views.filter((view) => {
    const score = best.get(view);
    const top = topOthers.get(view) ?? 0;
    const previous = before.get(view) ?? 0;
    return improved.get(view) && top > 0 && score > top && (score >= FLAG_VS_TOP * top || (previous > 0 && score >= FLAG_VS_OWN * previous));
  });
  if (flags.length) {
    await env.DB.batch(
      flags.map((view) =>
        env.DB.prepare(
          "INSERT INTO score_flags (player_id, view, previous, score, top_other, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(player.id, view, before.get(view) ?? 0, best.get(view), topOthers.get(view), time),
      ),
    );
  }

  const { results: mine } = await env.DB.prepare(MINE_SQL).bind(player.id).all();
  const byView = new Map(mine.map((row) => [row.view, row]));
  return json({
    revision: await revision(env),
    results: views.map((view) => ({
      view,
      score: byView.get(view).score,
      rank: byView.get(view).rank,
      improved: improved.get(view),
    })),
  });
}

// The top rows and totals are the same for every player, and exactly right for as long as the revision (which every
// change to a score, a name or a friendship raises) stays the same. A Worker instance keeps the last answer in memory,
// so a poll costs this the one-row revision read instead of scanning the boards again.
let shared = null;

async function globalBoards(env, rev, limit) {
  if (shared && shared.revision === rev && shared.limit === limit) return shared;
  const answers = await env.DB.batch([
    ...MODE_IDS.map((view) =>
      env.DB.prepare(
        `SELECT p.xuid AS xuid, p.name AS name, s.score AS score FROM scores s JOIN players p ON p.id = s.player_id ` +
          `WHERE s.view = ? AND p.hidden = 0 ORDER BY ${ORDER} LIMIT ?`,
      ).bind(view, limit),
    ),
    env.DB.prepare(
      "SELECT s.view AS view, COUNT(*) AS total FROM scores s JOIN players p ON p.id = s.player_id " +
        "WHERE p.hidden = 0 GROUP BY s.view",
    ),
  ]);
  shared = {
    revision: rev,
    limit,
    tops: Object.fromEntries(MODE_IDS.map((view, i) => [view, answers[i].results])),
    totals: new Map(answers[MODE_IDS.length].results.map((r) => [r.view, r.total])),
  };
  return shared;
}

// Everything the game needs in one answer: per mode the top rows, the player's own place with the rows around it
// when they are outside the top rows, and the board of their friends (ranked among themselves and the player). The
// answer depends on the player, so a revision that changed for anyone changes the ETag for everyone.
export async function boards(request, env, url) {
  const player = await authenticate(request, env);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.max(1, Math.min(Number.isNaN(requested) ? MAX_BOARD_ROWS : requested, MAX_BOARD_ROWS));

  const rev = await revision(env);
  const etag = `"${rev}-${limit}"`;
  const headers = { etag, "cache-control": "private, no-cache" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const { tops, totals } = await globalBoards(env, rev, limit);
  const first = await env.DB.batch([
    env.DB.prepare(MINE_SQL).bind(player.id),
    env.DB.prepare(
      "SELECT s.view AS view, p.xuid AS xuid, p.name AS name, s.score AS score " +
        "FROM scores s JOIN players p ON p.id = s.player_id " +
        "WHERE p.id = ?1 OR (p.hidden = 0 AND p.id IN " +
        " (SELECT CASE WHEN a_id = ?1 THEN b_id ELSE a_id END FROM friendships WHERE a_id = ?1 OR b_id = ?1)) " +
        `ORDER BY s.view, ${ORDER}`,
    ).bind(player.id),
    env.DB.prepare(
      "SELECT p.xuid AS xuid, p.name AS name FROM players p WHERE p.hidden = 0 AND p.id IN " +
        "(SELECT CASE WHEN a_id = ?1 THEN b_id ELSE a_id END FROM friendships WHERE a_id = ?1 OR b_id = ?1) " +
        "ORDER BY p.name_lc",
    ).bind(player.id),
  ]);

  const mine = new Map(first[0].results.map((r) => [r.view, r]));
  const friendRows = first[1].results;
  const friends = first[2].results;

  // The rows around the player, only in the modes where they are not already among the top rows.
  const outside = MODE_IDS.filter((view) => mine.has(view) && mine.get(view).rank > limit);
  const windows = new Map();
  if (outside.length) {
    const answers = await env.DB.batch(
      outside.map((view) => {
        const start = Math.max(0, mine.get(view).rank - 1 - AROUND_SPAN);
        return env.DB.prepare(
          `SELECT p.xuid AS xuid, p.name AS name, s.score AS score FROM scores s JOIN players p ON p.id = s.player_id ` +
            `WHERE s.view = ? AND p.hidden = 0 ORDER BY ${ORDER} LIMIT ? OFFSET ?`,
        ).bind(view, 2 * AROUND_SPAN + 1, start);
      }),
    );
    outside.forEach((view, i) => {
      const start = Math.max(0, mine.get(view).rank - 1 - AROUND_SPAN);
      windows.set(view, answers[i].results.map((row, n) => ({ rank: start + n + 1, ...row })));
    });
  }

  const views = {};
  MODE_IDS.forEach((view) => {
    const own = mine.get(view);
    let rank = 0;
    views[view] = {
      total: totals.get(view) ?? 0,
      rows: tops[view].map((row, n) => ({ rank: n + 1, ...row })),
      mine: own ? { rank: own.rank, score: own.score } : null,
      around: windows.get(view) ?? [],
      friends: friendRows.filter((row) => row.view === view).map(({ xuid, name, score }) => ({ rank: ++rank, xuid, name, score })),
    };
  });
  return json({ revision: rev, me: player.xuid, friends, views }, 200, headers);
}
