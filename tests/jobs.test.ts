import { describe, expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { UPLOADS_DIR } from "../src/config";
import { db, freeSpaceShare, reclaimFreeSpace } from "../src/db";
import { checkUp, dailyCheckUp } from "../src/jobs/checkup";
import { sweepOrphanedUploads } from "../src/jobs/cleanup";
import { clearLeaderboardCache } from "../src/routes/leaderboard";
import { call, createUser } from "./helpers";

const DAY_MS = 86_400_000;

/** Writes a screenshot-shaped file into the uploads folder, last changed `daysOld` days ago. */
function upload(name: string, daysOld: number) {
	const path = join(UPLOADS_DIR, name);
	writeFileSync(path, "x");
	const when = new Date(Date.now() - daysOld * DAY_MS);
	utimesSync(path, when, when);
	return path;
}

describe("orphaned screenshots", () => {
	test("only old files that nothing points at are removed", async () => {
		const user = createUser();
		const inUse = upload(`${"a".repeat(32)}.webp`, 5);
		const orphan = upload(`${"b".repeat(32)}.webp`, 5);
		const fresh = upload(`${"c".repeat(32)}.webp`, 0);
		const foreign = upload("seed-99.webp", 5);
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES (?, 1, 2, 'Kept', ?)",
			[`${"a".repeat(32)}.webp`, user.id]
		);

		expect(await sweepOrphanedUploads()).toBe(1);
		expect(existsSync(orphan)).toBe(false);
		/** Still referenced, too new to judge, and not one of ours to delete. */
		for (const kept of [inUse, fresh, foreign]) expect(existsSync(kept)).toBe(true);
	});

	test("a folder that looks mostly orphaned is left alone", async () => {
		const files = Array.from({ length: 30 }, (_, i) =>
			upload(`${String(i).padStart(2, "0")}${"d".repeat(30)}.webp`, 5)
		);
		expect(await sweepOrphanedUploads()).toBe(0);
		expect(files.every((file) => existsSync(file))).toBe(true);
	});
});

describe("the daily check-up", () => {
	test("notes what is overdue without bothering staff, and closes duels left open", async () => {
		const user = createUser();
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by, created_at) VALUES ('old.webp', 1, 2, 'Forgotten', ?, unixepoch() - 10 * 86400)",
			[user.id]
		);
		const stuck = db.run(
			"INSERT INTO duel_games (room_code, created_by, status, created_at) VALUES ('STUCK1', ?, 'in_progress', unixepoch() - 7200)",
			[user.id]
		).lastInsertRowid;

		const found = await checkUp(undefined, { updates: false });
		const overdue = found.find((finding) => finding.key === "old_submissions");
		expect(overdue?.text).toContain("waiting for review for over a week");
		expect(overdue?.serious).toBeUndefined();
		expect(found.find((finding) => finding.key === "stuck_duels")?.fixed).toBe(true);
		expect(
			db.query<{ status: string }, [number]>("SELECT status FROM duel_games WHERE id = ?").get(Number(stuck))
				?.status
		).toBe("abandoned");
	});

	test("runs once a day, and tells staff about a serious finding only once", async () => {
		/** A test database has no backups, which is serious. */
		const first = await dailyCheckUp("2026-01-01", { updates: false });
		expect(first.some((finding) => finding.key === "no_backups")).toBe(true);
		expect(await dailyCheckUp("2026-01-01", { updates: false })).toEqual([]);
		const nextDay = await dailyCheckUp("2026-01-02", { updates: false });
		expect(nextDay.some((finding) => finding.key === "no_backups")).toBe(false);
	});
});

describe("database upkeep", () => {
	test("free space is measured, and a small amount is not worth a rewrite", () => {
		expect(freeSpaceShare()).toBeGreaterThanOrEqual(0);
		expect(freeSpaceShare()).toBeLessThan(1);
		expect(reclaimFreeSpace()).toBe(false);
	});
});

describe("the leaderboard cache", () => {
	test("serves the same answer for a few seconds, until cleared", async () => {
		const player = createUser();
		const board = async () =>
			(await call("/api/leaderboard/solo?limit=100&rounds=3&time_limit=30")).data.map(
				(row: { user_id: number }) => row.user_id
			);
		clearLeaderboardCache();
		expect(await board()).not.toContain(player.id);
		db.run(
			"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, 14000, 3, 15000, 30)",
			[player.id]
		);
		expect(await board()).not.toContain(player.id);
		clearLeaderboardCache();
		expect(await board()).toContain(player.id);
	});
});
