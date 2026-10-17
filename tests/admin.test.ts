import { beforeAll, describe, expect, test } from "bun:test";
import { LIMITS } from "../src/config";
import { db, type Location } from "../src/db";
import { closeDuelByStaff, createRoom, joinRoom } from "../src/game/duels/rooms";
import { utcDate } from "../src/lib/time";
import { pruneStaffChat } from "../src/routes/admin/chat";
import { setMaintenance } from "../src/system/maintenance";
import { call, createLocation, createUser, post, resetReviewQueues, type TestUser } from "./helpers";

const getLocation = (id: number) => db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?").get(id);

function createSuggestion(locationId: number, type: string, content: object, image: string | null = null): number {
	const author = createUser();
	return Number(
		db.run(
			"INSERT INTO location_suggestions (location_id, user_id, type, content, image_path) VALUES (?, ?, ?, ?, ?)",
			[locationId, author.id, type, JSON.stringify(content), image]
		).lastInsertRowid
	);
}

beforeAll(resetReviewQueues);

describe("admin access", () => {
	test("players and guests are kept out", async () => {
		expect((await call("/api/admin/stats")).status).toBe(403);
		expect((await call("/api/admin/stats", { as: createUser() })).status).toBe(403);
		expect((await call("/api/admin/stats", { as: createUser({ role: "moderator" }) })).status).toBe(200);
		expect((await call("/api/admin/audit", { as: createUser({ role: "moderator" }) })).status).toBe(403);
		expect(
			(await call("/api/admin/audit?q=50%25&limit=x", { as: createUser({ role: "supervisor" }) })).status
		).toBe(200);
	});
});

describe("admin users", () => {
	test("staff cannot moderate themselves or anyone of equal or higher rank", async () => {
		const mod = createUser({ role: "moderator" });
		const otherMod = createUser({ role: "moderator" });
		const supervisor = createUser({ role: "supervisor" });
		expect(
			(await post(`/api/admin/users/${mod.id}/ban`, mod, { type: "temp", hours: 1, reason: "Testing ranks" }))
				.status
		).toBe(403);
		expect(
			(
				await post(`/api/admin/users/${otherMod.id}/ban`, mod, {
					type: "temp",
					hours: 1,
					reason: "Testing ranks",
				})
			).status
		).toBe(403);
		expect(
			(
				await post(`/api/admin/users/${supervisor.id}/limit`, mod, {
					type: "duel",
					hours: 1,
					reason: "Testing ranks",
				})
			).status
		).toBe(403);
		expect(
			(await post("/api/admin/users/999999/ban", mod, { type: "temp", hours: 1, reason: "Testing ranks" })).status
		).toBe(404);
	});

	test("every action needs a reason and lands in the user's history", async () => {
		const mod = createUser({ role: "moderator" });
		const player = createUser();
		expect((await post(`/api/admin/users/${player.id}/warn`, mod, {})).status).toBe(400);
		expect((await post(`/api/admin/users/${player.id}/ban`, mod, { type: "temp", hours: 2 })).status).toBe(400);
		expect(
			(await post(`/api/admin/users/${player.id}/ban`, mod, { type: "temp", reason: "Spamming rooms" })).status
		).toBe(400);
		expect((await post(`/api/admin/users/${player.id}/limit`, mod, { type: "upload", hours: 1 })).status).toBe(400);
		expect(
			(await post(`/api/admin/users/${player.id}/ban`, mod, { type: "perm", reason: "Too harsh for a mod" }))
				.status
		).toBe(403);

		expect((await post(`/api/admin/users/${player.id}/warn`, mod, { reason: "Rude in a duel" })).status).toBe(200);
		expect(
			(
				await post(`/api/admin/users/${player.id}/limit`, mod, {
					type: "upload",
					hours: 1,
					reason: "Joke uploads",
				})
			).status
		).toBe(200);
		expect(
			(await post(`/api/admin/users/${player.id}/ban`, mod, { type: "temp", hours: 2, reason: "Spamming rooms" }))
				.status
		).toBe(200);
		expect((await call("/api/auth/me", { as: player })).data).toMatchObject({
			is_banned: true,
			ban_type: "temp",
			upload_limited: true,
		});

		const history = await call(`/api/admin/users/${player.id}/moderation`, { as: mod });
		expect(history.data.actions.map((a: any) => [a.type, a.status, a.reason])).toEqual([
			["ban_temp", "active", "Spamming rooms"],
			["limit_upload", "active", "Joke uploads"],
			["warning", "active", "Rude in a duel"],
		]);
		expect(history.data.actions.every((a: any) => !a.can_overturn && !a.can_delete)).toBe(true);
		const own = await call("/api/me/moderation", { as: player });
		expect(own.data.actions).toHaveLength(3);
		expect(JSON.stringify(own.data)).not.toContain("issued_by");
	});

	test("overturning and deleting follow rank", async () => {
		const mod = createUser({ role: "moderator" });
		const supervisor = createUser({ role: "supervisor" });
		const operator = createUser({ role: "operator" });
		const player = createUser();
		await post(`/api/admin/users/${player.id}/warn`, mod, { reason: "First warning" });
		await post(`/api/admin/users/${player.id}/ban`, mod, { type: "temp", hours: 5, reason: "Cooling off" });
		await post(`/api/admin/users/${player.id}/ban`, supervisor, { type: "perm", reason: "Repeated cheating" });
		const actions = () =>
			call(`/api/admin/users/${player.id}/moderation`, { as: operator }).then((r) => r.data.actions);
		const [perm, temp, warning] = await actions();

		expect(
			(await post(`/api/admin/moderation/${warning.id}/overturn`, mod, { reason: "Changed my mind" })).status
		).toBe(403);
		expect((await post(`/api/admin/users/${player.id}/unban`, mod, { reason: "Changed my mind" })).status).toBe(
			403
		);
		expect((await post(`/api/admin/moderation/${warning.id}/overturn`, supervisor, {})).status).toBe(400);
		expect(
			(await post(`/api/admin/moderation/${warning.id}/overturn`, supervisor, { reason: "Appeal accepted" }))
				.status
		).toBe(200);
		expect(
			(await post(`/api/admin/moderation/${warning.id}/overturn`, supervisor, { reason: "Appeal accepted" }))
				.status
		).toBe(400);
		expect(
			(await post(`/api/admin/moderation/${temp.id}/overturn`, supervisor, { reason: "Appeal accepted" })).status
		).toBe(200);
		expect((await call("/api/auth/me", { as: player })).data).toMatchObject({ is_banned: true, ban_type: "perm" });
		expect(
			(await post(`/api/admin/moderation/${perm.id}/overturn`, supervisor, { reason: "Appeal accepted" })).status
		).toBe(403);
		expect((await call(`/api/admin/moderation/${perm.id}`, { method: "DELETE", as: supervisor })).status).toBe(403);
		expect(
			(await post(`/api/admin/moderation/${perm.id}/overturn`, operator, { reason: "Wrong account" })).status
		).toBe(200);
		expect((await call("/api/auth/me", { as: player })).data.is_banned).toBe(false);

		expect((await actions()).map((a: any) => a.status)).toEqual(["overturned", "overturned", "overturned"]);
		expect((await call(`/api/admin/moderation/${perm.id}`, { method: "DELETE", as: operator })).status).toBe(200);
		expect(await actions()).toHaveLength(2);
	});

	test("a ban that has run out stops applying by itself", async () => {
		const mod = createUser({ role: "moderator" });
		const player = createUser();
		await post(`/api/admin/users/${player.id}/ban`, mod, { type: "temp", hours: 1, reason: "Short break" });
		db.run("UPDATE moderation_actions SET expires_at = unixepoch() - 5 WHERE user_id = ?", [player.id]);
		db.run("UPDATE users SET ban_expires_at = unixepoch() - 5 WHERE id = ?", [player.id]);
		expect((await call("/api/auth/me", { as: player })).data.is_banned).toBe(false);
		const history = await call(`/api/admin/users/${player.id}/moderation`, { as: mod });
		expect(history.data.actions[0].status).toBe("expired");
	});
});

describe("admin locations", () => {
	test("a location that was a daily challenge and a duel round can still be deleted", async () => {
		const id = createLocation();
		const player = createUser();
		db.run("INSERT INTO daily_challenges (date, location_id) VALUES (?, ?)", [utcDate(-30), id]);
		const game = Number(
			db.run("INSERT INTO duel_games (room_code, created_by, status) VALUES ('DELETE', ?, 'finished')", [
				player.id,
			]).lastInsertRowid
		);
		db.run("INSERT INTO duel_round_scores (game_id, user_id, round_number, location_id) VALUES (?, ?, 1, ?)", [
			game,
			player.id,
			id,
		]);

		expect(
			(await call(`/api/admin/locations/${id}`, { method: "DELETE", as: createUser({ role: "moderator" }) }))
				.status
		).toBe(403);
		expect(
			(await call(`/api/admin/locations/${id}`, { method: "DELETE", as: createUser({ role: "operator" }) }))
				.status
		).toBe(200);
		expect(getLocation(id)).toBeNull();
	});

	test("toggle, label and hints edits", async () => {
		const mod = createUser({ role: "moderator" });
		const id = createLocation();
		expect((await post(`/api/admin/locations/${id}/toggle`, mod)).data.is_active).toBe(false);
		expect((await post(`/api/admin/locations/${id}/label`, mod, { label: "x" })).status).toBe(400);
		expect((await post(`/api/admin/locations/${id}/label`, mod, { label: "Platform 2" })).status).toBe(200);
		expect((await post(`/api/admin/locations/${id}/hints`, mod, { hints: ["a", " ", "b", "c", "d"] })).status).toBe(
			200
		);
		expect(getLocation(id)).toMatchObject({ is_active: 0, label: "Platform 2", hints: '["a","b","c"]' });
		expect((await post("/api/admin/locations/999999/toggle", mod)).status).toBe(404);
	});
});

describe("admin submissions", () => {
	test("approving creates one location, and a submission cannot be reviewed twice", async () => {
		const mod = createUser({ role: "moderator" });
		const author = createUser();
		const id = Number(
			db.run(
				"INSERT INTO submissions (image_path, world_x, world_y, label, hints, submitted_by) VALUES ('sub.webp', 5, 6, 'The old signal box', '[\"h\"]', ?)",
				[author.id]
			).lastInsertRowid
		);
		expect((await post(`/api/admin/submissions/${id}/approve`, mod, { label: "no" })).status).toBe(400);
		expect((await post(`/api/admin/submissions/${id}/approve`, mod)).status).toBe(200);
		expect((await post(`/api/admin/submissions/${id}/approve`, mod)).status).toBe(404);
		expect((await post(`/api/admin/submissions/${id}/deny`, mod, { reason: "late" })).status).toBe(404);
		const created = db.query<Location, []>("SELECT * FROM locations WHERE image_path = 'sub.webp'").all();
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ label: "The old signal box", hints: '["h"]', submitted_by: author.id });
	});
});

describe("admin suggestions", () => {
	const mod = createUser({ role: "moderator" });
	const approve = (id: number) => post(`/api/admin/suggestions/${id}/approve`, mod);

	test("a full edit applies every field it carries", async () => {
		const id = createLocation({ x: 1, y: 1, label: "Old label", hints: ["old"] });
		const sug = createSuggestion(
			id,
			"full_edit",
			{ world_x: 50, world_y: 60, hints: ["new"], label: "New label", note: "n" },
			"new.webp"
		);
		expect((await approve(sug)).status).toBe(200);
		expect(getLocation(id)).toMatchObject({
			world_x: 50,
			world_y: 60,
			label: "New label",
			hints: '["new"]',
			image_path: "new.webp",
		});
	});

	test("a full edit leaves untouched fields alone", async () => {
		const id = createLocation({ x: 1, y: 2, label: "Keep me", hints: ["keep"] });
		const sug = createSuggestion(id, "full_edit", {
			world_x: null,
			world_y: null,
			hints: [],
			label: "Renamed",
			note: null,
		});
		expect((await approve(sug)).status).toBe(200);
		expect(getLocation(id)).toMatchObject({ world_x: 1, world_y: 2, label: "Renamed", hints: '["keep"]' });
	});

	test("a removal takes the location out of play", async () => {
		const id = createLocation();
		expect((await approve(createSuggestion(id, "removal", { reason: "duplicate" }))).status).toBe(200);
		expect(getLocation(id)!.is_active).toBe(0);
	});

	test("a hint is refused when the location is already full, and stays pending", async () => {
		const id = createLocation({ hints: ["a", "b", "c"] });
		const sug = createSuggestion(id, "hint", { text: "d" });
		expect((await approve(sug)).status).toBe(400);
		expect(
			db.query<{ status: string }, [number]>("SELECT status FROM location_suggestions WHERE id = ?").get(sug)!
				.status
		).toBe("pending");
		expect((await post(`/api/admin/suggestions/${sug}/deny`, mod, {})).status).toBe(400);
		expect(
			(await post(`/api/admin/suggestions/${sug}/deny`, mod, { reason: "The location already has three hints" }))
				.status
		).toBe(200);
		expect((await approve(sug)).status).toBe(404);
	});
});

describe("support", () => {
	test("ticket thread between a player and staff", async () => {
		const player = createUser();
		const mod = createUser({ role: "moderator" });
		expect(
			(await post("/api/support", player, { subject: "Hi", message: "short", category: "other" })).status
		).toBe(400);
		const created = await post("/api/support", player, {
			subject: "Wrong pin",
			message: "The pin for this location is off by a mile.",
			category: "report_location",
		});
		expect(created.status).toBe(200);
		const id = created.data.id;

		expect((await post(`/api/support/${id}/reply`, player, { message: "Forgot to say which one." })).status).toBe(
			200
		);
		expect((await post(`/api/support/${id}/reply`, player, { message: "It is LOC-0003." })).status).toBe(200);
		expect((await post(`/api/support/${id}/reply`, player, { message: "Anyone there?" })).status).toBe(400);
		expect((await post(`/api/admin/support/${id}/reply`, mod, {})).status).toBe(400);
		expect((await post(`/api/admin/support/${id}/reply`, mod, { reply: "Thanks, looking into it." })).status).toBe(
			200
		);
		expect((await post(`/api/support/${id}/reply`, player, { message: "Great, thank you!" })).status).toBe(200);

		const mine = await call("/api/support/mine", { as: player });
		expect(mine.data[0].replies.map((r: any) => r.type)).toEqual(["user", "user", "staff", "user"]);
		expect((await call("/api/admin/support?status=open", { as: mod })).data.some((t: any) => t.id === id)).toBe(
			true
		);

		expect((await post(`/api/admin/support/${id}/reply`, mod, { reply: "Fixed.", close: true })).status).toBe(200);
		expect((await post(`/api/support/${id}/reply`, player, { message: "Thanks again" })).status).toBe(400);
		expect((await post("/api/admin/support/999999/reply", mod, { reply: "hello there" })).status).toBe(404);
	});
});

describe("operators managing a player's scores", () => {
	const seed = () => {
		const player = createUser();
		const rival = createUser();
		const solo = Number(
			db.run("INSERT INTO solo_scores (user_id, total_score, rounds, max_possible) VALUES (?, 20000, 5, 25000)", [
				player.id,
			]).lastInsertRowid
		);
		const daily = Number(
			db.run("INSERT INTO daily_scores (user_id, date, score) VALUES (?, '2026-01-01', 4000)", [player.id])
				.lastInsertRowid
		);
		const duel = Number(
			db.run(
				"INSERT INTO duel_games (room_code, status, created_by, winner_id, finished_at) VALUES (?, 'finished', ?, ?, unixepoch())",
				[`SC${player.id}`.padEnd(6, "X"), player.id, player.id]
			).lastInsertRowid
		);
		for (const u of [player, rival])
			db.run("INSERT INTO duel_participants (game_id, user_id, total_score) VALUES (?, ?, 9000)", [duel, u.id]);
		db.run("UPDATE users SET current_streak = 6, longest_streak = 9 WHERE id = ?", [player.id]);
		return { player, rival, solo, daily, duel };
	};
	const reason = "F1: scores came from a script";

	test("only operators may look or change anything", async () => {
		const { player, solo } = seed();
		const supervisor = createUser({ role: "supervisor" });
		expect((await call(`/api/admin/scores/${player.id}`, { as: supervisor })).status).toBe(403);
		expect((await post(`/api/admin/scores/${player.id}/reset`, supervisor, { scope: "all", reason })).status).toBe(
			403
		);
		expect(
			(
				await call(`/api/admin/scores/${player.id}/solo/${solo}`, {
					method: "DELETE",
					as: player,
					json: { reason },
				})
			).status
		).toBe(403);
	});

	test("a score can be corrected or removed, with a reason, and the player is told", async () => {
		const { player, solo, daily } = seed();
		const op = createUser({ role: "operator" });
		expect((await post(`/api/admin/scores/${player.id}/solo/${solo}`, op, { total_score: 100 })).status).toBe(400);
		expect(
			(await post(`/api/admin/scores/${player.id}/solo/${solo}`, op, { total_score: 99999, reason })).status
		).toBe(400);
		expect(
			(await post(`/api/admin/scores/${player.id}/solo/${solo}`, op, { total_score: 12000, reason })).status
		).toBe(200);
		expect((await post(`/api/admin/scores/${player.id}/daily/${daily}`, op, { score: 1500, reason })).status).toBe(
			200
		);

		const view = (await call(`/api/admin/scores/${player.id}`, { as: op })).data;
		expect(view.solo[0].total_score).toBe(12000);
		expect(view.daily[0].score).toBe(1500);

		expect(
			(
				await call(`/api/admin/scores/${player.id}/daily/${daily}`, {
					method: "DELETE",
					as: op,
					json: { reason },
				})
			).status
		).toBe(200);
		expect((await call(`/api/admin/scores/${player.id}`, { as: op })).data.daily).toHaveLength(0);

		const told = (await call("/api/notifications", { as: player })).data.notifications;
		expect(told.some((n: { title: string }) => n.title.includes("corrected by staff"))).toBe(true);
		expect(JSON.stringify(told)).not.toContain(op.username);
		expect(
			db.query("SELECT 1 FROM audit_log WHERE action = 'score_edit' AND target_id = ?").get(player.id)
		).not.toBeNull();
	});

	test("voiding a duel removes it for both players, and a reset wipes the rest", async () => {
		const { player, rival, duel } = seed();
		const op = createUser({ role: "operator" });
		expect(
			(await call(`/api/admin/scores/${player.id}/duels/${duel}`, { method: "DELETE", as: op, json: { reason } }))
				.status
		).toBe(200);
		expect(db.query("SELECT 1 FROM duel_participants WHERE user_id = ?").get(rival.id)).toBeNull();

		expect(
			(await post(`/api/admin/scores/${player.id}/streak`, op, { current: 5, longest: 2, reason })).status
		).toBe(400);
		expect(
			(await post(`/api/admin/scores/${player.id}/streak`, op, { current: 2, longest: 4, reason })).status
		).toBe(200);
		expect((await post(`/api/admin/scores/${player.id}/reset`, op, { scope: "everything", reason })).status).toBe(
			400
		);
		expect((await post(`/api/admin/scores/${player.id}/reset`, op, { scope: "all", reason })).status).toBe(200);

		const view = (await call(`/api/admin/scores/${player.id}`, { as: op })).data;
		expect(view).toMatchObject({ solo: [], daily: [], duels: [], streak: { current: 0, longest: 0 } });
	});
});

describe("locking a member of staff out", () => {
	const reason = "Account looks compromised";

	test("a supervisor can lock out a moderator, who then counts as an ordinary player", async () => {
		const supervisor = createUser({ role: "supervisor" });
		const moderator = createUser({ role: "moderator" });
		const victim = createUser();
		expect((await call("/api/admin/stats", { as: moderator })).status).toBe(200);
		expect((await post(`/api/admin/users/${moderator.id}/staff-lock`, supervisor, {})).status).toBe(400);
		expect((await post(`/api/admin/users/${moderator.id}/staff-lock`, supervisor, { reason })).status).toBe(200);

		expect((await call("/api/admin/stats", { as: moderator })).status).toBe(403);
		expect(
			(
				await post(`/api/admin/users/${victim.id}/ban`, moderator, {
					type: "temp",
					hours: 1,
					reason: "Abuse attempt",
				})
			).status
		).toBe(403);
		const me = (await call("/api/auth/me", { as: moderator })).data;
		expect(me).toMatchObject({ role: null, staff_locked: true });
		expect((await call("/api/attention", { as: moderator })).data.staff).toBeNull();
		expect((await call("/api/daily", { as: moderator })).status).toBe(200);

		expect(
			(await post(`/api/admin/users/${moderator.id}/staff-unlock`, supervisor, { reason: "Password changed" }))
				.status
		).toBe(200);
		expect((await call("/api/admin/stats", { as: moderator })).status).toBe(200);
		expect((await call("/api/auth/me", { as: moderator })).data.role).toBe("moderator");
	});

	test("only someone of higher rank can do it", async () => {
		const [modA, modB] = [createUser({ role: "moderator" }), createUser({ role: "moderator" })];
		const [supA, supB] = [createUser({ role: "supervisor" }), createUser({ role: "supervisor" })];
		const operator = createUser({ role: "operator" });
		expect((await post(`/api/admin/users/${modB.id}/staff-lock`, modA, { reason })).status).toBe(403);
		expect((await post(`/api/admin/users/${supB.id}/staff-lock`, supA, { reason })).status).toBe(403);
		expect((await post(`/api/admin/users/${operator.id}/staff-lock`, supA, { reason })).status).toBe(403);
		expect((await post(`/api/admin/users/${supA.id}/staff-lock`, supA, { reason })).status).toBe(403);
		expect((await post(`/api/admin/users/${createUser().id}/staff-lock`, supA, { reason })).status).toBe(400);
		expect((await post(`/api/admin/users/${supB.id}/staff-lock`, operator, { reason })).status).toBe(200);
		expect((await post(`/api/admin/users/${modA.id}/staff-lock`, supB, { reason })).status).toBe(403);
	});
});

describe("helpers", () => {
	const pending = (author: TestUser) =>
		Number(
			db.run(
				"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES ('helper.webp', 1, 2, 'The coal stage', ?)",
				[author.id]
			).lastInsertRowid
		);

	test("review submissions and suggestions, see locations, and nothing else", async () => {
		const helper = createUser({ role: "helper" });
		const author = createUser();
		expect((await call("/api/auth/me", { as: helper })).data.role).toBe("helper");

		expect((await call("/api/admin/submissions", { as: helper })).status).toBe(200);
		expect((await call("/api/admin/suggestions", { as: helper })).status).toBe(200);
		expect((await call("/api/admin/locations", { as: helper })).status).toBe(403);
		expect((await call("/api/admin/locations", { as: createUser({ role: "curator" }) })).status).toBe(200);
		expect((await post(`/api/admin/submissions/${pending(author)}/approve`, helper)).status).toBe(200);
		expect(
			(await post(`/api/admin/submissions/${pending(author)}/deny`, helper, { reason: "Not a railway location" }))
				.status
		).toBe(200);

		const location = db.query<{ id: number }, []>("SELECT id FROM locations ORDER BY id DESC LIMIT 1").get()!.id;
		for (const [path, body] of [
			[`/api/admin/locations/${location}/toggle`, undefined],
			[`/api/admin/locations/${location}/label`, { label: "Renamed by a helper" }],
			[`/api/admin/users/${author.id}/warn`, { reason: "Helpers cannot warn" }],
			[`/api/admin/users/${author.id}/staff-lock`, { reason: "Helpers cannot lock" }],
		] as const)
			expect((await post(path, helper, body)).status).toBe(403);
		for (const path of ["/api/admin/users", "/api/admin/support", "/api/admin/stats", "/api/admin/audit"])
			expect((await call(path, { as: helper })).status).toBe(403);
		expect((await call(`/api/admin/locations/${location}`, { method: "DELETE", as: helper })).status).toBe(403);

		const queue = (await call("/api/attention", { as: helper })).data.staff;
		expect(queue).toMatchObject({ tickets: 0, users: 0 });
		expect(queue.total).toBe(queue.submissions + queue.suggestions);
	});

	test("get none of the wider staff privileges, and lose the panel when suspended", async () => {
		const helper = createUser({ role: "helper" });
		const moderator = createUser({ role: "moderator" });

		const location = createLocation();
		const removal = createSuggestion(location, "removal", { reason: "duplicate" });
		expect((await post(`/api/admin/suggestions/${removal}/approve`, helper)).status).toBe(200);
		expect(getLocation(location)).toMatchObject({ id: location, is_active: 0 });
		const hint = createSuggestion(location, "hint", { text: "Near the water tower" });
		expect((await post(`/api/admin/suggestions/${hint}/deny`, helper, {})).status).toBe(400);
		expect(
			(await post(`/api/admin/suggestions/${hint}/deny`, helper, { reason: "Too vague to help" })).status
		).toBe(200);

		const shy = createUser();
		await post("/api/settings", shy, { profile_private: true });
		expect((await call(`/api/profile/${shy.username}`, { as: helper })).status).toBe(403);
		expect((await call(`/api/profile/${shy.username}`, { as: moderator })).status).toBe(200);

		setMaintenance(true, "Back soon", "test");
		try {
			expect((await call("/api/leaderboard/solo", { as: helper })).status).toBe(503);
			expect((await call("/api/admin/submissions", { as: helper })).status).toBe(503);
			expect((await call("/api/leaderboard/solo", { as: moderator })).status).toBe(200);
			expect((await call("/api/auth/me", { as: helper })).data.maintenance).toBe(false);
		} finally {
			setMaintenance(false, "", "test");
		}

		expect((await post(`/api/admin/users/${helper.id}/role`, helper, { role: "moderator" })).status).toBe(403);
		expect((await post(`/api/admin/users/${shy.id}/role`, helper, { role: "helper" })).status).toBe(403);
		for (const path of ["/api/admin/system/info", "/api/admin/announcements", `/api/admin/scores/${shy.id}`])
			expect((await call(path, { as: helper })).status).toBe(403);

		expect(
			(
				await post(`/api/admin/users/${helper.id}/staff-lock`, moderator, {
					reason: "Approving without checking",
				})
			).status
		).toBe(200);
		const me = (await call("/api/auth/me", { as: helper })).data;
		expect(me).toMatchObject({ role: null, staff_locked: true });
		expect((await call("/api/admin/locations", { as: helper })).status).toBe(403);
		expect((await call("/api/attention", { as: helper })).data.staff).toBeNull();
		expect(db.query<{ role: string }, [number]>("SELECT role FROM users WHERE id = ?").get(helper.id)!.role).toBe(
			"helper"
		);
	});

	test("supervisors appoint and remove them; moderators can only suspend them", async () => {
		const [operator, supervisor, moderator] = (["operator", "supervisor", "moderator"] as const).map((role) =>
			createUser({ role })
		);
		const recruit = createUser();
		const roleOf = (user: TestUser) =>
			db.query<{ role: string | null }, [number]>("SELECT role FROM users WHERE id = ?").get(user.id)!.role;
		const setRole = (as: TestUser, target: TestUser, role: string | null) =>
			post(`/api/admin/users/${target.id}/role`, as, { role });

		expect((await setRole(moderator, recruit, "helper")).status).toBe(403);
		expect((await setRole(supervisor, recruit, "helper")).status).toBe(200);
		expect(roleOf(recruit)).toBe("helper");
		expect((await setRole(supervisor, recruit, "supervisor")).status).toBe(403);
		expect((await setRole(operator, recruit, "moderator")).status).toBe(200);
		expect((await setRole(supervisor, recruit, "helper")).status).toBe(200);

		const lock = (as: TestUser, target: TestUser, action: "staff-lock" | "staff-unlock") =>
			post(`/api/admin/users/${target.id}/${action}`, as, { reason: "Checking the helper lock" });
		expect((await lock(moderator, recruit, "staff-lock")).status).toBe(200);
		expect((await call("/api/admin/submissions", { as: recruit })).status).toBe(403);
		expect((await lock(moderator, recruit, "staff-unlock")).status).toBe(200);
		expect((await call("/api/admin/submissions", { as: recruit })).status).toBe(200);
		expect((await lock(moderator, createUser({ role: "moderator" }), "staff-lock")).status).toBe(403);
		expect((await lock(recruit, createUser({ role: "helper" }), "staff-lock")).status).toBe(403);

		expect((await setRole(supervisor, recruit, null)).status).toBe(200);
		expect(roleOf(recruit)).toBeNull();
	});
});

describe("admin overview and staff notes", () => {
	test("the overview shows each role only its own queues", async () => {
		const helper = (await call("/api/admin/overview", { as: createUser({ role: "helper" }) })).data;
		const senior = (await call("/api/admin/overview", { as: createUser({ role: "supervisor" }) })).data;
		expect((await call("/api/admin/overview", { as: createUser() })).status).toBe(403);
		expect(helper.waiting.map((queue: { tab: string }) => queue.tab)).toEqual(["submissions", "suggestions"]);
		expect(senior.waiting.length).toBeGreaterThan(helper.waiting.length);
		expect(helper.flagged).toEqual([]);
		expect(typeof senior.live.duels).toBe("number");
	});

	test("notes are kept per player, and only the author or a supervisor can remove one", async () => {
		const player = createUser();
		const author = createUser({ role: "moderator" });
		const otherMod = createUser({ role: "moderator" });
		const notesOf = async () => (await call(`/api/admin/users/${player.id}/moderation`, { as: author })).data.notes;

		expect(
			(await post(`/api/admin/users/${player.id}/notes`, createUser({ role: "helper" }), { body: "No" })).status
		).toBe(403);
		expect((await post(`/api/admin/users/${player.id}/notes`, author, { body: " " })).status).toBe(400);
		expect(
			(await post(`/api/admin/users/${player.id}/notes`, author, { body: "Asked about a ban twice" })).status
		).toBe(200);
		const [note] = await notesOf();
		expect(note.body).toBe("Asked about a ban twice");
		expect(note.author_username).toBe(author.username);

		const remove = (as: TestUser) => call(`/api/admin/users/notes/${note.id}`, { as, method: "DELETE" });
		expect((await remove(otherMod)).status).toBe(403);
		expect((await remove(createUser({ role: "supervisor" }))).status).toBe(200);
		expect(await notesOf()).toEqual([]);
	});
});

describe("admin claims, history and insight", () => {
	test("a claim shows to other staff, never to its owner, and tickets stay hidden from helpers", async () => {
		const mod = createUser({ role: "moderator" });
		const helper = createUser({ role: "helper" });
		expect((await post("/api/admin/claims", createUser(), {})).status).toBe(403);
		expect((await post("/api/admin/claims", mod, { kind: "ticket", id: 7 })).data).toEqual([]);
		expect((await post("/api/admin/claims", helper, { kind: "ticket", id: 9 })).data).toEqual([]);
		const seen = (await post("/api/admin/claims", createUser({ role: "moderator" }), {})).data;
		expect(seen.map((claim: { kind: string; id: number }) => `${claim.kind}:${claim.id}`)).toEqual(["ticket:7"]);

		await post("/api/admin/claims", mod, { kind: "submission", id: 3 });
		expect((await post("/api/admin/claims", helper, {})).data[0].id).toBe(3);
		await post("/api/admin/claims", mod, {});
		expect((await post("/api/admin/claims", helper, {})).data).toEqual([]);
	});

	test("reviewed lists, location breakdown and duel history answer for the right roles", async () => {
		const helper = createUser({ role: "helper" });
		const mod = createUser({ role: "moderator" });
		const location = createLocation();
		expect((await call("/api/admin/submissions/history", { as: helper })).status).toBe(200);
		expect((await call("/api/admin/suggestions/history", { as: helper })).status).toBe(200);
		const curator = createUser({ role: "curator" });
		expect((await call(`/api/admin/locations/${location}/breakdown`, { as: helper })).status).toBe(403);
		const breakdown = await call(`/api/admin/locations/${location}/breakdown`, { as: curator });
		expect(breakdown.data.totals.plays).toBe(0);
		expect((await call("/api/admin/locations/999999/breakdown", { as: curator })).status).toBe(404);
		expect((await call("/api/admin/duels", { as: helper })).status).toBe(403);
		expect(Array.isArray((await call("/api/admin/duels?kind=quickplay&q=%25", { as: mod })).data.games)).toBe(true);
		expect(typeof (await call("/api/admin/duels/stats", { as: mod })).data.finished.total).toBe("number");
		expect((await call(`/api/admin/users/${helper.id}/moderation`, { as: mod })).data.account.sessions).toBe(1);
	});

	test("a switched-off feature refuses players but not staff", async () => {
		const operator = createUser({ role: "operator" });
		const toggle = (enabled: boolean) =>
			post("/api/admin/system/features", operator, { feature: "new_duels", enabled });
		expect((await toggle(false)).status).toBe(200);
		try {
			expect((await post("/api/duels/rooms", createUser(), { rounds: 1 })).status).toBe(503);
			expect((await post("/api/duels/rooms", createUser({ role: "moderator" }), { rounds: 1 })).status).toBe(200);
		} finally {
			await toggle(true);
		}
		expect((await post("/api/duels/rooms", createUser(), { rounds: 1 })).status).toBe(200);
	});
});

describe("curators, admins and helpers", () => {
	test("a curator edits locations but has nothing to do with players", async () => {
		const curator = createUser({ role: "curator" });
		const location = createLocation();
		expect(
			(await post(`/api/admin/locations/${location}/label`, curator, { label: "Tidied by a curator" })).status
		).toBe(200);
		expect((await post(`/api/admin/locations/${location}/toggle`, curator)).status).toBe(200);
		expect((await call(`/api/admin/locations/${location}`, { method: "DELETE", as: curator })).status).toBe(403);
		for (const path of ["/api/admin/users", "/api/admin/support", "/api/admin/duels", "/api/admin/stats"])
			expect([path, (await call(path, { as: curator })).status]).toEqual([path, 403]);
		expect(
			(await post(`/api/admin/users/${createUser().id}/warn`, curator, { reason: "Not a curator's job" })).status
		).toBe(403);
	});

	test("an admin sits between supervisor and operator", async () => {
		const admin = createUser({ role: "admin" });
		const supervisor = createUser({ role: "supervisor" });
		const operator = createUser({ role: "operator" });
		const recruit = createUser();
		const setRole = (as: TestUser, role: string | null) =>
			post(`/api/admin/users/${recruit.id}/role`, as, { role });

		expect((await setRole(supervisor, "supervisor")).status).toBe(403);
		expect((await setRole(supervisor, "curator")).status).toBe(200);
		expect((await setRole(admin, "supervisor")).status).toBe(200);
		expect((await setRole(admin, "admin")).status).toBe(403);
		expect((await setRole(operator, "admin")).status).toBe(200);
		expect((await setRole(admin, null)).status).toBe(403);
		expect((await setRole(operator, null)).status).toBe(200);

		expect((await call("/api/admin/announcements", { as: supervisor })).status).toBe(403);
		expect((await call("/api/admin/announcements", { as: admin })).status).toBe(200);
		expect((await call(`/api/admin/scores/${recruit.id}`, { as: admin })).status).toBe(200);
		expect((await call("/api/admin/system/info", { as: admin })).status).toBe(403);
		expect((await call(`/api/admin/users/${recruit.id}/gdpr-export`, { as: admin })).status).toBe(403);
	});

	test("a helper is a player with review perks, not staff", async () => {
		const helper = createUser({ role: "helper" });
		const operator = createUser({ role: "operator" });
		const toggle = (enabled: boolean) =>
			post("/api/admin/system/features", operator, { feature: "new_duels", enabled });
		await toggle(false);
		try {
			expect((await post("/api/duels/rooms", helper, { rounds: 1 })).status).toBe(503);
			expect((await post("/api/duels/rooms", createUser({ role: "curator" }), { rounds: 1 })).status).toBe(200);
		} finally {
			await toggle(true);
		}

		const near = createLocation({ x: 71000, y: 71000 });
		createLocation({ x: 79000, y: 79000 });
		const author = createUser();
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES ('near.webp', 71050, 71000, 'Close to one', ?)",
			[author.id]
		);
		const queue = (await call("/api/admin/submissions", { as: helper })).data;
		const mine = queue.find((s: { label: string }) => s.label === "Close to one");
		expect(mine.nearby.map((spot: { id: number }) => spot.id)).toEqual([near]);
		expect(mine.nearby[0].distance).toBe(50);

		await post(`/api/admin/submissions/${mine.id}/deny`, createUser({ role: "moderator" }), {
			reason: "Someone else reviewed it",
		});
		const reviewedIds = async (as: TestUser) =>
			(await call("/api/admin/submissions/history", { as })).data.map((s: { id: number }) => s.id);
		expect(await reviewedIds(helper)).not.toContain(mine.id);
		expect(await reviewedIds(createUser({ role: "curator" }))).toContain(mine.id);
	});
});

describe("taking back an announcement", () => {
	test("wording can be fixed and the announcement recalled while it is new", async () => {
		const admin = createUser({ role: "admin" });
		const reader = createUser();
		const inbox = async () =>
			(await call("/api/notifications", { as: reader })).data.notifications.filter(
				(n: { category: string }) => n.category === "announcements"
			);
		const sent = await post("/api/admin/announcements", admin, {
			title: "Servr maintenance",
			body: "The site will be down for an hour on Friday.",
			audience: "everyone",
		});
		expect(sent.status).toBe(200);
		const id = sent.data.id;
		expect((await inbox())[0].title).toBe("Servr maintenance");

		expect(
			(await post(`/api/admin/announcements/${id}/correct`, createUser({ role: "supervisor" }), {})).status
		).toBe(403);
		const fixed = await post(`/api/admin/announcements/${id}/correct`, admin, {
			title: "Server maintenance",
			body: "The site will be down for an hour on Friday.",
		});
		expect(fixed.status).toBe(200);
		expect((await inbox())[0].title).toBe("Server maintenance");

		const recalled = await post(`/api/admin/announcements/${id}/recall`, admin);
		expect(recalled.data.removed).toBeGreaterThan(0);
		expect(await inbox()).toEqual([]);
		expect((await post(`/api/admin/announcements/${id}/recall`, admin)).status).toBe(409);

		const old = (
			await post("/api/admin/announcements", admin, { title: "An older note", body: "Sent a while ago now." })
		).data.id;
		db.run("UPDATE announcements SET created_at = unixepoch() - 25 * 3600 WHERE id = ?", [old]);
		expect((await post(`/api/admin/announcements/${old}/recall`, admin)).status).toBe(409);
	});
});

describe("closing a duel from the staff panel", () => {
	test("an administrator sees every open room, private ones too, and can close one with a reason", async () => {
		const mod = createUser({ role: "admin" });
		const host = createUser();
		const code = (await post("/api/duels/rooms", host, { rounds: 1 })).data.code;
		const open = async () =>
			(await call("/api/admin/duels/live", { as: mod })).data.map((room: { code: string }) => room.code);
		expect(await open()).toContain(code);
		expect((await call("/api/admin/duels/live", { as: createUser({ role: "supervisor" }) })).status).toBe(403);
		expect(
			(
				await post(`/api/admin/duels/live/${code}/close`, createUser({ role: "supervisor" }), {
					reason: "Not allowed to",
				})
			).status
		).toBe(403);
		expect((await post(`/api/admin/duels/live/${code}/close`, mod, {})).status).toBe(400);
		expect(await open()).toContain(code);
		expect(
			(await post(`/api/admin/duels/live/${code}/close`, mod, { reason: "Room name was abusive" })).status
		).toBe(200);
		expect(await open()).not.toContain(code);
		expect((await post(`/api/admin/duels/live/${code}/close`, mod, { reason: "Closing it twice" })).status).toBe(
			404
		);
		expect(db.query("SELECT 1 FROM duel_games WHERE room_code = ?").get(code)).toBeNull();
	});

	test("a duel being played is recorded as abandoned, with no winner and no rating change", () => {
		const [a, b] = [createUser(), createUser()];
		for (let i = 0; i < 3; i++) createLocation();
		const room = createRoom(a.id, 1);
		joinRoom(room.code, b.id);
		room.status = "in_progress";
		db.run("UPDATE duel_games SET status = 'in_progress' WHERE id = ?", [room.dbId]);
		const before = db
			.query<{ duel_rating: number | null }, [number]>("SELECT duel_rating FROM users WHERE id = ?")
			.get(a.id);
		expect(closeDuelByStaff(room.code)).not.toBeNull();
		expect(
			db
				.query<{ status: string; winner_id: number | null }, [number]>(
					"SELECT status, winner_id FROM duel_games WHERE id = ?"
				)
				.get(room.dbId)
		).toEqual({ status: "abandoned", winner_id: null });
		expect(
			db.query<{ duel_rating: number | null }, [number]>("SELECT duel_rating FROM users WHERE id = ?").get(a.id)
		).toEqual(before);
	});
});

describe("staff chat", () => {
	const chat = (as: TestUser) => call("/api/admin/chat", { as }).then((r) => r.data.messages);
	const unread = (as: TestUser) => call("/api/admin/chat/unread", { as }).then((r) => r.data.unread);

	test("staff talk in one room; helpers and players are kept out", async () => {
		const curator = createUser({ role: "curator" });
		const moderator = createUser({ role: "moderator" });
		for (const outsider of [createUser(), createUser({ role: "helper" })]) {
			expect((await call("/api/admin/chat", { as: outsider })).status).toBe(403);
			expect((await post("/api/admin/chat", outsider, { body: "Let me in" })).status).toBe(403);
		}
		expect((await post("/api/admin/chat", curator, { body: "   " })).status).toBe(400);

		const before = await unread(moderator);
		const sent = await post("/api/admin/chat", curator, { body: "  Queue is clear  " });
		expect(sent.status).toBe(200);
		expect(await unread(curator)).toBe(0);
		expect(await unread(moderator)).toBe(before + 1);
		expect((await chat(moderator)).at(-1)).toMatchObject({
			id: sent.data.id,
			author_id: curator.id,
			body: "Queue is clear",
			role: "curator",
			can_delete: false,
		});
		expect(await unread(moderator)).toBe(0);
	});

	test("a message can be deleted by its author or by senior staff", async () => {
		const [author, peer, senior] = [
			createUser({ role: "moderator" }),
			createUser({ role: "moderator" }),
			createUser({ role: "supervisor" }),
		];
		const write = async (body: string) => (await post("/api/admin/chat", author, { body })).data.id;
		const remove = (id: number, as: TestUser) => call(`/api/admin/chat/${id}`, { as, method: "DELETE" });
		const [first, second] = [await write("Mine to remove"), await write("Removed by a supervisor")];

		expect((await remove(first, peer)).status).toBe(403);
		expect((await remove(first, author)).status).toBe(200);
		expect((await remove(first, author)).status).toBe(404);
		expect((await chat(senior)).find((m: { id: number }) => m.id === second).can_delete).toBe(true);
		expect((await remove(second, senior)).status).toBe(200);
		const ids = (await chat(peer)).map((m: { id: number }) => m.id);
		expect(ids).not.toContain(first);
		expect(ids).not.toContain(second);
		const logged = db
			.query<{ n: number }, [number]>(
				"SELECT COUNT(*) AS n FROM audit_log WHERE action = 'staff_chat_delete' AND actor_id = ?"
			)
			.get(senior.id)!.n;
		expect(logged).toBe(1);
	});
});

describe("staff chat pins", () => {
	const room = (as: TestUser) => call("/api/admin/chat", { as }).then((r) => r.data);
	const pin = (id: number, as: TestUser, pinned = true) => post(`/api/admin/chat/${id}/pin`, as, { pinned });
	const write = async (as: TestUser, body: string) => (await post("/api/admin/chat", as, { body })).data.id;

	test("each role may hold only so many pins, and a pin comes off for its owner or senior staff", async () => {
		const [curator, moderator, senior] = [
			createUser({ role: "curator" }),
			createUser({ role: "moderator" }),
			createUser({ role: "supervisor" }),
		];
		expect((await room(curator)).pin_limit).toBeLessThan((await room(moderator)).pin_limit);
		const limit = (await room(curator)).pin_limit;
		const ids: number[] = [];
		for (let i = 0; i <= limit; i++) ids.push(await write(curator, `Worth keeping ${i}`));

		expect((await pin(ids[0], createUser({ role: "helper" }))).status).toBe(403);
		for (const id of ids.slice(0, limit)) expect((await pin(id, curator)).status).toBe(200);
		expect((await pin(ids[limit], curator)).status).toBe(409);
		expect((await pin(ids[0], moderator)).status).toBe(200);
		expect(await room(moderator)).toMatchObject({ pins_used: 0 });

		const seen = await room(moderator);
		expect(seen.pins.map((m: { id: number }) => m.id)).toEqual(expect.arrayContaining(ids.slice(0, limit)));
		expect(seen.pins.find((m: { id: number }) => m.id === ids[0])).toMatchObject({
			pinned_by: curator.id,
			can_unpin: false,
		});
		expect((await pin(ids[0], moderator, false)).status).toBe(403);
		expect((await pin(ids[0], senior, false)).status).toBe(200);
		expect((await pin(ids[1], curator, false)).status).toBe(200);
		expect(await room(curator)).toMatchObject({ pins_used: limit - 2 });
		expect((await pin(ids[limit], curator)).status).toBe(200);
	});

	test("nobody deletes, pins or unpins the message of someone at their own rank or above", async () => {
		const [curator, modA, modB, supA, supB, admin] = (
			["curator", "moderator", "moderator", "supervisor", "supervisor", "admin"] as const
		).map((role) => createUser({ role }));
		const remove = (id: number, as: TestUser) => call(`/api/admin/chat/${id}`, { as, method: "DELETE" });
		const flags = async (id: number, as: TestUser) =>
			(await room(as)).messages.find((m: { id: number }) => m.id === id);

		const fromMod = await write(modB, "From a moderator");
		expect(await flags(fromMod, modA)).toMatchObject({ can_pin: false, can_delete: false });
		expect((await pin(fromMod, modA)).status).toBe(403);
		expect((await pin(await write(curator, "From a curator"), modA)).status).toBe(200);
		expect((await pin(fromMod, supA)).status).toBe(200);

		expect(await flags(fromMod, supB)).toMatchObject({ can_unpin: false });
		for (const other of [modB, supB]) expect((await pin(fromMod, other, false)).status).toBe(403);
		expect((await pin(fromMod, admin, false)).status).toBe(200);

		const fromSup = await write(supA, "From a supervisor");
		for (const other of [modA, supB]) expect((await remove(fromSup, other)).status).toBe(403);
		expect((await remove(await write(admin, "From an administrator"), supA)).status).toBe(403);
		expect(await flags(fromSup, admin)).toMatchObject({ can_delete: true, can_pin: true });
		expect((await remove(fromSup, admin)).status).toBe(200);
	});

	test("a pinned message outlives the clean-up that removes old ones", async () => {
		const staff = createUser({ role: "moderator" });
		const [kept, dropped] = [await write(staff, "Read this before reviewing"), await write(staff, "Old news")];
		await pin(kept, staff);
		db.run("UPDATE staff_chat SET created_at = unixepoch() - 200 * 86400 WHERE id IN (?, ?)", [kept, dropped]);
		pruneStaffChat();
		const left = db
			.query<{ id: number }, []>("SELECT id FROM staff_chat")
			.all()
			.map((m) => m.id);
		expect(left).toContain(kept);
		expect(left).not.toContain(dropped);
	});
});

describe("staff chat alerts", () => {
	const say = (as: TestUser, body: string) => post("/api/admin/chat", as, { body });
	const choose = (as: TestUser, staff_chat: string) => post("/api/settings", as, { prefs: { staff_chat } });
	const attention = (as: TestUser) => call("/api/attention", { as }).then((r) => r.data);
	const inbox = async (as: TestUser) =>
		(await call("/api/notifications", { as })).data.notifications.filter(
			(n: { category: string }) => n.category === "staff_chat"
		);

	test("each member of staff picks nothing, a count, or an inbox entry that says only that there is something new", async () => {
		const [author, quiet, counted, told, helper] = [
			createUser({ role: "moderator" }),
			createUser({ role: "moderator" }),
			createUser({ role: "curator" }),
			createUser({ role: "supervisor" }),
			createUser({ role: "helper" }),
		];
		expect((await call("/api/auth/me", { as: counted })).data.prefs.staff_chat).toBe("badge");
		expect((await choose(quiet, "none")).data.prefs.staff_chat).toBe("none");
		expect((await choose(told, "notify")).data.prefs.staff_chat).toBe("notify");
		expect((await choose(helper, "notify")).status).toBe(200);
		expect((await choose(counted, "loudly")).data.prefs.staff_chat).toBe("badge");
		for (const reader of [quiet, counted, told]) await call("/api/admin/chat", { as: reader });

		await say(author, "The secret plan is in the usual place");
		await say(author, "And one more thing");
		expect((await attention(quiet)).staff_chat).toBe(0);
		expect((await attention(counted)).staff_chat).toBe(2);
		expect((await attention(helper)).staff_chat).toBe(0);
		for (const untold of [quiet, counted, helper, author]) expect(await inbox(untold)).toHaveLength(0);

		const entries = await inbox(told);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ body: null, link: "/admin#chat", read_at: null });
		expect(JSON.stringify(entries)).not.toContain("secret plan");

		await call("/api/admin/chat", { as: told });
		expect((await inbox(told))[0].read_at).not.toBeNull();
		expect((await attention(told)).staff_chat).toBe(0);
		await say(author, "Still there?");
		expect((await inbox(told)).filter((n: { read_at: number | null }) => n.read_at === null)).toHaveLength(1);
	});
});

describe("numbers the pages show", () => {
	test("come from the server, and only staff hear the chat's", async () => {
		const me = async (as: TestUser) => (await call("/api/auth/me", { as })).data.limits;
		const player = await me(createUser());
		expect(player).toEqual({
			label_min: LIMITS.labelMin,
			label_max: LIMITS.labelMax,
			label_edit_min: LIMITS.labelEditMin,
			hints: LIMITS.hintsPerLocation,
			hint_length: LIMITS.hintLength,
			upload_bytes: LIMITS.uploadBytes,
			ticket_follow_ups: LIMITS.ticketFollowUps,
			quickplay_rounds: expect.any(Number),
			streak_shown: expect.any(Number),
		});
		const curator = await me(createUser({ role: "curator" }));
		expect(curator.chat_retention_days).toBeGreaterThan(0);
		expect(curator.chat_pin_limits.curator).toBeLessThan(curator.chat_pin_limits.operator);
		expect((await me(createUser({ role: "helper" }))).chat_pin_limits).toBeUndefined();
	});
});

describe("claims", () => {
	test("tell other staff when someone opens or leaves an item, but not on every renewal", async () => {
		const { onClaimsChanged } = await import("../src/lib/claims");
		const { nudgeClaims } = await import("../src/events");
		let told = 0;
		onClaimsChanged(() => told++);
		try {
			const staff = createUser({ role: "moderator" });
			await post("/api/admin/claims", staff, { kind: "ticket", id: 7 });
			await post("/api/admin/claims", staff, { kind: "ticket", id: 7 });
			expect(told).toBe(1);
			await post("/api/admin/claims", staff, { kind: "ticket", id: 8 });
			await post("/api/admin/claims", staff, {});
			expect(told).toBe(3);
		} finally {
			onClaimsChanged(nudgeClaims);
		}
	});

	test("the empty ticket queue can say when the last one was closed", async () => {
		const staff = createUser({ role: "moderator" });
		const before = await call("/api/admin/support/last-closed", { as: staff });
		expect(before.status).toBe(200);
		expect(before.data).toHaveProperty("at");
		expect((await call("/api/admin/support/last-closed", { as: createUser() })).status).toBe(403);
	});
});
