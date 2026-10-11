import { db, maintainDatabase } from "../db";
import { pruneLogs } from "../lib/logs";
import { reportProblem } from "../lib/problems";
import { pruneOauthStates } from "../auth/discord";
import { liftExpiredRestrictions } from "../auth/sessions";
import { pruneMatchmaking } from "../game/duels/matchmaking";
import { pruneDuelRooms } from "../game/duels/rooms";
import { pruneSoloGames } from "../game/solo";
import { pruneTeamRooms, tickTeamRooms } from "../game/teams";
import { pruneRateLimits } from "../lib/rate-limit";
import { DAY } from "../lib/time";
import { deleteUpload } from "../lib/uploads";
import { pruneNotifications, sendStreakReminders } from "../notifications";
import { deleteOldClosedTickets } from "../routes/admin/support";
import { pruneOgCache } from "../routes/og";

const MINUTE_MS = 60 * 1000;

/** How long each kind of record is kept, in days. */
const RETENTION = {
	auditLog: 180,
	fingerprints: 90,
	reviewedSuggestions: 30,
	deniedSubmissions: 30,
	soloScoresPerUser: 200,
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

/** In-memory state that would otherwise grow until the next restart. */
const pruneMemory = job("memory", () => {
	pruneOauthStates();
	pruneRateLimits();
	pruneSoloGames();
	pruneDuelRooms();
	pruneMatchmaking();
	pruneTeamRooms();
	pruneOgCache();
});

/** Runs on its own so a failed backup never stops the rest of the cleanup, and the other way round. */
const maintain = job("maintenance", () => maintainDatabase());

const pruneDatabase = job("database", async () => {
	db.run("DELETE FROM sessions WHERE expires_at < unixepoch()");
	liftExpiredRestrictions();
	db.run("DELETE FROM daily_attempts WHERE date < date('now', '-2 days')");
	db.run("DELETE FROM audit_log WHERE created_at < unixepoch() - ?", [RETENTION.auditLog * DAY]);
	db.run("DELETE FROM fingerprints WHERE last_seen < unixepoch() - ?", [RETENTION.fingerprints * DAY]);
	db.run(
		`DELETE FROM solo_scores WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS n FROM solo_scores
			) WHERE n > ?
		)`,
		[RETENTION.soloScoresPerUser]
	);
	// Duels cut off by a restart before a single round was scored are just empty rows.
	db.run(
		`DELETE FROM duel_games WHERE status = 'abandoned' AND created_at < unixepoch() - ?
			AND NOT EXISTS (SELECT 1 FROM duel_round_scores rs WHERE rs.game_id = duel_games.id)`,
		[RETENTION.emptyAbandonedDuels * DAY]
	);
	deleteOldClosedTickets();
	pruneNotifications();
	pruneLogs();
	sendStreakReminders();

	// Denied suggestions already had their image removed; approved ones gave theirs to the location.
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
});

export function startCleanupJobs() {
	pruneDatabase().then(maintain);
	setInterval(pruneMemory, 5 * MINUTE_MS);
	setInterval(() => tickTeamRooms(), 1000);
	setInterval(() => pruneDatabase().then(maintain), 60 * MINUTE_MS);
}
