import { randomBytes } from "crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { db, type Location } from "../db";
import { DATA_DIR, GAME } from "../config";
import { fail } from "../lib/http";
import { checkRound, checkSoloGame, checkStreak } from "../achievements";
import { reviewGuess } from "../fairplay";
import { pickLocations, type Difficulty } from "./locations";
import { Round, SOLO_RULES, outcomeJson, recordOutcome, type Guess, type RoundOutcome, type RoundRules } from "./round";
import { recordPlay, type Streak } from "./streaks";

/** Solo games live in memory and are scored on the server, so the answer never reaches the browser first. */

type SoloGame = {
	id: string;
	userId: number | null;
	timeLimit: number;
	rules: RoundRules;
	/** Set for a Specials mode: played for fun, never saved to the leaderboard. */
	special: string | null;
	/** Set when the player asked for only easy, medium or hard locations: practice, never ranked. */
	difficulty?: Difficulty | null;
	locations: Location[];
	round: Round | null;
	outcomes: RoundOutcome[];
	touchedAt: number;
};

const games = new Map<string, SoloGame>();
const MAX_GAMES = 5000;
const IDLE_TTL_MS = 3 * 60 * 60 * 1000;

export function pruneSoloGames() {
	const cutoff = Date.now() - IDLE_TTL_MS;
	for (const [id, game] of games) {
		if (game.touchedAt < cutoff) games.delete(id);
	}
}

export function dropSoloGames(userId: number) {
	for (const [id, game] of games) {
		if (game.userId === userId) games.delete(id);
	}
}

/** A game with no action for this long has most likely been walked away from. */
const ACTIVE_MS = 10 * 60 * 1000;

/** Solo games being played now. Abandoned ones linger until they expire and do not count. */
export function activeSoloGames(): number {
	const cutoff = Date.now() - ACTIVE_MS;
	let active = 0;
	for (const game of games.values()) if (game.touchedAt >= cutoff) active++;
	return active;
}

export function soloGamesHeld(): number {
	return games.size;
}

function roundJson(game: SoloGame) {
	return { number: game.outcomes.length + 1, total: game.locations.length, ...game.round!.view() };
}

function beginRound(game: SoloGame) {
	game.round = Round.loading(game.locations[game.outcomes.length], game.rules);
}

export function startSoloGame(
	userId: number | null,
	rounds: number,
	timeLimit: number,
	special: { id: string; rules: RoundRules } | null = null,
	difficulty: Difficulty | null = null
) {
	if (games.size >= MAX_GAMES) pruneSoloGames();
	if (games.size >= MAX_GAMES) fail(503, "The server is busy. Try again in a moment.");

	const locations = pickLocations(rounds, difficulty);
	if (difficulty && locations.length < rounds)
		fail(409, `There aren't enough ${difficulty} locations yet for ${rounds} rounds. Try fewer rounds, or Any.`);
	if (locations.length === 0) fail(503, "No locations available yet. Check back later.");

	const game: SoloGame = {
		id: randomBytes(16).toString("hex"),
		userId,
		timeLimit,
		rules: special?.rules ?? SOLO_RULES(timeLimit),
		special: special?.id ?? null,
		difficulty,
		locations,
		round: null,
		outcomes: [],
		touchedAt: Date.now(),
	};
	games.set(game.id, game);
	beginRound(game);
	return {
		game_id: game.id,
		rounds: locations.length,
		time_limit: timeLimit,
		special: game.special,
		difficulty,
		round: roundJson(game),
	};
}

/** Finds a game and checks the caller owns it. Unknown, expired and foreign games all look the same. */
function getGame(id: string, userId: number | null): SoloGame {
	const game = games.get(id);
	if (!game || game.userId !== userId) fail(404, "This game has expired. Start a new one.");
	game.touchedAt = Date.now();
	return game;
}

export function beginSoloRound(id: string, userId: number | null) {
	const game = getGame(id, userId);
	if (!game.round) fail(409, "No round in progress");
	game.round.begin();
	return { round: roundJson(game) };
}

export function revealSoloHint(id: string, userId: number | null) {
	const game = getGame(id, userId);
	if (!game.round) fail(409, "No round in progress");
	const hint = game.round.revealHint();
	if (hint === null) fail(409, "No more hints for this location");
	return { hint, hints_used: game.round.hintsRevealed, hints_total: game.round.hints.length };
}

export function submitSoloGuess(id: string, userId: number | null, guess: Guess | null) {
	const game = getGame(id, userId);
	const round = game.round;
	if (!round) fail(409, "No round in progress");

	const outcome = round.score(guess);
	game.outcomes.push(outcome);
	game.round = null;
	/** Specials change the picture or the clock, so they say nothing fair about a location or a player. */
	if (!game.special) {
		recordOutcome(round.location, outcome);
		checkRound(game.userId, outcome, round.rules.timeLimit);
		reviewGuess(game.userId, "solo", round.location.id, outcome);
	}

	const finished = game.outcomes.length >= game.locations.length;
	return {
		round: game.outcomes.length,
		...outcomeJson(outcome),
		...round.answer(),
		total_score: game.outcomes.reduce((sum, o) => sum + o.score, 0),
		finished,
		summary: finished ? finishGame(game) : null,
	};
}

export function nextSoloRound(id: string, userId: number | null) {
	const game = getGame(id, userId);
	if (game.round) fail(409, "Finish the current round first");
	if (game.outcomes.length >= game.locations.length) fail(409, "This game is over");
	beginRound(game);
	return { round: roundJson(game) };
}

/* ---- Carrying games across a restart ---- */

const SNAPSHOT_FILE = join(DATA_DIR, "solo-games.json");

type SavedGame = Omit<SoloGame, "locations" | "round"> & {
	locationIds: number[];
	/** The round being guessed: how long its clock had run (null if not started) and the hints shown. */
	round: { elapsedMs: number | null; hintsRevealed: number } | null;
};

/** Writes every game in progress to disk and empties the list. `restoreSoloGames` reads it back. */
export function saveSoloGames(): number {
	const now = Date.now();
	const saved: SavedGame[] = [...games.values()].map(({ locations, round, ...game }) => ({
		...game,
		locationIds: locations.map((l) => l.id),
		round: round && {
			elapsedMs: round.pending(now) ? null : round.elapsed(now) * 1000,
			hintsRevealed: round.hintsRevealed,
		},
	}));
	games.clear();
	if (saved.length) writeFileSync(SNAPSHOT_FILE, JSON.stringify(saved));
	return saved.length;
}

/** Brings back the games saved by the last clean stop. The time the server was down does not count. */
export function restoreSoloGames(): number {
	if (!existsSync(SNAPSHOT_FILE)) return 0;
	let saved: SavedGame[] = [];
	try {
		saved = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
	} catch (err) {
		console.error("[solo] Could not read the saved games:", err);
	}
	rmSync(SNAPSHOT_FILE, { force: true });

	const now = Date.now();
	const findLocation = db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?");
	let restored = 0;
	for (const { locationIds, round, ...game } of saved) {
		if (now - game.touchedAt > IDLE_TTL_MS) continue;
		const locations = locationIds.map((id) => findLocation.get(id));
		/** A location removed in the meantime cannot be played; the game is dropped. */
		if (locations.some((l) => !l)) continue;
		const restoredGame: SoloGame = { ...game, locations: locations as Location[], round: null, touchedAt: now };
		if (round) {
			const location = restoredGame.locations[restoredGame.outcomes.length];
			restoredGame.round =
				round.elapsedMs === null
					? Round.loading(location, game.rules)
					: new Round(location, game.rules, now - round.elapsedMs, round.hintsRevealed);
		}
		games.set(restoredGame.id, restoredGame);
		restored++;
	}
	return restored;
}

function finishGame(game: SoloGame) {
	games.delete(game.id);
	const rounds = game.locations.length;
	const totalScore = game.outcomes.reduce((sum, o) => sum + o.score, 0);
	const maxPossible = rounds * (GAME.maxRoundScore + game.rules.maxTimeBonus);
	const ranked = game.userId !== null && !game.special && !game.difficulty;

	let streak: Streak | null = null;
	let previousBest: number | null = null;
	if (game.userId !== null && ranked) {
		previousBest =
			db
				.query<{ best: number | null }, [number, number, number]>(
					"SELECT MAX(total_score) AS best FROM solo_scores WHERE user_id = ? AND rounds = ? AND time_limit = ?"
				)
				.get(game.userId, rounds, game.timeLimit)?.best ?? null;
		db.run(
			"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, ?, ?, ?, ?)",
			[game.userId, totalScore, rounds, maxPossible, game.timeLimit]
		);
	}
	if (game.userId !== null) {
		streak = recordPlay(game.userId);
		checkStreak(game.userId, streak);
		if (!game.special) checkSoloGame(game.userId, totalScore, maxPossible, ranked);
	}
	return {
		total_score: totalScore,
		max_possible: maxPossible,
		rounds,
		time_limit: game.timeLimit,
		saved: ranked,
		/** True when this beat an earlier game of the same length and time limit; never for a first one. */
		personal_best: previousBest !== null && totalScore > previousBest,
		previous_best: previousBest,
		special: game.special,
		difficulty: game.difficulty ?? null,
		...streak,
	};
}
