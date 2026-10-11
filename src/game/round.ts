import type { Location } from "../db";
import { GAME } from "../config";
import { uploadUrl } from "../lib/uploads";
import { parseHints } from "./locations";

/**
 * One guessable round: a location, a clock, hints and scoring.
 * Solo, daily and duels all run on this; they differ only in their rules and in
 * what they wrap around it (a sequence of rounds, persistence, several players).
 */

export type RoundRules = {
	/** Seconds per round, 0 for no limit. */
	timeLimit: number;
	/** Points lost per revealed hint. */
	hintCost: number;
	/** Whether players may reveal hints at all. */
	hints: boolean;
	/** Extra points for a guess made instantly, falling to 0 at the time limit. */
	maxTimeBonus: number;
};

export type Guess = { x: number; y: number };

export type RoundOutcome = {
	guess: Guess | null;
	/** World units from the correct spot, null when there was no guess. */
	distance: number | null;
	timeTaken: number;
	hintsUsed: number;
	score: number;
};

const COORD_LIMIT = 1_000_000;
/** Distance at which the score has dropped to 1/e of the maximum. */
const DISTANCE_FALLOFF = 9322;

/** Accepts a guess only when both coordinates are sane numbers; anything else is "no guess". */
export function parseGuess(x: unknown, y: unknown): Guess | null {
	if (typeof x !== "number" || typeof y !== "number") return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	if (Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT) return null;
	return { x, y };
}

export function distanceScore(distance: number): number {
	return Math.max(0, Math.round(GAME.maxRoundScore * Math.exp(-distance / DISTANCE_FALLOFF)));
}

export function timeBonus(timeTaken: number, rules: RoundRules): number {
	if (!rules.maxTimeBonus || !rules.timeLimit || timeTaken >= rules.timeLimit) return 0;
	return Math.max(0, Math.round(rules.maxTimeBonus * (1 - timeTaken / rules.timeLimit)));
}

export class Round {
	readonly hints: string[];

	private pausedAt: number | null = null;

	constructor(
		readonly location: Location,
		readonly rules: RoundRules,
		private startedAt = Date.now(),
		public hintsRevealed = 0
	) {
		this.hints = rules.hints ? parseHints(location.hints) : [];
		this.hintsRevealed = Math.min(this.hintsRevealed, this.hints.length);
	}

	/**
	 * A round made with `Round.loading` has its start set slightly in the future so
	 * players can load the screenshot first. `begin` starts the clock now instead;
	 * if nobody calls it, the clock starts when the loading window ends.
	 */
	static loading(location: Location, rules: RoundRules): Round {
		return new Round(location, rules, Date.now() + GAME.loadingWindow * 1000);
	}

	begin(now = Date.now()) {
		if (this.startedAt > now) this.startedAt = now;
	}

	/** True until the clock has started. */
	pending(now = Date.now()): boolean {
		return this.startedAt > now;
	}

	get paused(): boolean {
		return this.pausedAt !== null;
	}

	/** Freezes the clock. Time spent paused does not count against the players. */
	pause(now = Date.now()) {
		this.pausedAt ??= now;
	}

	resume(now = Date.now()) {
		if (this.pausedAt === null) return;
		this.startedAt += now - this.pausedAt;
		this.pausedAt = null;
	}

	/** Seconds the clock has actually been running. */
	private running(now: number): number {
		return Math.max(0, ((this.pausedAt ?? now) - this.startedAt) / 1000);
	}

	/** Seconds since the round started, capped at the time limit. */
	elapsed(now = Date.now()): number {
		const seconds = this.running(now);
		return this.rules.timeLimit ? Math.min(this.rules.timeLimit, seconds) : seconds;
	}

	/** Seconds left on the clock, or null when the round is untimed. */
	remaining(now = Date.now()): number | null {
		if (!this.rules.timeLimit) return null;
		return Math.max(0, this.rules.timeLimit - this.running(now));
	}

	/** True once the clock ran out, including the grace given for network delay. */
	expired(now = Date.now()): boolean {
		if (!this.rules.timeLimit) return false;
		return this.running(now) > this.rules.timeLimit + GAME.lateGuessGrace;
	}

	/** Reveals the next hint, or returns null when none are left. */
	revealHint(): string | null {
		if (this.hintsRevealed >= this.hints.length) return null;
		return this.hints[this.hintsRevealed++];
	}

	/** Scores a guess made now. A guess after the clock expired counts as no guess. */
	score(guess: Guess | null, now = Date.now()): RoundOutcome {
		const timeTaken = Math.round(this.elapsed(now) * 10) / 10;
		const hintsUsed = this.hintsRevealed;
		if (!guess || this.expired(now)) return { guess: null, distance: null, timeTaken, hintsUsed, score: 0 };

		const distance = Math.hypot(guess.x - this.location.world_x, guess.y - this.location.world_y);
		const score = Math.max(
			0,
			distanceScore(distance) + timeBonus(timeTaken, this.rules) - hintsUsed * this.rules.hintCost
		);
		return { guess, distance, timeTaken, hintsUsed, score };
	}

	/** What a player may know while guessing. Never includes the answer. */
	view(now = Date.now()) {
		const remaining = this.remaining(now);
		return {
			loading: this.pending(now),
			image_url: uploadUrl(this.location.image_path),
			location_id: this.location.id,
			time_limit: this.rules.timeLimit,
			time_remaining: remaining === null ? null : Math.ceil(remaining),
			hint_cost: this.rules.hintCost,
			hints_total: this.hints.length,
			hints: this.hints.slice(0, this.hintsRevealed),
		};
	}

	/** The answer, sent once guessing is over. */
	answer() {
		return {
			location_id: this.location.id,
			correct_x: this.location.world_x,
			correct_y: this.location.world_y,
			label: this.location.label,
		};
	}
}

/** Wire format for a scored guess. */
export function outcomeJson(outcome: RoundOutcome) {
	return {
		guessed_x: outcome.guess?.x ?? null,
		guessed_y: outcome.guess?.y ?? null,
		distance: outcome.distance === null ? null : Math.round(outcome.distance),
		time_taken: outcome.timeTaken,
		hints_used: outcome.hintsUsed,
		score: outcome.score,
	};
}

export const SOLO_RULES = (timeLimit: number): RoundRules => ({
	timeLimit,
	hintCost: GAME.hintCost,
	hints: true,
	maxTimeBonus: 0,
});

export const DAILY_RULES: RoundRules = {
	timeLimit: GAME.daily.timeLimit,
	hintCost: GAME.hintCost,
	hints: true,
	maxTimeBonus: 0,
};

export const DUEL_RULES: RoundRules = {
	timeLimit: GAME.duel.roundTime,
	hintCost: GAME.hintCost,
	hints: false,
	maxTimeBonus: GAME.duel.maxTimeBonus,
};
