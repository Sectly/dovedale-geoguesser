import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, renameSync } from "fs";

mkdirSync("./data", { recursive: true });
mkdirSync("./public/uploads", { recursive: true });

const DB_PATH = "./data/geoguesser.sqlite";

function openDatabase(): Database {
	if (existsSync(DB_PATH)) {
		let probe: Database | null = null;
		try {
			probe = new Database(DB_PATH);
			const rows = probe.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
			const ok = rows.length === 1 && rows[0].integrity_check === "ok";
			probe.close();
			probe = null;
			if (!ok) {
				const issues = rows.map((r) => r.integrity_check).join("; ");
				throw new Error(`integrity_check: ${issues}`);
			}
		} catch (err) {
			if (probe) {
				try {
					probe.close();
				} catch {}
			}
			const ts = Date.now();
			console.error(`[db] Database problem detected: ${err instanceof Error ? err.message : err}`);
			for (const suffix of ["", "-wal", "-shm"]) {
				const src = DB_PATH + suffix;
				if (existsSync(src)) {
					const dst = `${src}.corrupt.${ts}`;
					try {
						renameSync(src, dst);
						console.warn(`[db] Moved ${src} → ${dst}`);
					} catch (e) {
						console.error(`[db] Could not move ${src}:`, e);
					}
				}
			}
			console.warn("[db] Starting with a fresh database.");
		}
	}

	const db = new Database(DB_PATH, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	return db;
}

export const db = openDatabase();

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT NULL,
  is_banned INTEGER DEFAULT 0,
  ban_type TEXT DEFAULT NULL,
  ban_expires_at INTEGER DEFAULT NULL,
  upload_limited INTEGER DEFAULT 0,
  upload_limit_expires_at INTEGER DEFAULT NULL,
  duel_limited INTEGER DEFAULT 0,
  duel_limit_expires_at INTEGER DEFAULT NULL,
  current_streak INTEGER DEFAULT 0,
  longest_streak INTEGER DEFAULT 0,
  last_played_date TEXT,
  profile_private INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_path TEXT NOT NULL,
  world_x REAL NOT NULL,
  world_y REAL NOT NULL,
  label TEXT,
  hints TEXT DEFAULT '[]',
  submitted_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_path TEXT NOT NULL,
  world_x REAL NOT NULL,
  world_y REAL NOT NULL,
  label TEXT,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at INTEGER,
  deny_reason TEXT,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS solo_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_score INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  max_possible INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS duel_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT UNIQUE NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 5,
  status TEXT DEFAULT 'waiting',
  created_by INTEGER NOT NULL REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  created_at INTEGER DEFAULT (unixepoch()),
  finished_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS duel_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES duel_games(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_score INTEGER DEFAULT 0,
  joined_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(game_id, user_id)
)`,
	`CREATE TABLE IF NOT EXISTS duel_round_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES duel_games(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  round_number INTEGER NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  guessed_x REAL,
  guessed_y REAL,
  distance REAL,
  time_taken REAL,
  score INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fp_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen INTEGER DEFAULT (unixepoch()),
  last_seen INTEGER DEFAULT (unixepoch()),
  UNIQUE(fp_hash, user_id)
)`,
	`CREATE INDEX IF NOT EXISTS idx_fp_hash ON fingerprints(fp_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_solo_scores_user_id ON solo_scores(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_duel_participants_user_id ON duel_participants(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_duel_round_scores_game_id ON duel_round_scores(game_id)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`,
	`CREATE TABLE IF NOT EXISTS daily_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS daily_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  score INTEGER NOT NULL,
  guessed_x REAL,
  guessed_y REAL,
  distance REAL,
  time_taken REAL,
  hints_used INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, date)
)`,
	`CREATE INDEX IF NOT EXISTS idx_daily_scores_date ON daily_scores(date)`,
	`CREATE TABLE IF NOT EXISTS location_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT,
  image_path TEXT,
  status TEXT DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at INTEGER,
  deny_reason TEXT,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON location_suggestions(status)`,
	`CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT DEFAULT 'other',
  status TEXT DEFAULT 'open',
  reply TEXT,
  replied_by INTEGER REFERENCES users(id),
  replied_at INTEGER,
  user_reply TEXT,
  user_replied_at INTEGER,
  awaiting_staff INTEGER DEFAULT 0,
  close_requested INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  target_username TEXT,
  details TEXT,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`,
	`CREATE TABLE IF NOT EXISTS user_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_username TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_username TEXT,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'staff',
  created_at INTEGER DEFAULT (unixepoch())
)`,
	`CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id)`,
];

for (const sql of SCHEMA_STATEMENTS) {
	try {
		db.exec(sql);
	} catch (err) {
		console.error("[db] Schema statement failed:", err instanceof Error ? err.message : err);
		console.error("[db] Statement:", sql.slice(0, 80));
	}
}

const MIGRATIONS: string[] = [
	"ALTER TABLE users ADD COLUMN current_streak INTEGER DEFAULT 0",
	"ALTER TABLE users ADD COLUMN longest_streak INTEGER DEFAULT 0",
	"ALTER TABLE users ADD COLUMN last_played_date TEXT",
	"ALTER TABLE users ADD COLUMN profile_private INTEGER DEFAULT 0",
	"ALTER TABLE locations ADD COLUMN hints TEXT DEFAULT '[]'",
	"ALTER TABLE support_tickets ADD COLUMN category TEXT DEFAULT 'other'",
	"ALTER TABLE support_tickets ADD COLUMN user_reply TEXT",
	"ALTER TABLE support_tickets ADD COLUMN user_replied_at INTEGER",
	"ALTER TABLE support_tickets ADD COLUMN awaiting_staff INTEGER DEFAULT 0",
	"ALTER TABLE support_tickets ADD COLUMN close_requested INTEGER DEFAULT 0",
	"ALTER TABLE users ADD COLUMN suggestions_agreed INTEGER DEFAULT 0",
	"ALTER TABLE users ADD COLUMN suggestions_agreed_at INTEGER",
	"ALTER TABLE submissions ADD COLUMN hints TEXT DEFAULT '[]'",
	"ALTER TABLE solo_scores ADD COLUMN time_limit INTEGER NOT NULL DEFAULT 90",
	"ALTER TABLE duel_games ADD COLUMN quickplay INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE audit_log ADD COLUMN target_type TEXT",
	"ALTER TABLE audit_log ADD COLUMN target_id INTEGER",
	"ALTER TABLE audit_log ADD COLUMN target_username TEXT",
	"ALTER TABLE audit_log ADD COLUMN details TEXT",
];

for (const sql of MIGRATIONS) {
	try {
		db.exec(sql);
	} catch (err: any) {
		// "duplicate column name" is expected when the column already exists
		if (!err?.message?.includes("duplicate column name")) {
			console.warn("[db] Migration skipped unexpectedly:", err?.message, "-", sql);
		}
	}
}

try {
	const orphans = db
		.query<
			{
				id: number;
				replied_by: number | null;
				replied_at: number | null;
				reply: string | null;
				user_reply: string | null;
				user_replied_at: number | null;
				user_id: number;
			},
			[]
		>(
			"SELECT id, replied_by, replied_at, reply, user_reply, user_replied_at, user_id FROM support_tickets WHERE (reply IS NOT NULL OR user_reply IS NOT NULL)"
		)
		.all();

	const insertReply = db.prepare(
		"INSERT OR IGNORE INTO ticket_replies (ticket_id, author_id, author_username, body, type, created_at) SELECT ?, ?, (SELECT username FROM users WHERE id = ?), ?, ?, ?"
	);
	const clearCols = db.prepare(
		"UPDATE support_tickets SET reply = NULL, replied_by = NULL, replied_at = NULL, user_reply = NULL, user_replied_at = NULL WHERE id = ?"
	);

	for (const t of orphans) {
		if (t.reply) {
			insertReply.run(
				t.id,
				t.replied_by,
				t.replied_by,
				t.reply,
				"staff",
				t.replied_at ?? Math.floor(Date.now() / 1000)
			);
		}
		if (t.user_reply) {
			insertReply.run(
				t.id,
				t.user_id,
				t.user_id,
				t.user_reply,
				"user",
				t.user_replied_at ?? Math.floor(Date.now() / 1000)
			);
		}
		clearCols.run(t.id);
	}
	if (orphans.length > 0) console.log(`[db] Migrated ${orphans.length} legacy ticket reply rows → ticket_replies`);
} catch (err) {
	console.error("[db] Legacy reply migration failed:", err instanceof Error ? err.message : err);
}

export type User = {
	id: number;
	discord_id: string;
	username: string;
	display_name: string | null;
	avatar_url: string | null;
	role: "moderator" | "supervisor" | "operator" | null;
	is_banned: number;
	ban_type: string | null;
	ban_expires_at: number | null;
	upload_limited: number;
	upload_limit_expires_at: number | null;
	duel_limited: number;
	duel_limit_expires_at: number | null;
	current_streak: number;
	longest_streak: number;
	last_played_date: string | null;
	profile_private: number;
	suggestions_agreed: number;
	suggestions_agreed_at: number | null;
	created_at: number;
};

export type Location = {
	id: number;
	image_path: string;
	world_x: number;
	world_y: number;
	label: string | null;
	submitted_by: number | null;
	approved_by: number | null;
	is_active: number;
	hints: string;
	created_at: number;
};

export type Submission = {
	id: number;
	image_path: string;
	world_x: number;
	world_y: number;
	label: string | null;
	submitted_by: number;
	status: "pending" | "approved" | "denied";
	reviewed_by: number | null;
	reviewed_at: number | null;
	deny_reason: string | null;
	created_at: number;
};
