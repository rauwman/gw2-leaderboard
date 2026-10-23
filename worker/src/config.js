// Fixed rules of the service. Anything an operator may want to change without editing code is a Worker variable
// (see README.md): REGISTRATION and PUBLIC_BOARD.

// The game's own leaderboard views.
export const MODES = { 0: "Deadline", 1: "Evolved", 2: "Sequence", 3: "Waves", 4: "Pacifism", 5: "King" };
export const MODE_IDS = Object.keys(MODES).map(Number);

// The game's gamertag buffer is 16 bytes including the terminator. ASCII only: the game's font is not known to cover
// more. The same rule is in the game's launcher.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,14}$/;
export const NAME_RULE = "1-15 characters: letters, digits, space, _ . -; must start with a letter or digit";

// Far above any real score. Tighten per mode once the boards show what is plausible: an entry here replaces the default.
export const DEFAULT_MAX_SCORE = 100_000_000_000;
export const MAX_SCORE = {};

// One upload per player this often. A finished game never comes close to it.
export const SUBMIT_INTERVAL_SECONDS = 10;

export const MAX_BODY_BYTES = 4096;
export const MAX_BOARD_ROWS = 100;
export const AROUND_SPAN = 5; // rows above and below the player in a mode where they are outside the top rows

export const MAX_FRIENDS = 200;
export const MAX_OPEN_OUTGOING = 50;
export const MAX_OPEN_INCOMING = 100;
export const REQUEST_TTL_SECONDS = 30 * 86400;
export const DECLINED_TTL_SECONDS = 180 * 86400;

// [attempts, window in seconds]. Every attempt counts, successful or not.
export const LIMITS = {
  register_ip: [5, 3600],
  register_all: [300, 3600], // a circuit breaker for sign-ups spread over many addresses
  friend_request: [20, 3600], // per player; also makes guessing friend codes pointless
  rename: [10, 3600],
};

// Friend codes: 10 characters without the easily confused 0, 1, I and O (32^10, about 2^50 combinations).
export const FRIEND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const FRIEND_CODE_LENGTH = 10;
