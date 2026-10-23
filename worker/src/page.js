// A read-only page for browsers: the top rows of every mode.

import { MODES } from "./config.js";

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function page(env) {
  if (env.PUBLIC_BOARD === "0") return new Response("Not found", { status: 404 });
  const sections = [];
  for (const [view, mode] of Object.entries(MODES)) {
    const { results } = await env.DB.prepare(
      "SELECT p.name AS name, s.score AS score FROM scores s JOIN players p ON p.id = s.player_id " +
        "WHERE s.view = ? AND p.hidden = 0 ORDER BY s.score DESC, s.updated_at ASC, p.id ASC LIMIT 20",
    ).bind(Number(view)).all();
    const rows = results.length
      ? results
          .map((r, i) => `<tr><td>${i + 1}</td><td>${escape(r.name)}</td><td class=n>${r.score.toLocaleString("en-US")}</td></tr>`)
          .join("")
      : "<tr><td colspan=3>No scores yet</td></tr>";
    sections.push(`<section><h2>${mode}</h2><table>${rows}</table></section>`);
  }
  const html =
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>GW2 Leaderboard</title><style>" +
    ":root{color-scheme:light dark}body{font:16px system-ui;margin:0 auto;max-width:720px;padding:16px}" +
    "section{margin:0 0 24px}table{border-collapse:collapse;width:100%}td{padding:4px 8px;border-bottom:1px solid #8884}" +
    ".n{text-align:right;font-variant-numeric:tabular-nums}h2{margin:16px 0 4px}p{opacity:.7;font-size:14px}" +
    "</style><h1>Geometry Wars: Retro Evolved 2</h1>" +
    sections.join("") +
    "<p>Scores are uploaded by players' own PCs and are for fun, not a tournament.</p>";
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" } });
}
