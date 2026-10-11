import { describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { safeRedirect } from "../src/lib/http";
import { call, createLocation, createUser, post } from "./helpers";

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
		// The approved submission became a location and stays, credited to the anonymised row.
		expect(left("submissions", "submitted_by")).toBe(1);
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
});
