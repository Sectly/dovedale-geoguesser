import { db } from "../db";
import { utcDate } from "../lib/time";

export type Streak = { current_streak: number; longest_streak: number };

/** SQL for a user's live streak: 0 once a day has been missed, even before the stored counter updates. */
export function currentStreakSql(alias = "u"): string {
	return `CASE WHEN ${alias}.last_played_date >= date('now', '-1 day') THEN COALESCE(${alias}.current_streak, 0) ELSE 0 END`;
}

export function getStreak(userId: number): Streak {
	return (
		db
			.query<Streak, [number]>(
				`SELECT ${currentStreakSql()} AS current_streak, COALESCE(u.longest_streak, 0) AS longest_streak FROM users u WHERE u.id = ?`
			)
			.get(userId) ?? { current_streak: 0, longest_streak: 0 }
	);
}

/** Counts today as played and returns the updated streak. Safe to call more than once a day. */
export function recordPlay(userId: number): Streak {
	const user = db
		.query<
			{ current_streak: number | null; longest_streak: number | null; last_played_date: string | null },
			[number]
		>("SELECT current_streak, longest_streak, last_played_date FROM users WHERE id = ?")
		.get(userId);
	if (!user) return { current_streak: 0, longest_streak: 0 };

	const today = utcDate();
	if (user.last_played_date !== today) {
		const streak = user.last_played_date === utcDate(-1) ? (user.current_streak || 0) + 1 : 1;
		db.run("UPDATE users SET current_streak = ?, longest_streak = ?, last_played_date = ? WHERE id = ?", [
			streak,
			Math.max(streak, user.longest_streak || 0),
			today,
			userId,
		]);
	}
	return getStreak(userId);
}
