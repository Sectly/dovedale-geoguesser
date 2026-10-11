import { randomBytes } from "crypto";
import { db, type Location } from "../db";
import { GAME } from "../config";
import { fail } from "../lib/http";
import { pickLocations } from "./locations";
import { Round, SOLO_RULES, outcomeJson, type Guess, type RoundOutcome, type RoundRules } from "./round";
import { recordPlay, type Streak } from "./streaks";

/**
 * Solo games live in memory and are scored entirely on the server, so the answer
 * never reaches the browser before the guess does. Anonymous games work the same
 * way; they just are not saved to the leaderboard.
 */

type SoloGame = {
	id: string;
	userId: number | null;
	timeLimit: number;
	rules: RoundRules;
	/** Set for a Specials mode: played for fun, never saved to the leaderboard. */
	special: string | null;
	locations: Location[];
	/** The round being guessed, or null between rounds. */
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

export function activeSoloGames(): number {
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
	special: { id: string; rules: RoundRules } | null = null
) {
	if (games.size >= MAX_GAMES) pruneSoloGames();
	if (games.size >= MAX_GAMES) fail(503, "The server is busy. Try again in a moment.");

	const locations = pickLocations(rounds);
	if (locations.length === 0) fail(503, "No locations available yet. Check back later.");

	const game: SoloGame = {
		id: randomBytes(16).toString("hex"),
		userId,
		timeLimit,
		rules: special?.rules ?? SOLO_RULES(timeLimit),
		special: special?.id ?? null,
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

/** The player's browser has the screenshot on screen; start the clock. */
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

function finishGame(game: SoloGame) {
	games.delete(game.id);
	const rounds = game.locations.length;
	const totalScore = game.outcomes.reduce((sum, o) => sum + o.score, 0);
	const maxPossible = rounds * (GAME.maxRoundScore + game.rules.maxTimeBonus);
	const ranked = game.userId !== null && !game.special;

	let streak: Streak | null = null;
	if (game.userId !== null && ranked) {
		db.run(
			"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, ?, ?, ?, ?)",
			[game.userId, totalScore, rounds, maxPossible, game.timeLimit]
		);
	}
	if (game.userId !== null) streak = recordPlay(game.userId);
	return {
		total_score: totalScore,
		max_possible: maxPossible,
		rounds,
		time_limit: game.timeLimit,
		saved: ranked,
		special: game.special,
		...streak,
	};
}
