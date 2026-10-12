import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { trimSoloScores } from "../src/jobs/cleanup";
import { safeRedirect } from "../src/lib/http";
import { call, createLocation, createUser, post, resetReviewQueues } from "./helpers";

beforeAll(resetReviewQueues);

describe("auth", () => {
	test("only same-site paths are accepted as login redirects", () => {
		expect(safeRedirect("/play")).toBe("/play");
		expect(safeRedirect("/duel/ABC123?spectate")).toBe("/duel/ABC123?spectate");
		expect(safeRedirect("//evil.example")).toBe("/");
		expect(safeRedirect("/\\evil.example")).toBe("/");
		expect(safeRedirect("https://evil.example")).toBe("/");
		expect(safeRedirect(undefined)).toBe("/");
	});

	test("/api/auth/me reflects the session", async () => {
		expect((await call("/api/auth/me")).data).toBeNull();
		const user = createUser();
		expect((await call("/api/auth/me", { as: user })).data).toMatchObject({ id: user.id, is_banned: false });
	});
});

describe("account deletion", () => {
	test("works for a user with submissions, scores and tickets", async () => {
		const user = createUser();
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES ('p.webp', 1, 2, 'Pending one', ?)",
			[user.id]
		);
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by, status) VALUES ('a.webp', 1, 2, 'Approved one', ?, 'approved')",
			[user.id]
		);
		db.run("INSERT INTO solo_scores (user_id, total_score, rounds, max_possible) VALUES (?, 100, 5, 25000)", [
			user.id,
		]);
		db.run("INSERT INTO support_tickets (user_id, subject, message) VALUES (?, 'Subject', 'A message for staff')", [
			user.id,
		]);

		expect((await call("/api/account", { method: "DELETE", as: user, json: {} })).status).toBe(400);
		const res = await call("/api/account", { method: "DELETE", as: user, json: { confirm: true } });
		expect(res.status).toBe(200);

		const row = db
			.query<{ username: string; role: string | null }, [number]>("SELECT username, role FROM users WHERE id = ?")
			.get(user.id)!;
		expect(row.username).toBe("[deleted]");
		expect((await call("/api/auth/me", { as: user })).data).toBeNull();
		const left = (table: string, column = "user_id") =>
			db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(user.id)!.n;
		expect(left("solo_scores")).toBe(0);
		expect(left("support_tickets")).toBe(0);
		/** The approved submission became a location and stays, credited to the anonymised row. */
		expect(left("submissions", "submitted_by")).toBe(1);
	});

	test("leaves no trace of the name, and takes the ban-evasion flags with it", async () => {
		const user = createUser({ username: "al.the_first" });
		const other = createUser({ username: "al.the_first2" });
		db.run("INSERT INTO evasion_flags (user_id, matched_user_id, signal) VALUES (?, ?, 'device')", [
			other.id,
			user.id,
		]);
		const note = (details: string) =>
			Number(
				db.run("INSERT INTO audit_log (action, details) VALUES ('duel_start', ?)", [details]).lastInsertRowid
			);
		const theirs = note("al.the_first vs al.the_first2, 5 rounds");
		const mention = note("Used the same browser as banned user @al.the_first. Needs a staff decision.");
		db.run(
			"INSERT INTO announcements (title, body, created_by_id, created_by) VALUES ('News', 'Body text', ?, 'Al')",
			[user.id]
		);

		expect((await call("/api/account", { method: "DELETE", as: user, json: { confirm: true } })).status).toBe(200);
		const details = (id: number) =>
			db.query<{ details: string }, [number]>("SELECT details FROM audit_log WHERE id = ?").get(id)!.details;
		/** The other player's longer name starts the same way and must be left whole. */
		expect(details(theirs)).toBe("[deleted] vs al.the_first2, 5 rounds");
		expect(details(mention)).toBe("Used the same browser as banned user [deleted]. Needs a staff decision.");
		expect(
			db
				.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM evasion_flags WHERE matched_user_id = ?")
				.get(user.id)!.n
		).toBe(0);
		expect(
			db
				.query<{ created_by: string }, [number]>("SELECT created_by FROM announcements WHERE created_by_id = ?")
				.get(user.id)!.created_by
		).toBe("[deleted]");
	});

	test("the data export has what the player wrote and uploaded", async () => {
		const user = createUser();
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, hints, submitted_by) VALUES ('s.webp', 1, 2, 'Mine', '[\"near the bridge\"]', ?)",
			[user.id]
		);
		const data = (await call("/api/gdpr/export", { as: user })).data;
		expect(data.submissions[0]).toMatchObject({ image_path: "s.webp", hints: '["near the bridge"]' });
		expect(data.ticket_replies_written).toEqual([]);
		expect(data.account.staff_locked).toBe(false);
	});
});

describe("profiles", () => {
	test("private profiles are hidden from other players but not from their owner or staff", async () => {
		const owner = createUser();
		await post("/api/settings", owner, { profile_private: true });
		expect((await call(`/api/profile/${owner.username}`, { as: createUser() })).status).toBe(403);
		expect((await call(`/api/profile/${owner.username}`, { as: owner })).status).toBe(200);
		expect((await call(`/api/profile/${owner.username}`, { as: createUser({ role: "moderator" }) })).status).toBe(
			200
		);
		expect((await call("/api/profile/nobody-here")).status).toBe(404);
	});
});

describe("suggestions", () => {
	test("new accounts cannot suggest or read the answer map; trusted ones can", async () => {
		const location = createLocation();
		const fresh = createUser();
		expect((await call("/api/locations/with-coords", { as: fresh })).status).toBe(403);
		expect(
			(await post(`/api/locations/${location}/suggest`, fresh, { type: "hint", text: "Near the bridge" })).status
		).toBe(403);

		const staff = createUser({ role: "moderator" });
		expect((await call("/api/locations/with-coords", { as: staff })).status).toBe(200);
		expect(
			(await post(`/api/locations/${location}/suggest`, staff, { type: "hint", text: "Near the bridge" })).status
		).toBe(403);
		await post("/api/suggestions/agree", staff);
		expect(
			(await post(`/api/locations/${location}/suggest`, staff, { type: "hint", text: "Near the bridge" })).status
		).toBe(200);
		expect((await post(`/api/locations/${location}/suggest`, staff, { type: "nonsense" })).status).toBe(400);
	});
});

describe("leaderboards", () => {
	test("tolerate junk query parameters", async () => {
		for (const path of [
			"/api/leaderboard/solo?limit=abc&rounds=x&time_limit=y",
			"/api/leaderboard/solo?limit=-5&sort=avg&rounds=5&time_limit=90",
			"/api/leaderboard/duels?limit=NaN&sort=avg&mode=quickplay",
			"/api/leaderboard/daily?limit=&sort=distance&date=not-a-date",
		]) {
			const res = await call(path);
			expect(res.status).toBe(200);
			expect(res.data).toBeArray();
		}
	});

	test("are read a page at a time, with no player repeated or skipped", async () => {
		const players = Array.from({ length: 5 }, () => createUser());
		/** All level on score, so only the tiebreak keeps the pages apart. */
		for (const player of players) {
			db.run("INSERT INTO solo_scores (user_id, total_score, rounds, max_possible) VALUES (?, 24999, 5, 25000)", [
				player.id,
			]);
		}
		const ids = (rows: { user_id: number }[]) => rows.map((row) => row.user_id);
		const whole = ids((await call("/api/leaderboard/solo?limit=100")).data);
		const paged: number[] = [];
		for (let offset = 0; offset < whole.length; offset += 2) {
			paged.push(...ids((await call(`/api/leaderboard/solo?limit=2&offset=${offset}`)).data));
		}
		expect(paged).toEqual(whole);
		expect(paged).toEqual(expect.arrayContaining(players.map((player) => player.id)));
		expect((await call(`/api/leaderboard/solo?limit=2&offset=${whole.length}`)).data).toEqual([]);
		expect((await call("/api/leaderboard/solo?offset=junk")).status).toBe(200);
	});

	test("stop at a fixed depth however far down they are asked for", async () => {
		expect((await call("/api/leaderboard/solo?offset=500")).data).toEqual([]);
		expect((await call("/api/leaderboard/duels?offset=999999&limit=100")).data).toEqual([]);
		expect((await call("/api/leaderboard/solo?offset=499&limit=100")).data.length).toBeLessThanOrEqual(1);
	});

	test("turn away someone who asks too often", async () => {
		const eager = createUser();
		for (let i = 0; i < 60; i++) expect((await call("/api/leaderboard/daily", { as: eager })).status).toBe(200);
		expect((await call("/api/leaderboard/daily", { as: eager })).status).toBe(429);
		/** It is that player who is held back, not everyone. */
		expect((await call("/api/leaderboard/daily", { as: createUser() })).status).toBe(200);
	});
	test("trimming old solo games never takes a player's best", () => {
		const player = createUser();
		const add = (score: number, daysAgo: number, timeLimit = 90) =>
			db.run(
				"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit, created_at) VALUES (?, ?, 5, 25000, ?, unixepoch() - ?)",
				[player.id, score, timeLimit, daysAgo * 86400]
			);
		add(24000, 30);
		add(9000, 20, 30);
		add(5000, 10);
		add(6000, 2);
		add(7000, 1);
		trimSoloScores(2);
		const left = db
			.query<{ total_score: number }, [number]>(
				"SELECT total_score FROM solo_scores WHERE user_id = ? ORDER BY total_score"
			)
			.all(player.id)
			.map((row) => row.total_score);
		/** The two newest stay, and so do the oldest two: each is the best for its time limit. */
		expect(left).toEqual([6000, 7000, 9000, 24000]);
	});
});
