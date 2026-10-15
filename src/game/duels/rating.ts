import { db } from "../../db";
import { GAME } from "../../config";

/** Duel ratings: Elo, Quick Play only. Each change is stored with the game so voiding can undo it. */

export type RatingChange = { user_id: number; rating: number; change: number };

export type Rated = { id: number; duel_rating: number | null; duel_rated_games: number | null };

export const ratingOf = (user: { duel_rating?: number | null }) => user.duel_rating ?? GAME.rating.start;

export function expectedScore(own: number, other: number): number {
	return 1 / (1 + 10 ** ((other - own) / 400));
}

export function getRated(userId: number): Rated | null {
	return db.query<Rated, [number]>("SELECT id, duel_rating, duel_rated_games FROM users WHERE id = ?").get(userId);
}

/** The rating a player would have after one result against `other`: 1 a win, 0.5 a tie, 0 a loss. */
function ratingAfter(player: Rated, other: Rated, result: number): number {
	/** New players move quickly towards where they belong, then settle. */
	const k = (player.duel_rated_games ?? 0) < GAME.rating.provisionalGames ? GAME.rating.kProvisional : GAME.rating.k;
	const before = ratingOf(player);
	return Math.max(GAME.rating.floor, Math.round(before + k * (result - expectedScore(before, ratingOf(other)))));
}

export function ratingStakes(own: Rated, other: Rated): { win: number; loss: number } {
	const before = ratingOf(own);
	return { win: ratingAfter(own, other, 1) - before, loss: ratingAfter(own, other, 0) - before };
}

/** How many Quick Play duels a player has won in a row, newest first. A tie or a loss ends the run. */
export function winStreak(userId: number): number {
	const recent = db
		.query<{ winner_id: number | null }, [number]>(
			`SELECT g.winner_id FROM duel_games g JOIN duel_participants p ON p.game_id = g.id
			WHERE p.user_id = ? AND g.quickplay = 1 AND g.status = 'finished'
			ORDER BY g.finished_at DESC, g.id DESC LIMIT 50`
		)
		.all(userId);
	const ended = recent.findIndex((game) => game.winner_id !== userId);
	return ended < 0 ? recent.length : ended;
}

/** Rates one duel (`winnerId` null for a tie). Returns each player's new rating and change, or null. */
export function rateDuel(gameId: number, playerIds: number[], winnerId: number | null): RatingChange[] | null {
	if (playerIds.length !== 2) return null;
	const players = playerIds.map(getRated);
	if (players.some((p) => !p)) return null;
	const [a, b] = players as Rated[];

	const changes = [a, b].map((player, i) => {
		const other = i === 0 ? b : a;
		const result = winnerId === null ? 0.5 : winnerId === player.id ? 1 : 0;
		const after = ratingAfter(player, other, result);
		return { user_id: player.id, rating: after, change: after - ratingOf(player) };
	});

	db.transaction(() => {
		for (const c of changes) {
			db.run(
				"UPDATE users SET duel_rating = ?, duel_rated_games = COALESCE(duel_rated_games, 0) + 1 WHERE id = ?",
				[c.rating, c.user_id]
			);
			db.run("UPDATE duel_participants SET rating_change = ? WHERE game_id = ? AND user_id = ?", [
				c.change,
				gameId,
				c.user_id,
			]);
		}
	})();
	return changes;
}

/** Hands back what a duel did to its players' ratings. Call it before the game is deleted. */
export function unrateDuel(gameId: number) {
	const rows = db
		.query<{ user_id: number; rating_change: number }, [number]>(
			"SELECT user_id, rating_change FROM duel_participants WHERE game_id = ? AND rating_change IS NOT NULL"
		)
		.all(gameId);
	for (const row of rows) {
		db.run(
			`UPDATE users SET duel_rating = MAX(?, COALESCE(duel_rating, ?) - ?),
				duel_rated_games = MAX(0, COALESCE(duel_rated_games, 0) - 1) WHERE id = ?`,
			[GAME.rating.floor, GAME.rating.start, row.rating_change, row.user_id]
		);
	}
}

export function resetRating(userId: number) {
	db.run("UPDATE users SET duel_rating = ?, duel_rated_games = 0 WHERE id = ?", [GAME.rating.start, userId]);
}
