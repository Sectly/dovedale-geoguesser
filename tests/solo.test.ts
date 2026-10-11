import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { activeSoloGames, restoreSoloGames, saveSoloGames } from "../src/game/solo";
import { clearLocations, createLocation, createUser, post, resetReviewQueues } from "./helpers";

beforeAll(() => {
	clearLocations();
	for (let i = 0; i < 6; i++) createLocation({ hints: ["a hint"] });
});

async function playThrough(as: ReturnType<typeof createUser> | undefined, rounds: number) {
	const start = await post("/api/solo/games", as, { rounds, time_limit: 0 });
	expect(start.status).toBe(200);
	let last: any;
	for (let i = 0; i < start.data.rounds; i++) {
		if (i > 0) expect((await post(`/api/solo/games/${start.data.game_id}/next`, as)).status).toBe(200);
		last = await post(`/api/solo/games/${start.data.game_id}/guess`, as, { x: 0, y: 0 });
		expect(last.status).toBe(200);
	}
	return { start: start.data, end: last.data };
}

beforeAll(resetReviewQueues);

describe("solo", () => {
	test("guests can play a full game and nothing is saved", async () => {
		const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM solo_scores").get()!.n;
		const { start, end } = await playThrough(undefined, 3);
		expect(start.rounds).toBe(3);
		expect(end.finished).toBe(true);
		expect(end.summary).toMatchObject({ saved: false, rounds: 3, max_possible: 15000 });
		expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM solo_scores").get()!.n).toBe(before);
	});

	test("the answer only arrives with the guess result", async () => {
		const start = await post("/api/solo/games", undefined, { rounds: 3 });
		expect(JSON.stringify(start.data)).not.toContain("correct_x");
		expect(start.data.round.hints).toEqual([]);
		const guess = await post(`/api/solo/games/${start.data.game_id}/guess`, undefined, { x: 1, y: 1 });
		expect(guess.data.correct_x).toBeNumber();
		expect(guess.data.finished).toBe(false);
	});

	test("logged-in games are scored by the server and saved with a streak", async () => {
		const user = createUser();
		const { end } = await playThrough(user, 5);
		expect(end.summary).toMatchObject({ saved: true, current_streak: 1, longest_streak: 1 });
		const row = db
			.query<{ total_score: number; rounds: number; time_limit: number }, [number]>(
				"SELECT total_score, rounds, time_limit FROM solo_scores WHERE user_id = ?"
			)
			.get(user.id)!;
		expect(row).toEqual({ total_score: end.summary.total_score, rounds: 5, time_limit: 0 });
	});

	test("hints cost points and run out", async () => {
		const start = await post("/api/solo/games", undefined, { rounds: 3 });
		const id = start.data.game_id;
		expect(start.data.round.hints_total).toBe(1);
		expect((await post(`/api/solo/games/${id}/hint`)).data).toMatchObject({ hint: "a hint", hints_used: 1 });
		expect((await post(`/api/solo/games/${id}/hint`)).status).toBe(409);
		expect((await post(`/api/solo/games/${id}/guess`, undefined, {})).data).toMatchObject({
			score: 0,
			hints_used: 1,
		});
	});

	test("a game cannot be played by someone else or out of order", async () => {
		const owner = createUser();
		const start = await post("/api/solo/games", owner, { rounds: 3 });
		const id = start.data.game_id;
		expect((await post(`/api/solo/games/${id}/guess`, createUser(), { x: 0, y: 0 })).status).toBe(404);
		expect((await post(`/api/solo/games/${id}/guess`, undefined, { x: 0, y: 0 })).status).toBe(404);
		expect((await post(`/api/solo/games/${id}/next`, owner)).status).toBe(409);
		expect((await post(`/api/solo/games/${id}/guess`, owner, { x: 0, y: 0 })).status).toBe(200);
		expect((await post(`/api/solo/games/${id}/guess`, owner, { x: 0, y: 0 })).status).toBe(409);
	});

	test("the clock starts when the browser says the screenshot is up", async () => {
		const start = await post("/api/solo/games", undefined, { rounds: 3, time_limit: 30 });
		expect(start.data.round).toMatchObject({ loading: true, time_remaining: 30 });
		const begun = await post(`/api/solo/games/${start.data.game_id}/begin`);
		expect(begun.data.round).toMatchObject({ loading: false, number: 1 });
	});

	test("a game in progress is carried across a restart", async () => {
		const player = createUser();
		const start = await post("/api/solo/games", player, { rounds: 3, time_limit: 60 });
		const id = start.data.game_id;
		await post(`/api/solo/games/${id}/begin`, player);
		await post(`/api/solo/games/${id}/hint`, player);
		const first = await post(`/api/solo/games/${id}/guess`, player, { x: 0, y: 0 });
		await post(`/api/solo/games/${id}/next`, player);
		await post(`/api/solo/games/${id}/begin`, player);

		expect(saveSoloGames()).toBeGreaterThan(0);
		expect(activeSoloGames()).toBe(0);
		expect((await post(`/api/solo/games/${id}/guess`, player, { x: 0, y: 0 })).status).toBe(404);
		expect(restoreSoloGames()).toBeGreaterThan(0);
		expect(restoreSoloGames()).toBe(0);

		const second = await post(`/api/solo/games/${id}/guess`, player, { x: 0, y: 0 });
		expect(second.status).toBe(200);
		expect(second.data.round).toBe(2);
		expect(second.data.total_score).toBe(first.data.score + second.data.score);
	});

	test("unsupported settings fall back to the defaults", async () => {
		const start = await post("/api/solo/games", undefined, { rounds: 9999, time_limit: 7 });
		expect(start.data).toMatchObject({ rounds: 5, time_limit: 90 });
	});
});
