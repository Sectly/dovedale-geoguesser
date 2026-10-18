import { db, type User } from "./db";
import { distanceScore, type RoundOutcome } from "./game/round";

export type FairplaySignal = keyof typeof SIGNALS;

/** Guesses kept per player, and how many of the newest are looked at. */
const KEEP = 60;
const WINDOW = 40;
/** A guess this good counts as "accurate" for the timing checks. */
const ACCURATE_POINTS = 4000;

const SIGNALS = {
	/** Landing on the exact spot. A screen pixel covers more map than this at most zooms. */
	exact: { withinUnits: 2, needed: 6, differentLocations: 4 },
	/** Accurate before a person could have looked, moved and pressed. */
	instant: { underSeconds: 0.7, needed: 5 },
	/** A run of accurate guesses that each took the same time to within a fraction of a second. */
	clockwork: { run: 12, maxSpreadSeconds: 0.12 },
};

type Logged = { id: number; location_id: number | null; distance: number; time_taken: number; points: number };

/** Records one scored guess and checks the recent ones. Must never break a game. */
export function reviewGuess(userId: number | null, mode: string, locationId: number, outcome: RoundOutcome) {
	if (!userId || outcome.distance === null) return;
	try {
		db.run(
			"INSERT INTO guess_log (user_id, mode, location_id, distance, time_taken, points) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, mode, locationId, outcome.distance, outcome.timeTaken, distanceScore(outcome.distance)]
		);
		db.run(
			"DELETE FROM guess_log WHERE user_id = ?1 AND id <= (SELECT id FROM guess_log WHERE user_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
			[userId, KEEP]
		);
		for (const signal of Object.keys(SIGNALS) as FairplaySignal[]) check(userId, signal);
	} catch (err) {
		console.error("[fairplay] Could not review a guess:", err);
	}
}

function check(userId: number, signal: FairplaySignal) {
	const latest = db
		.query<{ dismissed_at: number | null; upto_guess: number }, [number, string]>(
			"SELECT dismissed_at, upto_guess FROM fairplay_flags WHERE user_id = ? AND signal = ? ORDER BY id DESC LIMIT 1"
		)
		.get(userId, signal);
	if (latest && latest.dismissed_at === null) return;
	const guesses = db
		.query<Logged, [number, number, number]>(
			"SELECT id, location_id, distance, time_taken, points FROM guess_log WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?"
		)
		.all(userId, latest?.upto_guess ?? 0, WINDOW);
	const evidence = EVIDENCE[signal](guesses);
	if (!evidence) return;
	db.run("INSERT INTO fairplay_flags (user_id, signal, evidence, upto_guess) VALUES (?, ?, ?, ?)", [
		userId,
		signal,
		evidence,
		guesses[0].id,
	]);
}

const seconds = (n: number) => `${n.toFixed(2)}s`;

/** For each signal: what was found in these guesses (newest first), in words for staff, or null. */
const EVIDENCE: Record<FairplaySignal, (guesses: Logged[]) => string | null> = {
	exact(guesses) {
		const rule = SIGNALS.exact;
		const hits = guesses.filter((g) => g.distance <= rule.withinUnits);
		const places = new Set(hits.map((g) => g.location_id)).size;
		if (hits.length < rule.needed || places < rule.differentLocations) return null;
		return `${hits.length} of the last ${guesses.length} guesses landed within ${rule.withinUnits} units of the exact spot, on ${places} different locations.`;
	},
	instant(guesses) {
		const rule = SIGNALS.instant;
		const hits = guesses.filter((g) => g.points >= ACCURATE_POINTS && g.time_taken < rule.underSeconds);
		if (hits.length < rule.needed) return null;
		return `${hits.length} of the last ${guesses.length} guesses scored ${ACCURATE_POINTS.toLocaleString()} or more in under ${rule.underSeconds}s (fastest ${seconds(Math.min(...hits.map((g) => g.time_taken)))}).`;
	},
	clockwork(guesses) {
		const rule = SIGNALS.clockwork;
		const run = guesses.slice(0, rule.run);
		if (run.length < rule.run || run.some((g) => g.points < ACCURATE_POINTS)) return null;
		const times = run.map((g) => g.time_taken);
		const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
		const spread = Math.sqrt(times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / times.length);
		if (spread > rule.maxSpreadSeconds) return null;
		return `The last ${rule.run} guesses were all accurate and each took almost exactly ${seconds(mean)} (they vary by ${seconds(spread)}).`;
	},
};

export const FAIRPLAY_LABELS: Record<FairplaySignal, string> = {
	exact: "Exact hits",
	instant: "Instant guesses",
	clockwork: "Identical timing",
};

export function openFairplayFlags(userId: number) {
	return db
		.query<{ id: number; signal: FairplaySignal; evidence: string; created_at: number }, [number]>(
			"SELECT id, signal, evidence, created_at FROM fairplay_flags WHERE user_id = ? AND dismissed_at IS NULL ORDER BY id"
		)
		.all(userId)
		.map((flag) => ({ ...flag, label: FAIRPLAY_LABELS[flag.signal] ?? flag.signal }));
}

/** Clears a flag. Returns it, or null when already dealt with. */
export function dismissFairplayFlag(flagId: number, actor: User) {
	const flag = db
		.query<{ id: number; user_id: number; signal: FairplaySignal }, [number]>(
			"SELECT id, user_id, signal FROM fairplay_flags WHERE id = ? AND dismissed_at IS NULL"
		)
		.get(flagId);
	if (!flag) return null;
	db.run("UPDATE fairplay_flags SET dismissed_at = unixepoch(), dismissed_by = ? WHERE id = ?", [actor.id, flag.id]);
	return flag;
}
