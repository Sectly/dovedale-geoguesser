import { db, type Location } from "../db";
import { GAME, LIMITS } from "../config";

/** Hints are stored as a JSON array of strings; tolerate anything else. */
export function parseHints(raw: string | null | undefined): string[] {
	try {
		const parsed = JSON.parse(raw || "[]");
		return Array.isArray(parsed) ? parsed.filter((h) => typeof h === "string" && h) : [];
	} catch {
		return [];
	}
}

export function cleanHints(input: unknown): string[] {
	let list: unknown = input;
	if (typeof input === "string") {
		try {
			list = JSON.parse(input || "[]");
		} catch {
			return [];
		}
	}
	if (!Array.isArray(list)) return [];
	return list
		.map((h) => String(h).trim().slice(0, LIMITS.hintLength))
		.filter(Boolean)
		.slice(0, LIMITS.hintsPerLocation);
}

function shuffle<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

function recentIds(sql: string): Set<number> {
	return new Set(
		db
			.query<{ location_id: number }, []>(sql)
			.all()
			.map((r) => r.location_id)
	);
}

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** `recentSum` holds at most `window` guesses of scores: each new guess pushes out one of the old average. */
function grade(plays: number, recentSum: number): Difficulty | null {
	if (plays < GAME.difficulty.minPlays) return null;
	const average = recentSum / Math.min(plays, GAME.difficulty.window);
	return average >= GAME.difficulty.easyFrom ? "easy" : average < GAME.difficulty.hardBelow ? "hard" : "medium";
}

/** Adds one real guess to a location's record. `score` is the distance score alone. */
export function recordLocationPlay(locationId: number, score: number) {
	try {
		db.run(
			`INSERT INTO location_stats (location_id, plays, score_sum, recent_sum) VALUES (?1, 1, ?2, ?2)
			ON CONFLICT(location_id) DO UPDATE SET
				recent_sum = CASE WHEN plays >= ?3 THEN recent_sum * (?3 - 1.0) / ?3 ELSE recent_sum END + excluded.score_sum,
				plays = plays + 1, score_sum = score_sum + excluded.score_sum, updated_at = unixepoch()`,
			[locationId, score, GAME.difficulty.window]
		);
	} catch (err) {
		console.error("[locations] Could not record a play:", err);
	}
}

export function difficultyOf(locationId: number): Difficulty | null {
	const row = db
		.query<{ plays: number; recent_sum: number }, [number]>(
			"SELECT plays, recent_sum FROM location_stats WHERE location_id = ?"
		)
		.get(locationId);
	return row ? grade(row.plays, row.recent_sum) : null;
}

function gradedLocations(): Map<number, Difficulty> {
	const graded = new Map<number, Difficulty>();
	for (const row of db
		.query<{ location_id: number; plays: number; recent_sum: number }, []>(
			"SELECT s.location_id, s.plays, s.recent_sum FROM location_stats s JOIN locations l ON l.id = s.location_id WHERE l.is_active = 1"
		)
		.all()) {
		const difficulty = grade(row.plays, row.recent_sum);
		if (difficulty) graded.set(row.location_id, difficulty);
	}
	return graded;
}

export function difficultyCounts(): Record<Difficulty, number> {
	const counts = { easy: 0, medium: 0, hard: 0 };
	for (const difficulty of gradedLocations().values()) counts[difficulty]++;
	return counts;
}

export function resetLocationStats(locationId: number) {
	db.run("DELETE FROM location_stats WHERE location_id = ?", [locationId]);
}

/** Up to `count` active locations, spread out. Recent ones are less likely, ungraded ones more. */
export function pickLocations(count: number, difficulty: Difficulty | null = null): Location[] {
	let pool = db.query<Location, []>("SELECT * FROM locations WHERE is_active = 1").all();
	const graded = gradedLocations();
	if (difficulty) pool = pool.filter((location) => graded.get(location.id) === difficulty);
	if (pool.length <= count) return shuffle(pool);

	const recentDaily = recentIds("SELECT location_id FROM daily_challenges WHERE date >= date('now', '-3 days')");
	const recentDuels = recentIds(
		"SELECT DISTINCT location_id FROM duel_round_scores WHERE created_at > unixepoch() - 7 * 86400"
	);
	const { spreadRange, ungradedBoost } = GAME.picking;
	const freshness = (loc: Location) =>
		(recentDaily.has(loc.id) ? 0.25 : 1) *
		(recentDuels.has(loc.id) ? 0.5 : 1) *
		(graded.has(loc.id) ? 1 : ungradedBoost);

	const picked: Location[] = [];
	const remaining = [...pool];
	while (picked.length < count && remaining.length > 0) {
		let weights = remaining.map((candidate) => {
			if (picked.length === 0) return freshness(candidate);
			const nearest = Math.min(
				...picked.map((p) => Math.hypot(candidate.world_x - p.world_x, candidate.world_y - p.world_y))
			);
			return Math.min(nearest, spreadRange) ** 2 * freshness(candidate);
		});
		let total = weights.reduce((a, b) => a + b, 0);
		if (total <= 0) {
			weights = weights.map(() => 1);
			total = weights.length;
		}

		let r = Math.random() * total;
		let chosen = weights.length - 1;
		for (let i = 0; i < weights.length; i++) {
			r -= weights[i];
			if (r <= 0) {
				chosen = i;
				break;
			}
		}
		picked.push(remaining.splice(chosen, 1)[0]);
	}
	return shuffle(picked);
}
