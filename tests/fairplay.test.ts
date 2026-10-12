import { describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { openFairplayFlags, reviewGuess } from "../src/fairplay";
import type { RoundOutcome } from "../src/game/round";
import { call, createLocation, createUser, post } from "./helpers";

const guess = (distance: number, timeTaken: number): RoundOutcome => ({
	guess: { x: 0, y: 0 },
	distance,
	timeTaken,
	hintsUsed: 0,
	score: 0,
});
const signals = (userId: number) => openFairplayFlags(userId).map((flag) => flag.signal);

describe("fair-play review", () => {
	test("a strong, fast, human player is never flagged", () => {
		const player = createUser();
		const places = Array.from({ length: 6 }, () => createLocation());
		/** Sixty good guesses: close but not pixel-exact, quick but not instant, and never the same time twice. */
		for (let i = 0; i < 60; i++)
			reviewGuess(player.id, "solo", places[i % 6], guess(20 + (i % 9) * 35, 1.6 + (i % 7) * 0.9));
		/** A couple of freak results on top do not make a pattern. */
		reviewGuess(player.id, "solo", places[0], guess(1, 0.5));
		reviewGuess(player.id, "solo", places[1], guess(0.5, 0.6));
		expect(signals(player.id)).toEqual([]);
	});

	test("guesses with no pin are not recorded", () => {
		const player = createUser();
		reviewGuess(player.id, "solo", createLocation(), { ...guess(0, 0), guess: null, distance: null });
		expect(db.query("SELECT 1 FROM guess_log WHERE user_id = ?").get(player.id)).toBeNull();
	});

	test("repeated exact hits on different locations are flagged once", () => {
		const player = createUser();
		const places = Array.from({ length: 5 }, () => createLocation());
		for (let i = 0; i < 5; i++) reviewGuess(player.id, "duel", places[i], guess(0.4, 6 + i));
		expect(signals(player.id)).toEqual([]);
		reviewGuess(player.id, "duel", places[0], guess(1.1, 12));
		expect(signals(player.id)).toEqual(["exact"]);
		reviewGuess(player.id, "duel", places[1], guess(0.2, 9));
		expect(signals(player.id)).toEqual(["exact"]);
	});

	test("exact hits on one memorised location are not enough", () => {
		const player = createUser();
		const place = createLocation();
		for (let i = 0; i < 20; i++) reviewGuess(player.id, "solo", place, guess(1, 5 + i));
		expect(signals(player.id)).toEqual([]);
	});

	test("accurate guesses faster than a person can make are flagged", () => {
		const player = createUser();
		const place = createLocation();
		for (let i = 0; i < 5; i++) reviewGuess(player.id, "solo", place, guess(300 + i * 40, 0.3 + i * 0.05));
		expect(signals(player.id)).toEqual(["instant"]);
	});

	test("a long run of accurate guesses with identical timing is flagged", () => {
		const player = createUser();
		const place = createLocation();
		for (let i = 0; i < 12; i++) reviewGuess(player.id, "solo", place, guess(250 + i * 30, 4 + (i % 2) * 0.05));
		expect(signals(player.id)).toEqual(["clockwork"]);
	});

	test("staff see the flag, dismiss it, and the same guesses do not raise it again", async () => {
		const player = createUser();
		const moderator = createUser({ role: "moderator" });
		const place = createLocation();
		for (let i = 0; i < 5; i++) reviewGuess(player.id, "solo", place, guess(300, 0.3 + i * 0.05));

		const panel = (await call(`/api/admin/users/${player.id}/moderation`, { as: moderator })).data;
		expect(panel.fairplay_flags).toHaveLength(1);
		expect(panel.fairplay_flags[0].evidence).toContain("in under 0.7s");
		/** Nothing was done to the account. */
		expect(panel.user.is_banned).toBe(false);
		expect(panel.actions).toEqual([]);

		expect((await post(`/api/admin/users/fairplay/${panel.fairplay_flags[0].id}/dismiss`, player)).status).toBe(
			403
		);
		expect((await post(`/api/admin/users/fairplay/${panel.fairplay_flags[0].id}/dismiss`, moderator)).status).toBe(
			200
		);
		reviewGuess(player.id, "solo", place, guess(2000, 8));
		expect(signals(player.id)).toEqual([]);
	});

	test("only the newest guesses are kept", () => {
		const player = createUser();
		const place = createLocation();
		for (let i = 0; i < 75; i++) reviewGuess(player.id, "solo", place, guess(500 + i * 13, 3 + (i % 11)));
		const kept = db
			.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM guess_log WHERE user_id = ?")
			.get(player.id)!.n;
		expect(kept).toBe(60);
	});
});
