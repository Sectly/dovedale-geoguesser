import { describe, expect, test } from "bun:test";
import { db, type Location } from "../src/db";
import { utcDate } from "../src/lib/time";
import { call, createLocation, createUser, post } from "./helpers";

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

		// Moderators issue actions but cannot take them back.
		expect(
			(await post(`/api/admin/moderation/${warning.id}/overturn`, mod, { reason: "Changed my mind" })).status
		).toBe(403);
		expect((await post(`/api/admin/users/${player.id}/unban`, mod, { reason: "Changed my mind" })).status).toBe(
			403
		);
		// Supervisors handle warnings and temporary bans, with a reason.
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
		// The permanent ban still stands, and only an operator can lift or erase it.
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
		expect((await post(`/api/admin/suggestions/${sug}/deny`, mod, { reason: "full" })).status).toBe(200);
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

		// A player can add a couple of follow-ups, then has to wait for staff.
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

		// Their existing session stops working as staff at once.
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
		// They can still play.
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
		// A locked supervisor cannot use the powers they would need to undo it.
		expect((await post(`/api/admin/users/${modA.id}/staff-lock`, supB, { reason })).status).toBe(403);
	});
});
