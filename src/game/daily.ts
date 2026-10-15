import { db, type Location, type User } from "../db";
import { GAME } from "../config";
import { fail } from "../lib/http";
import { nowSec, utcDate } from "../lib/time";
import { checkDaily, checkRound, checkStreak } from "../achievements";
import { reviewGuess } from "../fairplay";
import { DAILY_RULES, Round, outcomeJson, recordOutcome, type Guess } from "./round";
import { recordPlay } from "./streaks";

/** The daily challenge: one location per UTC day, one attempt each. Start time and hints are stored so reloads keep the clock. */

type Attempt = { started_at: number; hints_revealed: number };
type DailyScore = {
	score: number;
	guessed_x: number | null;
	guessed_y: number | null;
	distance: number | null;
	time_taken: number | null;
	hints_used: number;
};

export function getDailyChallenge(): { date: string; location: Location } | null {
	const date = utcDate();
	const find = () =>
		db
			.query<Location, [string]>(
				"SELECT l.* FROM daily_challenges d JOIN locations l ON l.id = d.location_id WHERE d.date = ?"
			)
			.get(date);

	let location = find();
	if (!location) {
		db.run(
			"INSERT OR IGNORE INTO daily_challenges (date, location_id) SELECT ?, id FROM locations WHERE is_active = 1 ORDER BY RANDOM() LIMIT 1",
			[date]
		);
		location = find();
	}
	return location ? { date, location } : null;
}

function requireChallenge() {
	return getDailyChallenge() ?? fail(404, "No challenge available today. Check back later.");
}

function getScore(userId: number, date: string): DailyScore | null {
	return db
		.query<DailyScore, [number, string]>(
			"SELECT score, guessed_x, guessed_y, distance, time_taken, hints_used FROM daily_scores WHERE user_id = ? AND date = ?"
		)
		.get(userId, date);
}

function getAttempt(userId: number, date: string): Attempt | null {
	return db
		.query<Attempt, [number, string]>(
			"SELECT started_at, hints_revealed FROM daily_attempts WHERE user_id = ? AND date = ?"
		)
		.get(userId, date);
}

function roundFor(location: Location, attempt: Attempt): Round {
	return new Round(location, DAILY_RULES, attempt.started_at * 1000, attempt.hints_revealed);
}

function resultJson(location: Location, score: DailyScore) {
	return {
		score: score.score,
		guessed_x: score.guessed_x,
		guessed_y: score.guessed_y,
		distance: score.distance === null ? null : Math.round(score.distance),
		time_taken: score.time_taken,
		hints_used: score.hints_used,
		location_id: location.id,
		correct_x: location.world_x,
		correct_y: location.world_y,
		label: location.label,
	};
}

/** Today's challenge for this visitor. Reveals nothing until they have played. */
export function dailyStatus(user: User | null) {
	const challenge = getDailyChallenge();
	if (!challenge) return null;
	const score = user ? getScore(user.id, challenge.date) : null;
	return {
		date: challenge.date,
		time_limit: DAILY_RULES.timeLimit,
		already_played: !!score,
		started: !!user && !score && !!getAttempt(user.id, challenge.date),
		result: score ? resultJson(challenge.location, score) : null,
	};
}

export function startDaily(user: User) {
	const { date, location } = requireChallenge();
	if (getScore(user.id, date)) fail(409, "Already played today");

	/** The clock starts when the screenshot is up (see beginDaily), or once the loading window passes. */
	db.run("INSERT OR IGNORE INTO daily_attempts (user_id, date, started_at) VALUES (?, ?, ?)", [
		user.id,
		date,
		nowSec() + GAME.loadingWindow,
	]);
	return dailyView(user, date, location);
}

function dailyView(user: User, date: string, location: Location) {
	const { location_id: _hidden, ...view } = roundFor(location, getAttempt(user.id, date)!).view();
	return { date, ...view };
}

export function beginDaily(user: User) {
	const { date, location } = requireChallenge();
	if (!getAttempt(user.id, date) || getScore(user.id, date)) fail(409, "No attempt in progress");
	db.run("UPDATE daily_attempts SET started_at = MIN(started_at, ?) WHERE user_id = ? AND date = ?", [
		nowSec(),
		user.id,
		date,
	]);
	return dailyView(user, date, location);
}

export function revealDailyHint(user: User) {
	const { date, location } = requireChallenge();
	const attempt = getAttempt(user.id, date);
	if (!attempt || getScore(user.id, date)) fail(409, "No attempt in progress");

	const round = roundFor(location, attempt);
	const hint = round.revealHint();
	if (hint === null) fail(409, "No more hints for this location");
	db.run("UPDATE daily_attempts SET hints_revealed = ? WHERE user_id = ? AND date = ?", [
		round.hintsRevealed,
		user.id,
		date,
	]);
	return { hint, hints_used: round.hintsRevealed, hints_total: round.hints.length };
}

export function submitDailyGuess(user: User, guess: Guess | null) {
	const { date, location } = requireChallenge();
	const attempt = getAttempt(user.id, date);
	if (!attempt) fail(409, "Start today's challenge first");

	const outcome = roundFor(location, attempt).score(guess);
	const inserted = db.run(
		"INSERT OR IGNORE INTO daily_scores (user_id, date, score, guessed_x, guessed_y, distance, time_taken, hints_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[
			user.id,
			date,
			outcome.score,
			outcome.guess?.x ?? null,
			outcome.guess?.y ?? null,
			outcome.distance,
			outcome.timeTaken,
			outcome.hintsUsed,
		]
	);
	if (inserted.changes === 0) fail(409, "Already played today");

	recordOutcome(location, outcome);
	reviewGuess(user.id, "daily", location.id, outcome);
	const streak = recordPlay(user.id);
	checkRound(user.id, outcome, DAILY_RULES.timeLimit);
	checkDaily(user.id, outcome.score);
	checkStreak(user.id, streak);
	return { date, ...outcomeJson(outcome), ...roundFor(location, attempt).answer(), ...streak };
}
