import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Upgrades a database from the previous release in its own process and checks nothing was lost. */

const ROOT = join(import.meta.dir, "..");
const count = (db: Database, table: string) =>
	db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

function upgradeOldDatabase() {
	const dir = mkdtempSync(join(tmpdir(), "dovedale-upgrade-"));
	const dataDir = join(dir, "data");
	mkdirSync(dataDir);
	const path = join(dataDir, "geoguesser.sqlite");

	const old = new Database(path, { create: true });
	old.exec(require("fs").readFileSync(join(import.meta.dir, "fixtures/schema-v0.sql"), "utf8"));
	/** The fixture's bans and limits were relative to the day it was written; make them so again. */
	old.run("UPDATE users SET ban_expires_at = unixepoch() + 86400 WHERE username = 'carol'");
	old.run("UPDATE users SET ban_expires_at = unixepoch() - 100 WHERE username = 'dave'");
	old.run(
		"UPDATE users SET upload_limit_expires_at = unixepoch() + 3600, duel_limit_expires_at = unixepoch() + 7200 WHERE username = 'erin'"
	);
	const before: Record<string, number> = {};
	for (const { name } of old
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all())
		before[name] = count(old, name);
	old.close();

	const run = () =>
		Bun.spawnSync({
			cmd: [
				process.execPath,
				"-e",
				'await import("./src/db"); (await import("./src/moderation")).migrateLegacyModeration(); (await import("./src/auth/sessions")).liftExpiredRestrictions();',
			],
			cwd: ROOT,
			env: { ...process.env, DATA_DIR: dataDir, UPLOADS_DIR: join(dir, "uploads"), AUTH_DEV: "false" },
			stderr: "pipe",
			stdout: "pipe",
		});
	return { dataDir, path, before, run };
}

describe("upgrading a database from the previous release", () => {
	const upgrade = upgradeOldDatabase();
	const first = upgrade.run();
	const db = new Database(upgrade.path, { readonly: true });

	test("the upgrade runs cleanly and leaves a sound database", () => {
		expect(first.stderr.toString()).toBe("");
		expect(first.exitCode).toBe(0);
		expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("a backup of the old database is taken first", () => {
		const backups = readdirSync(join(upgrade.dataDir, "backups")).filter((f) => f.startsWith("upgrade-v0-"));
		expect(backups).toHaveLength(1);
		const backup = new Database(join(upgrade.dataDir, "backups", backups[0]), { readonly: true });
		expect(count(backup, "user_warnings")).toBe(upgrade.before.user_warnings);
		expect(count(backup, "users")).toBe(upgrade.before.users);
		backup.close();
	});

	test("no player data is lost", () => {
		for (const table of [
			"users",
			"sessions",
			"locations",
			"submissions",
			"solo_scores",
			"duel_games",
			"duel_participants",
			"duel_round_scores",
			"fingerprints",
			"daily_challenges",
			"daily_scores",
			"location_suggestions",
			"support_tickets",
			"audit_log",
		])
			expect([table, count(db, table)]).toEqual([table, upgrade.before[table]]);

		const alice = db.query<Record<string, unknown>, []>("SELECT * FROM users WHERE username = 'alice'").get()!;
		expect(alice).toMatchObject({ discord_id: "1001", current_streak: 3, longest_streak: 7, prefs: null });
		expect(db.query("SELECT 1 FROM sessions WHERE id = 'sess-alice'").get()).not.toBeNull();
	});

	test("tables and columns added since are there, and the database is marked as upgraded", () => {
		for (const table of [
			"staff_notes",
			"staff_chat",
			"guess_log",
			"fairplay_flags",
			"location_stats",
			"announcements",
		])
			expect([table, count(db, table) >= 0]).toEqual([table, true]);
		const columns = db.query<{ name: string }, []>("PRAGMA table_info(location_stats)").all();
		expect(columns.map((column) => column.name)).toContain("recent_sum");
		expect(
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
		).toBeGreaterThanOrEqual(3);
	});

	test("old warnings, bans and limits become moderation history", () => {
		const actions = db
			.query<{ username: string; type: string; reason: string }, []>(
				"SELECT u.username, m.type, m.reason FROM moderation_actions m JOIN users u ON u.id = m.user_id ORDER BY u.username, m.type, m.id"
			)
			.all()
			.map((a) => `${a.username}:${a.type}`);
		expect(actions).toEqual([
			"alice:warning",
			"alice:warning",
			"bob:ban_perm",
			"carol:ban_temp",
			"erin:limit_duel",
			"erin:limit_upload",
			"erin:warning",
		]);
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'user_warnings'").get()).toBeNull();
		const banned = db
			.query<{ username: string }, []>("SELECT username FROM users WHERE is_banned = 1 ORDER BY 1")
			.all();
		expect(banned.map((u) => u.username)).toEqual(["bob", "carol"]);
	});

	test("old single-reply tickets become a thread", () => {
		const replies = db
			.query<{ body: string; type: string }, []>(
				"SELECT r.body, r.type FROM ticket_replies r JOIN support_tickets t ON t.id = r.ticket_id WHERE t.subject = 'Legacy ticket' ORDER BY r.created_at"
			)
			.all();
		expect(replies).toEqual([
			{ body: "We will look", type: "staff" },
			{ body: "thanks, any news?", type: "user" },
		]);
	});

	test("starting again changes nothing and takes no second backup", () => {
		const actionsBefore = count(db, "moderation_actions");
		const second = upgrade.run();
		expect(second.exitCode).toBe(0);
		expect(count(db, "moderation_actions")).toBe(actionsBefore);
		expect(readdirSync(join(upgrade.dataDir, "backups")).filter((f) => f.startsWith("upgrade-"))).toHaveLength(1);
	});
});
