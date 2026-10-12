import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { getStreak } from "../src/game/streaks";
import { utcDate } from "../src/lib/time";
import { issueAction } from "../src/moderation";
import { call, clearLocations, createLocation, createUser, post, resetReviewQueues } from "./helpers";

beforeAll(() => {
	clearLocations();
	createLocation({ x: 500, y: 500, hints: ["one", "two"] });
});

beforeAll(resetReviewQueues);

describe("daily", () => {
	test("visitors see that a challenge exists but nothing about it", async () => {
		const res = await call("/api/daily");
		expect(res.data).toMatchObject({ date: utcDate(), already_played: false, result: null });
		expect(JSON.stringify(res.data)).not.toContain("image");
		expect((await post("/api/daily/start")).status).toBe(401);
	});

	test("a full attempt: start, hint, guess, then locked", async () => {
		const user = createUser();
		const start = await post("/api/daily/start", user);
		expect(start.data).toMatchObject({ time_limit: 90, hints_total: 2, hints: [] });
		expect(start.data.location_id).toBeUndefined();

		expect(start.data.loading).toBe(true);
		expect((await post("/api/daily/begin", user)).data).toMatchObject({ loading: false, time_remaining: 90 });
		expect((await post("/api/daily/hint", user)).data.hint).toBe("one");
		/** Reloading the page resumes the same attempt with its hints. */
		expect((await post("/api/daily/start", user)).data.hints).toEqual(["one"]);

		const guess = await post("/api/daily/guess", user, { x: 500, y: 500 });
		expect(guess.data).toMatchObject({
			score: 4500,
			distance: 0,
			hints_used: 1,
			correct_x: 500,
			current_streak: 1,
		});

		expect((await post("/api/daily/guess", user, { x: 500, y: 500 })).status).toBe(409);
		expect((await post("/api/daily/start", user)).status).toBe(409);
		const status = await call("/api/daily", { as: user });
		expect(status.data).toMatchObject({ already_played: true, result: { score: 4500 } });
	});

	test("guessing without starting is refused", async () => {
		expect((await post("/api/daily/guess", createUser(), { x: 1, y: 1 })).status).toBe(409);
	});

	test("an attempt left past the time limit scores zero", async () => {
		const user = createUser();
		await post("/api/daily/start", user);
		db.run("UPDATE daily_attempts SET started_at = started_at - 600 WHERE user_id = ?", [user.id]);
		const guess = await post("/api/daily/guess", user, { x: 500, y: 500 });
		expect(guess.data).toMatchObject({ score: 0, distance: null, time_taken: 90 });
	});

	test("banned players cannot play", async () => {
		const user = createUser();
		issueAction(user, "ban_perm", "Test ban", null);
		expect((await post("/api/daily/start", user)).status).toBe(403);
	});
});

describe("streaks", () => {
	test("a streak that missed a day reads as zero", () => {
		const user = createUser();
		db.run("UPDATE users SET current_streak = 9, longest_streak = 9, last_played_date = ? WHERE id = ?", [
			utcDate(-1),
			user.id,
		]);
		expect(getStreak(user.id)).toEqual({ current_streak: 9, longest_streak: 9 });
		db.run("UPDATE users SET last_played_date = ? WHERE id = ?", [utcDate(-3), user.id]);
		expect(getStreak(user.id)).toEqual({ current_streak: 0, longest_streak: 9 });
	});
});
