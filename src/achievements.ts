import { db } from "./db";
import type { RoundOutcome } from "./game/round";
import { notifyUser } from "./notifications";

export const ACHIEVEMENTS = [
	{ id: "first_game", title: "First Steps", description: "Finish a solo game.", icon: "flag" },
	{ id: "bullseye", title: "Bullseye", description: "Guess within 150 units of the spot.", icon: "my_location" },
	{
		id: "quick_draw",
		title: "Quick Draw",
		description: "Score 4,000 or more with a guess made in under 5 seconds.",
		icon: "bolt",
	},
	{
		id: "last_call",
		title: "Last Call",
		description: "Score 4,000 or more with a guess made in the final 5 seconds.",
		icon: "hourglass_bottom",
	},
	{
		id: "local_expert",
		title: "Local Expert",
		description: "Finish a solo game with at least 80% of the points on offer.",
		icon: "workspace_premium",
	},
	{ id: "daily_first", title: "Daily Commuter", description: "Play a daily challenge.", icon: "today" },
	{ id: "daily_ace", title: "Right on Time", description: "Score 4,500 or more in a daily challenge.", icon: "star" },
	{
		id: "streak_3",
		title: "Regular Service",
		description: "Play three days in a row.",
		icon: "local_fire_department",
	},
	{ id: "streak_7", title: "Season Ticket", description: "Play seven days in a row.", icon: "confirmation_number" },
	{ id: "streak_30", title: "Lifetime Pass", description: "Play thirty days in a row.", icon: "verified" },
	{ id: "duel_win", title: "First Victory", description: "Win a duel.", icon: "swords" },
	{ id: "duel_wins_10", title: "Duelist", description: "Win ten duels.", icon: "military_tech" },
	{
		id: "duel_sweep",
		title: "Clean Sweep",
		description: "Win a duel of three or more rounds by taking every round.",
		icon: "cleaning_services",
	},
	{
		id: "photo_finish",
		title: "Photo Finish",
		description: "Win a duel by fewer than 100 points.",
		icon: "photo_camera",
	},
	{
		id: "return_ticket",
		title: "Return Ticket",
		description: "Win a rematch against the player who just beat you.",
		icon: "replay",
	},
	{
		id: "hot_streak",
		title: "Hot Streak",
		description: "Win 3 Quick Play duels in a row.",
		icon: "rocket_launch",
	},
	{ id: "rating_1200", title: "Rising Star", description: "Reach a duel rating of 1,200.", icon: "trending_up" },
	{
		id: "contributor",
		title: "Cartographer",
		description: "Have a location you submitted added to the game.",
		icon: "add_location_alt",
	},
] as const;

export type AchievementId = (typeof ACHIEVEMENTS)[number]["id"];

const BY_ID = new Map<string, (typeof ACHIEVEMENTS)[number]>(ACHIEVEMENTS.map((a) => [a.id, a]));

export function isAchievement(id: unknown): id is AchievementId {
	return typeof id === "string" && BY_ID.has(id);
}

/** Gives a player an achievement. Returns true when new; they are told unless `quiet`. */
export function award(userId: number | null | undefined, id: AchievementId, { quiet = false } = {}): boolean {
	if (!userId) return false;
	try {
		const added = db.run("INSERT OR IGNORE INTO user_achievements (user_id, key) VALUES (?, ?)", [userId, id]);
		if (!added.changes) return false;
		const achievement = BY_ID.get(id)!;
		if (!quiet) {
			const user = db
				.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?")
				.get(userId);
			notifyUser(userId, "achievements", {
				title: `Achievement unlocked: ${achievement.title}`,
				body: achievement.description,
				link: user ? `/u/${encodeURIComponent(user.username)}#achievements` : undefined,
			});
		}
		return true;
	} catch (err) {
		console.error("[achievements] Could not award", id, err);
		return false;
	}
}

/** The achievements this player has earned but not been shown. Marks them shown. */
export function unseenCount(userId: number): number {
	return (
		db
			.query<{ n: number }, [number]>(
				"SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ? AND seen_at IS NULL"
			)
			.get(userId)?.n ?? 0
	);
}

export function takeUnseen(userId: number) {
	const keys = db
		.query<{ key: string }, [number]>(
			"UPDATE user_achievements SET seen_at = unixepoch() WHERE user_id = ? AND seen_at IS NULL RETURNING key"
		)
		.all(userId)
		.map((row) => row.key);
	return ACHIEVEMENTS.filter((a) => keys.includes(a.id));
}

/**
 * Gives players the achievements their history already earned, marked as seen. Safe to run again. Returns how many.
 */
export function backfillAchievements(): number {
	const give = (id: AchievementId, select: string) =>
		db.run(
			`INSERT OR IGNORE INTO user_achievements (user_id, key, earned_at, seen_at)
			SELECT h.user_id, '${id}', COALESCE(h.earned_at, unixepoch()), unixepoch() FROM (${select}) h
			JOIN users u ON u.id = h.user_id WHERE u.username != '[deleted]'`
		).changes;
	const notTournament = (table: string) =>
		table === "duel_round_scores"
			? "AND game_id NOT IN (SELECT id FROM duel_games WHERE tournament_id IS NOT NULL)"
			: "";
	const close = (table: string) =>
		`SELECT user_id, MIN(created_at) AS earned_at FROM ${table} WHERE distance <= 150 ${notTournament(table)} GROUP BY user_id`;
	const quick = (table: string) =>
		`SELECT user_id, MIN(created_at) AS earned_at FROM ${table} WHERE time_taken < 5 AND score >= 4000 AND distance IS NOT NULL ${notTournament(table)} GROUP BY user_id`;
	const wins = (atLeast: number) =>
		`SELECT winner_id AS user_id, MIN(finished_at) AS earned_at FROM duel_games
		WHERE status = 'finished' AND winner_id IS NOT NULL AND tournament_id IS NULL GROUP BY winner_id HAVING COUNT(*) >= ${atLeast}`;
	const streak = (days: number) =>
		`SELECT id AS user_id, NULL AS earned_at FROM users WHERE longest_streak >= ${days}`;

	let given = 0;
	db.transaction(() => {
		given += give("first_game", "SELECT user_id, MIN(created_at) AS earned_at FROM solo_scores GROUP BY user_id");
		given += give(
			"local_expert",
			"SELECT user_id, MIN(created_at) AS earned_at FROM solo_scores WHERE max_possible > 0 AND CAST(total_score AS REAL) / max_possible >= 0.8 GROUP BY user_id"
		);
		given += give("daily_first", "SELECT user_id, MIN(created_at) AS earned_at FROM daily_scores GROUP BY user_id");
		given += give(
			"daily_ace",
			"SELECT user_id, MIN(created_at) AS earned_at FROM daily_scores WHERE score >= 4500 GROUP BY user_id"
		);
		for (const table of ["daily_scores", "duel_round_scores"]) {
			given += give("bullseye", close(table));
			given += give("quick_draw", quick(table));
		}
		given += give("streak_3", streak(3));
		given += give("streak_7", streak(7));
		given += give("streak_30", streak(30));
		given += give("duel_win", wins(1));
		given += give("duel_wins_10", wins(10));
		given += give(
			"duel_sweep",
			`SELECT dg.winner_id AS user_id, MIN(dg.finished_at) AS earned_at FROM duel_games dg
			WHERE dg.status = 'finished' AND dg.winner_id IS NOT NULL AND dg.tournament_id IS NULL
				AND (SELECT COUNT(*) FROM duel_round_scores w WHERE w.game_id = dg.id AND w.user_id = dg.winner_id) >= 3
				AND NOT EXISTS (
					SELECT 1 FROM duel_round_scores w
					JOIN duel_round_scores o ON o.game_id = w.game_id AND o.round_number = w.round_number AND o.user_id != w.user_id
					WHERE w.game_id = dg.id AND w.user_id = dg.winner_id AND o.score >= w.score
				)
			GROUP BY dg.winner_id`
		);
		given += give(
			"contributor",
			"SELECT submitted_by AS user_id, MIN(created_at) AS earned_at FROM locations WHERE submitted_by IS NOT NULL GROUP BY submitted_by"
		);
		given += give(
			"rating_1200",
			"SELECT id AS user_id, NULL AS earned_at FROM users WHERE COALESCE(duel_rating, 0) >= 1200 AND COALESCE(duel_rated_games, 0) > 0"
		);
	})();
	return given;
}

/** Runs the backfill the first time a server with achievements starts on an existing database. */
export function backfillAchievementsOnce() {
	const KEY = "achievements_backfilled";
	if (db.query("SELECT 1 FROM app_settings WHERE key = ?").get(KEY)) return;
	try {
		const given = backfillAchievements();
		db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [KEY, String(Date.now())]);
		if (given) console.log(`[achievements] Gave ${given} achievements to existing players from their history`);
	} catch (err) {
		console.error("[achievements] Backfill failed; it will be tried again on the next start:", err);
	}
}

export function revoke(userId: number, id: AchievementId): boolean {
	return db.run("DELETE FROM user_achievements WHERE user_id = ? AND key = ?", [userId, id]).changes > 0;
}

export function clearAchievements(userId: number): number {
	return db.run("DELETE FROM user_achievements WHERE user_id = ?", [userId]).changes;
}

export function achievementsFor(userId: number) {
	const earned = new Map(
		db
			.query<{ key: string; earned_at: number }, [number]>(
				"SELECT key, earned_at FROM user_achievements WHERE user_id = ?"
			)
			.all(userId)
			.map((row) => [row.key, row.earned_at])
	);
	return ACHIEVEMENTS.map((a) => ({ ...a, earned_at: earned.get(a.id) ?? null }));
}

/** One scored guess, in any mode. `timeLimit` is the round's clock in seconds, 0 for none. */
export function checkRound(userId: number | null, outcome: RoundOutcome, timeLimit = 0) {
	if (!userId || outcome.distance === null) return;
	if (outcome.distance <= 150) award(userId, "bullseye");
	if (outcome.timeTaken < 5 && outcome.score >= 4000) award(userId, "quick_draw");
	if (timeLimit > 0 && outcome.timeTaken >= timeLimit - 5 && outcome.score >= 4000) award(userId, "last_call");
}

export function checkStreak(userId: number, streak: { longest_streak: number }) {
	if (streak.longest_streak >= 3) award(userId, "streak_3");
	if (streak.longest_streak >= 7) award(userId, "streak_7");
	if (streak.longest_streak >= 30) award(userId, "streak_30");
}

/** A finished solo game. Only a ranked one can earn the score mark. */
export function checkSoloGame(userId: number, totalScore: number, maxPossible: number, ranked: boolean) {
	award(userId, "first_game");
	if (ranked && maxPossible > 0 && totalScore / maxPossible >= 0.8) award(userId, "local_expert");
}

export function checkDaily(userId: number, score: number) {
	award(userId, "daily_first");
	if (score >= 4500) award(userId, "daily_ace");
}

type DuelResult = {
	won: boolean;
	sweep: boolean;
	rating: number | null;
	margin: number;
	/** This was a rematch, and the other player won the duel before it. */
	lostLast: boolean;
	/** Quick Play wins in a row, counting this one. 0 outside Quick Play. */
	streak: number;
};

export function checkDuel(userId: number, { won, sweep, rating, margin, lostLast, streak }: DuelResult) {
	if (won) {
		award(userId, "duel_win");
		const wins = db
			.query<{ n: number }, [number]>(
				"SELECT COUNT(*) AS n FROM duel_games WHERE winner_id = ? AND status = 'finished' AND tournament_id IS NULL"
			)
			.get(userId)!.n;
		if (wins >= 10) award(userId, "duel_wins_10");
		if (sweep) award(userId, "duel_sweep");
		if (margin >= 0 && margin < 100) award(userId, "photo_finish");
		if (lostLast) award(userId, "return_ticket");
		if (streak >= 3) award(userId, "hot_streak");
	}
	if (rating !== null && rating >= 1200) award(userId, "rating_1200");
}
