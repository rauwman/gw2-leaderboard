import { LIMITS, MAX_BODY_BYTES, NAME_RE, NAME_RULE, FRIEND_CODE_ALPHABET, FRIEND_CODE_LENGTH } from "./config.js";

// Errors carry the same {"detail": "..."} body the old FastAPI server sent, which the game's launcher reads.
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(error) {
  return json({ detail: error.message }, error.status, error.headers);
}

export const now = () => Math.floor(Date.now() / 1000);

export async function readJson(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object");
  return body;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The private account key: 24 random bytes, URL-safe base64 (32 characters). Only its SHA-256 is stored.
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Retail XUIDs start with 0009 or E000; E000 plus 12 random hex digits looks the same to the game.
export const newXuid = () => "E000" + randomHex(6).toUpperCase();

export function newFriendCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(FRIEND_CODE_LENGTH));
  return [...bytes].map((b) => FRIEND_CODE_ALPHABET[b % FRIEND_CODE_ALPHABET.length]).join("");
}

export const formatFriendCode = (code) => (code ? `${code.slice(0, 5)}-${code.slice(5)}` : null);

// What a player typed or pasted: any case, with or without the dash or spaces.
export const normalizeFriendCode = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function checkName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name !== name.trimEnd()) throw new HttpError(422, NAME_RULE);
  return name;
}

export const isUnique = (error, column) =>
  /UNIQUE constraint failed/i.test(String(error?.message ?? error)) && String(error.message).includes(column);

export async function revision(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'revision'").first();
  return row?.value ?? 1;
}

// A statement for a batch: anything the boards show has changed.
export const bumpRevision = (env) => env.DB.prepare("UPDATE meta SET value = value + 1 WHERE key = 'revision'");

export async function authenticate(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const space = header.indexOf(" ");
  const scheme = space < 0 ? header : header.slice(0, space);
  const token = space < 0 ? "" : header.slice(space + 1).trim();
  const challenge = { "www-authenticate": "Bearer" };
  if (scheme.toLowerCase() !== "bearer" || !token) throw new HttpError(401, "Bearer token required", challenge);
  const player = await env.DB.prepare("SELECT * FROM players WHERE token_hash = ?").bind(await sha256Hex(token)).first();
  if (!player) throw new HttpError(401, "Unknown token", challenge);
  return player;
}

// Counts one attempt and says whether it is within the limit (see LIMITS). Written to D1 because a Worker has no
// memory between requests; the daily housekeeping deletes old rows.
export async function withinLimit(env, name, key) {
  const [attempts, window] = LIMITS[name];
  const slot = Math.floor(now() / window);
  const { results } = await env.DB.prepare(
    "INSERT INTO rate_limits (bucket, key, window, count, expires_at) VALUES (?1, ?2, ?3, 1, ?4) " +
      "ON CONFLICT (bucket, key, window) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(name, key, slot, (slot + 1) * window)
    .all();
  return results[0].count <= attempts;
}

export function tooMany(name) {
  return new HttpError(429, "Too many attempts, try again later", { "retry-after": String(LIMITS[name][1]) });
}

// A truncated hash of the caller's address, only ever used as a rate-limit key.
export async function clientKey(request) {
  const address = request.headers.get("cf-connecting-ip") ?? "?";
  return (await sha256Hex(address)).slice(0, 16);
}
