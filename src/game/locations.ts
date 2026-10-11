import { db, type Location } from "../db";
import { LIMITS } from "../config";

/** Hints are stored as a JSON array of strings; tolerate anything else. */
export function parseHints(raw: string | null | undefined): string[] {
	try {
		const parsed = JSON.parse(raw || "[]");
		return Array.isArray(parsed) ? parsed.filter((h) => typeof h === "string" && h) : [];
	} catch {
		return [];
	}
}

/** Cleans a hint list from untrusted input (an array, or a JSON string holding one). */
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

/**
 * Picks up to `count` active locations for a game. Picks are spread out across the map
 * (each new pick favours spots far from the ones already chosen) and locations seen
 * recently in dailies or duels are less likely to come up.
 */
export function pickLocations(count: number): Location[] {
	const pool = db.query<Location, []>("SELECT * FROM locations WHERE is_active = 1").all();
	if (pool.length <= count) return shuffle(pool);

	const recentDaily = recentIds("SELECT location_id FROM daily_challenges WHERE date >= date('now', '-3 days')");
	const recentDuels = recentIds(
		"SELECT DISTINCT location_id FROM duel_round_scores WHERE created_at > unixepoch() - 7 * 86400"
	);
	const freshness = (loc: Location) => (recentDaily.has(loc.id) ? 0.25 : 1) * (recentDuels.has(loc.id) ? 0.5 : 1);

	const picked: Location[] = [];
	const remaining = [...pool];
	while (picked.length < count && remaining.length > 0) {
		let weights = remaining.map((candidate) => {
			if (picked.length === 0) return freshness(candidate);
			const nearest = Math.min(
				...picked.map((p) => Math.hypot(candidate.world_x - p.world_x, candidate.world_y - p.world_y))
			);
			return nearest * nearest * freshness(candidate);
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
