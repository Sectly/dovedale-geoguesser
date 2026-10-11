-- Schema and sample data as left by the release before the restructure (schema v0).
-- Used by tests/migration.test.ts to prove an old database upgrades without losing anything.

CREATE TABLE users (
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
, suggestions_agreed INTEGER DEFAULT 0, suggestions_agreed_at INTEGER);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE locations (
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
);
CREATE TABLE submissions (
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
, hints TEXT DEFAULT '[]');
CREATE TABLE solo_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_score INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  max_possible INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
, time_limit INTEGER NOT NULL DEFAULT 90);
CREATE TABLE duel_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT UNIQUE NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 5,
  status TEXT DEFAULT 'waiting',
  created_by INTEGER NOT NULL REFERENCES users(id),
  winner_id INTEGER REFERENCES users(id),
  created_at INTEGER DEFAULT (unixepoch()),
  finished_at INTEGER
, quickplay INTEGER NOT NULL DEFAULT 0);
CREATE TABLE duel_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES duel_games(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_score INTEGER DEFAULT 0,
  joined_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(game_id, user_id)
);
CREATE TABLE duel_round_scores (
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
);
CREATE TABLE fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fp_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen INTEGER DEFAULT (unixepoch()),
  last_seen INTEGER DEFAULT (unixepoch()),
  UNIQUE(fp_hash, user_id)
);
CREATE TABLE daily_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE daily_scores (
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
);
CREATE TABLE location_suggestions (
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
);
CREATE TABLE support_tickets (
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
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  target_username TEXT,
  details TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE user_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_username TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author_username TEXT,
  body TEXT NOT NULL,
  type TEXT DEFAULT 'staff',
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_fp_hash ON fingerprints(fp_hash);
CREATE INDEX idx_solo_scores_user_id ON solo_scores(user_id);
CREATE INDEX idx_duel_participants_user_id ON duel_participants(user_id);
CREATE INDEX idx_duel_round_scores_game_id ON duel_round_scores(game_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_daily_scores_date ON daily_scores(date);
CREATE INDEX idx_suggestions_status ON location_suggestions(status);
CREATE INDEX idx_audit_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_ticket_replies_ticket ON ticket_replies(ticket_id);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);

INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (1, '1001', 'alice', 'ALICE', 'https://cdn.discordapp.com/a.png', NULL, 0, NULL, NULL, 0, NULL, 0, NULL, 3, 7, '2026-10-10', 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (2, '1002', 'bob', 'BOB', 'https://cdn.discordapp.com/a.png', NULL, 1, 'perm', NULL, 0, NULL, 0, NULL, 0, 0, NULL, 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (3, '1003', 'carol', 'CAROL', 'https://cdn.discordapp.com/a.png', NULL, 1, 'temp', 1791818860, 0, NULL, 0, NULL, 0, 0, NULL, 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (4, '1004', 'dave', 'DAVE', 'https://cdn.discordapp.com/a.png', NULL, 1, 'temp', 1791732360, 0, NULL, 0, NULL, 0, 0, NULL, 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (5, '1005', 'erin', 'ERIN', 'https://cdn.discordapp.com/a.png', NULL, 0, NULL, NULL, 1, 1791736060, 1, 1791739660, 0, 0, NULL, 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (6, '1006', 'modmax', 'MODMAX', 'https://cdn.discordapp.com/a.png', 'moderator', 0, NULL, NULL, 0, NULL, 0, NULL, 0, 0, NULL, 0, 1791732460, 0, NULL);
INSERT INTO users (id, discord_id, username, display_name, avatar_url, role, is_banned, ban_type, ban_expires_at, upload_limited, upload_limit_expires_at, duel_limited, duel_limit_expires_at, current_streak, longest_streak, last_played_date, profile_private, created_at, suggestions_agreed, suggestions_agreed_at) VALUES (7, '1007', 'priv', 'PRIV', 'https://cdn.discordapp.com/a.png', NULL, 0, NULL, NULL, 0, NULL, 0, NULL, 4, 9, '2026-10-11', 1, 1791732460, 1, 1791732460);
INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('sess-alice', 1, 1791818860, 1791732460);
INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('sess-bob', 2, 1791818860, 1791732460);
INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('sess-mod', 6, 1791818860, 1791732460);
INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('sess-dave', 4, 1791818860, 1791732460);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (1, 'loc1.webp', -8000, 500, 'Old location 1', '["near the bridge"]', 1, 6, 1, 1791732490);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (2, 'loc2.webp', -7000, 1000, 'Old location 2', '[]', 1, 6, 1, 1791732490);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (3, 'loc3.webp', -6000, 1500, 'Old location 3', '["near the bridge"]', 1, 6, 1, 1791732490);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (4, 'loc4.webp', -5000, 2000, 'Old location 4', '[]', 1, 6, 1, 1791732490);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (5, 'loc5.webp', -4000, 2500, 'Old location 5', '["near the bridge"]', 1, 6, 1, 1791732490);
INSERT INTO locations (id, image_path, world_x, world_y, label, hints, submitted_by, approved_by, is_active, created_at) VALUES (6, 'loc6.webp', -3000, 3000, 'Old location 6', '[]', 1, 6, 0, 1791732490);
INSERT INTO submissions (id, image_path, world_x, world_y, label, submitted_by, status, reviewed_by, reviewed_at, deny_reason, created_at, hints) VALUES (1, 'sub1.webp', 10, 20, 'Pending one', 1, 'pending', NULL, NULL, NULL, 1791732490, '["h"]');
INSERT INTO submissions (id, image_path, world_x, world_y, label, submitted_by, status, reviewed_by, reviewed_at, deny_reason, created_at, hints) VALUES (2, 'sub2.webp', 10, 20, 'Denied one', 5, 'denied', 6, 1791731990, 'blurry', 1791732490, '[]');
INSERT INTO submissions (id, image_path, world_x, world_y, label, submitted_by, status, reviewed_by, reviewed_at, deny_reason, created_at, hints) VALUES (3, 'loc1.webp', 10, 20, 'Approved one', 1, 'approved', 6, 1791731590, NULL, 1791732490, '[]');
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (1, 1, 3000, 5, 25000, 1791732490, 0);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (2, 2, 3811, 5, 25000, 1791732490, 30);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (3, 7, 4622, 5, 25000, 1791732490, 60);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (4, 1, 5433, 5, 25000, 1791732490, 90);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (5, 2, 6244, 5, 25000, 1791732490, 120);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (6, 7, 7055, 5, 25000, 1791732490, 0);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (7, 1, 7866, 5, 25000, 1791732490, 30);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (8, 2, 8677, 5, 25000, 1791732490, 60);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (9, 7, 9488, 5, 25000, 1791732490, 90);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (10, 1, 10299, 5, 25000, 1791732490, 120);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (11, 2, 11110, 5, 25000, 1791732490, 0);
INSERT INTO solo_scores (id, user_id, total_score, rounds, max_possible, created_at, time_limit) VALUES (12, 7, 11921, 5, 25000, 1791732490, 30);
INSERT INTO duel_games (id, room_code, rounds, status, created_by, winner_id, created_at, finished_at, quickplay) VALUES (1, 'ABC123', 3, 'finished', 1, 1, 1791732490, 1791732440, 0);
INSERT INTO duel_games (id, room_code, rounds, status, created_by, winner_id, created_at, finished_at, quickplay) VALUES (2, 'LIVE01', 5, 'in_progress', 1, NULL, 1791732490, NULL, 1);
INSERT INTO duel_games (id, room_code, rounds, status, created_by, winner_id, created_at, finished_at, quickplay) VALUES (3, 'WAIT01', 5, 'waiting', 7, NULL, 1791732490, NULL, 0);
INSERT INTO duel_participants (id, game_id, user_id, total_score, joined_at) VALUES (1, 1, 1, 9001, 1791732490);
INSERT INTO duel_participants (id, game_id, user_id, total_score, joined_at) VALUES (2, 1, 7, 9007, 1791732490);
INSERT INTO duel_participants (id, game_id, user_id, total_score, joined_at) VALUES (3, 2, 1, 0, 1791732490);
INSERT INTO duel_participants (id, game_id, user_id, total_score, joined_at) VALUES (4, 2, 5, 0, 1791732490);
INSERT INTO duel_participants (id, game_id, user_id, total_score, joined_at) VALUES (5, 3, 7, 0, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (1, 1, 1, 1, 2, 100, 200, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (2, 1, 7, 1, 2, 100, 200, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (3, 1, 1, 2, 3, 100, 200, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (4, 1, 7, 2, 3, 100, 200, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (5, 1, 1, 3, 4, 100, 200, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO duel_round_scores (id, game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score, created_at) VALUES (6, 1, 7, 3, 4, NULL, NULL, 1234.5, 12.3, 3000, 1791732490);
INSERT INTO fingerprints (id, fp_hash, user_id, first_seen, last_seen) VALUES (1, 'abababababababababababababababab', 1, 1791732490, 1791732490);
INSERT INTO fingerprints (id, fp_hash, user_id, first_seen, last_seen) VALUES (2, 'abababababababababababababababab', 2, 1791732490, 1791732490);
INSERT INTO daily_challenges (id, date, location_id, created_at) VALUES (1, '2026-10-11', 1, 1791732490);
INSERT INTO daily_challenges (id, date, location_id, created_at) VALUES (2, '2026-10-10', 2, 1791732490);
INSERT INTO daily_scores (id, user_id, date, score, guessed_x, guessed_y, distance, time_taken, hints_used, created_at) VALUES (1, 1, '2026-10-10', 4100, 1, 2, 900, 33.3, 1, 1791732490);
INSERT INTO daily_scores (id, user_id, date, score, guessed_x, guessed_y, distance, time_taken, hints_used, created_at) VALUES (2, 7, '2026-10-11', 3900, 1, 2, 900, 20, 0, 1791732490);
INSERT INTO daily_scores (id, user_id, date, score, guessed_x, guessed_y, distance, time_taken, hints_used, created_at) VALUES (3, 2, '2026-10-10', 0, NULL, NULL, NULL, NULL, 0, 1791732490);
INSERT INTO location_suggestions (id, location_id, user_id, type, content, image_path, status, reviewed_by, reviewed_at, deny_reason, created_at) VALUES (1, 1, 7, 'hint', '{"hint":"by the signal box"}', NULL, 'pending', NULL, NULL, NULL, 1791732490);
INSERT INTO location_suggestions (id, location_id, user_id, type, content, image_path, status, reviewed_by, reviewed_at, deny_reason, created_at) VALUES (2, 2, 7, 'image', '{}', 'sug1.webp', 'denied', 6, 1791732390, 'worse', 1791732490);
INSERT INTO location_suggestions (id, location_id, user_id, type, content, image_path, status, reviewed_by, reviewed_at, deny_reason, created_at) VALUES (3, 3, 7, 'position', '{"x":5,"y":6,"note":"off"}', NULL, 'pending', NULL, NULL, NULL, 1791732490);
INSERT INTO support_tickets (id, user_id, subject, message, category, status, reply, replied_by, replied_at, user_reply, user_replied_at, awaiting_staff, close_requested, created_at) VALUES (1, 2, 'Legacy ticket', 'I was banned and want to appeal please', 'ban_appeal', 'open', 'We will look', 6, 1791732190, 'thanks, any news?', 1791732290, 1, 0, 1791732490);
INSERT INTO support_tickets (id, user_id, subject, message, category, status, reply, replied_by, replied_at, user_reply, user_replied_at, awaiting_staff, close_requested, created_at) VALUES (2, 1, 'Thread ticket', 'Something about my account is wrong', 'account', 'open', NULL, NULL, NULL, NULL, NULL, 0, 0, 1791732490);
INSERT INTO support_tickets (id, user_id, subject, message, category, status, reply, replied_by, replied_at, user_reply, user_replied_at, awaiting_staff, close_requested, created_at) VALUES (3, 1, 'Closed ticket', 'This one is closed and done with now', 'other', 'closed', NULL, NULL, NULL, NULL, NULL, 0, 1, 1791732490);
INSERT INTO audit_log (id, actor_id, actor_username, action, target_type, target_id, target_username, details, created_at) VALUES (1, 6, 'modmax', 'user_ban', 'user', 2, 'bob', 'perm', 1791732490);
INSERT INTO audit_log (id, actor_id, actor_username, action, target_type, target_id, target_username, details, created_at) VALUES (2, NULL, NULL, 'user_login', NULL, NULL, NULL, NULL, 1791732490);
INSERT INTO user_warnings (id, user_id, issued_by, issued_by_username, reason, created_at) VALUES (1, 1, 6, 'modmax', 'Be nicer in tickets', 1791727490);
INSERT INTO user_warnings (id, user_id, issued_by, issued_by_username, reason, created_at) VALUES (2, 5, NULL, NULL, 'x', 1791732490);
INSERT INTO user_warnings (id, user_id, issued_by, issued_by_username, reason, created_at) VALUES (3, 1, 6, 'modmax', 'Second warning for alice', 1791732490);
INSERT INTO ticket_replies (id, ticket_id, author_id, author_username, body, type, created_at) VALUES (1, 2, 6, 'modmax', 'Looking into it', 'staff', 1791732490);
INSERT INTO ticket_replies (id, ticket_id, author_id, author_username, body, type, created_at) VALUES (2, 2, 1, 'alice', 'thank you', 'user', 1791732490);
