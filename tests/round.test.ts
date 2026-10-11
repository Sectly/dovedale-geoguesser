import { describe, expect, test } from "bun:test";
import type { Location } from "../src/db";
import { DUEL_RULES, Round, SOLO_RULES, parseGuess } from "../src/game/round";

const location = {
	id: 1,
	image_path: "a.webp",
	world_x: 100,
	world_y: 200,
	label: "Somewhere",
	hints: JSON.stringify(["first", "second"]),
} as Location;

describe("Round", () => {
	test("a perfect guess scores the maximum", () => {
		const round = new Round(location, SOLO_RULES(90));
		expect(round.score({ x: 100, y: 200 }).score).toBe(5000);
	});

	test("score falls with distance and never goes negative", () => {
		const round = new Round(location, SOLO_RULES(0));
		const near = round.score({ x: 100, y: 1200 }).score;
		const far = round.score({ x: 100, y: 900_000 }).score;
		expect(near).toBeLessThan(5000);
		expect(near).toBeGreaterThan(far);
		expect(far).toBe(0);
	});

	test("no guess scores zero with no distance", () => {
		const outcome = new Round(location, SOLO_RULES(90)).score(null);
		expect(outcome).toMatchObject({ score: 0, distance: null, guess: null });
	});

	test("each revealed hint costs points", () => {
		const round = new Round(location, SOLO_RULES(90));
		expect(round.revealHint()).toBe("first");
		expect(round.revealHint()).toBe("second");
		expect(round.revealHint()).toBeNull();
		expect(round.score({ x: 100, y: 200 })).toMatchObject({ score: 4000, hintsUsed: 2 });
	});

	test("a guess after the clock and its grace period counts as no guess", () => {
		const start = 1_000_000;
		const round = new Round(location, SOLO_RULES(30), start);
		expect(round.score({ x: 100, y: 200 }, start + 33_000).score).toBe(5000);
		expect(round.score({ x: 100, y: 200 }, start + 36_000)).toMatchObject({ score: 0, guess: null });
	});

	test("untimed rounds never expire", () => {
		const round = new Round(location, SOLO_RULES(0), 0);
		expect(round.expired(10 ** 12)).toBe(false);
		expect(round.remaining()).toBeNull();
	});

	test("duels add a time bonus and have no hints", () => {
		const start = 1_000_000;
		const round = new Round(location, DUEL_RULES, start);
		expect(round.hints).toEqual([]);
		expect(round.score({ x: 100, y: 200 }, start).score).toBe(6000);
		expect(round.score({ x: 100, y: 200 }, start + 30_000).score).toBe(5500);
	});

	test("the round view never contains the answer", () => {
		const view = JSON.stringify(new Round(location, SOLO_RULES(90)).view());
		expect(view).not.toContain("world_x");
		expect(view).not.toContain("Somewhere");
		expect(view).not.toContain("first");
	});
});

describe("parseGuess", () => {
	test("rejects anything that is not a pair of sane numbers", () => {
		expect(parseGuess(1, 2)).toEqual({ x: 1, y: 2 });
		expect(parseGuess(null, null)).toBeNull();
		expect(parseGuess("1", 2)).toBeNull();
		expect(parseGuess(NaN, 2)).toBeNull();
		expect(parseGuess(1e12, 2)).toBeNull();
	});
});
