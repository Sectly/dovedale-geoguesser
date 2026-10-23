import { readdirSync, statSync } from "fs";
import { join } from "path";
import { db, maintainDatabase, reclaimFreeSpace } from "../db";
import { sendScheduledAnnouncements } from "../announcements";
import { UPLOADS_DIR } from "../config";
import { sendDueDigests } from "../email";
import { logInfo, pruneLogs } from "../lib/logs";
import { reportProblem } from "../lib/problems";
import { pruneOauthStates } from "../auth/discord";
import { liftExpiredRestrictions } from "../auth/sessions";
import { pruneTournamentChat } from "../game/chat";
import { refreshDueLists, seedDefaultList } from "../game/chat-filter";
import { pruneMatchmaking } from "../game/duels/matchmaking";
import { duelsInProgress, pruneDuelRooms } from "../game/duels/rooms";
import { pruneSoloGames } from "../game/solo";
import { pruneTeamRooms, teamGamesInProgress, tickTeamRooms } from "../game/teams";
import { pruneRateLimits } from "../lib/rate-limit";
import { DAY } from "../lib/time";
import { deleteUpload } from "../lib/uploads";
import { pruneNotifications, sendStreakReminders } from "../notifications";
import { pruneStaffChat } from "../routes/admin/chat";
import { deleteOldClosedTickets } from "../routes/admin/support";
import { pruneLeaderboardCache } from "../routes/leaderboard";
import { pruneOgCache } from "../routes/og";
import { dailyCheckUp } from "./checkup";

const MINUTE_MS = 60 * 1000;

/** How long each kind of record is kept, in days. */
const RETENTION = {
	auditLog: 180,
	fingerprints: 90,
	reviewedSuggestions: 30,
	deniedSubmissions: 30,
	soloScoresPerUser: 200,
	/** Round-by-round detail of a duel. The result itself (who won, the totals) is kept. */
	duelRoundDetail: 180,
	emptyAbandonedDuels: 30,
};

function job(name: string, fn: () => unknown | Promise<unknown>) {
	return async () => {
		try {
			await fn();
		} catch (err) {
			console.error(`[cleanup] ${name} failed:`, err);
			reportProblem(`Scheduled ${name} job failed`, err);
		}
	};
}

/** Keeps each player's newest `keep` solo games, plus their best per rounds and time limit. */
export function trimSoloScores(keep = RETENTION.soloScoresPerUser) {
	db.run(
		`DELETE FROM solo_scores WHERE id IN (
			SELECT id FROM (
				SELECT id,
					ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS recency,
					ROW_NUMBER() OVER (PARTITION BY user_id, rounds, time_limit ORDER BY total_score DESC, id ASC) AS standing
				FROM solo_scores
			) WHERE recency > ? AND standing > 1
		)`,
		[keep]
	);
}

/** In-memory state that would otherwise grow until the next restart. */
const pruneMemory = job("memory", () => {
	pruneOauthStates();
	pruneRateLimits();
	pruneSoloGames();
	pruneDuelRooms();
	pruneMatchmaking();
	pruneTeamRooms();
	pruneOgCache();
	pruneLeaderboardCache();
});

/** Screenshots written by saveUploadedImage; nothing else in the folder is ever touched. */
const UPLOAD_NAME = /^[0-9a-f]{32}\.webp$/;
/** An upload younger than this may still be on its way into the database. */
const ORPHAN_AGE_MS = DAY * 1000;

/** Deletes screenshots nothing points at. Refuses to remove most of the folder at once. */
export async function sweepOrphanedUploads(now = Date.now()): Promise<number> {
	const used = new Set(
		db
			.query<{ image_path: string }, []>(
				`SELECT image_path FROM locations
				UNION SELECT image_path FROM submissions
				UNION SELECT image_path FROM location_suggestions WHERE image_path IS NOT NULL`
			)
			.all()
			.map((row) => row.image_path)
	);
	const ours = readdirSync(UPLOADS_DIR).filter((name) => UPLOAD_NAME.test(name));
	const orphans = ours.filter(
		(name) => !used.has(name) && now - statSync(join(UPLOADS_DIR, name)).mtimeMs > ORPHAN_AGE_MS
	);
	if (orphans.length > 20 && orphans.length > ours.length / 2) {
		console.warn(`[cleanup] ${orphans.length} of ${ours.length} screenshots look orphaned; none were removed`);
		return 0;
	}
	for (const name of orphans) await deleteUpload(name);
	if (orphans.length) logInfo(`[cleanup] Removed ${orphans.length} orphaned screenshot(s)`);
	return orphans.length;
}

/** A separate job, so a failed backup and the cleanup never stop each other. */
const maintain = job("maintenance", () => {
	maintainDatabase();
	if (!duelsInProgress() && !teamGamesInProgress() && reclaimFreeSpace())
		logInfo("[cleanup] Rewrote the database file to hand back free space");
});

const checkUp = job("check-up", () => dailyCheckUp());

const refreshWordLists = job("word lists", () => refreshDueLists());

const pruneDatabase = job("database", async () => {
	db.run("DELETE FROM sessions WHERE expires_at < unixepoch()");
	liftExpiredRestrictions();
	db.run("DELETE FROM daily_attempts WHERE date < date('now', '-2 days')");
	db.run("DELETE FROM audit_log WHERE created_at < unixepoch() - ?", [RETENTION.auditLog * DAY]);
	db.run("DELETE FROM fingerprints WHERE last_seen < unixepoch() - ?", [RETENTION.fingerprints * DAY]);
	trimSoloScores();
	db.run("DELETE FROM duel_round_scores WHERE created_at < unixepoch() - ?", [RETENTION.duelRoundDetail * DAY]);
	db.run(
		`DELETE FROM duel_games WHERE status = 'abandoned' AND created_at < unixepoch() - ?
			AND NOT EXISTS (SELECT 1 FROM duel_round_scores rs WHERE rs.game_id = duel_games.id)`,
		[RETENTION.emptyAbandonedDuels * DAY]
	);
	deleteOldClosedTickets();
	pruneStaffChat();
	pruneTournamentChat();
	pruneNotifications();
	pruneLogs();
	sendStreakReminders();

	db.run("DELETE FROM location_suggestions WHERE status != 'pending' AND reviewed_at < unixepoch() - ?", [
		RETENTION.reviewedSuggestions * DAY,
	]);
	const denied = db
		.query<{ id: number; image_path: string }, [number]>(
			"SELECT id, image_path FROM submissions WHERE status = 'denied' AND reviewed_at < unixepoch() - ?"
		)
		.all(RETENTION.deniedSubmissions * DAY);
	for (const sub of denied) {
		await deleteUpload(sub.image_path);
		db.run("DELETE FROM submissions WHERE id = ?", [sub.id]);
	}
	await sweepOrphanedUploads();
});

export function startCleanupJobs() {
	pruneDatabase().then(maintain).then(checkUp);
	seedDefaultList();
	refreshWordLists();
	setInterval(pruneMemory, 5 * MINUTE_MS);
	setInterval(() => tickTeamRooms(), 1000);
	setInterval(() => pruneDatabase().then(maintain).then(checkUp), 60 * MINUTE_MS);
	setInterval(refreshWordLists, 60 * MINUTE_MS);
	setInterval(() => sendDueDigests().catch((err) => console.error("[email] job failed:", err)), 15 * MINUTE_MS);
	setInterval(sendScheduledAnnouncements, MINUTE_MS);
}
