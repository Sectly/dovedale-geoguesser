import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { createRoom, duelRooms, joinRoom, liveDuels } from "../src/game/duels/rooms";
import { utcDate } from "../src/lib/time";
import type { User } from "../src/db";
import { sendStreakReminders } from "../src/notifications";
import { SPECIALS, currentSeason, easterSunday, specialsFor } from "../src/specials";
import { call, clearLocations, createLocation, createUser, post, resetReviewQueues } from "./helpers";

beforeAll(resetReviewQueues);

describe("staff stay anonymous to players", () => {
	test("ticket replies, moderation history and notifications never name the member of staff", async () => {
		const player = createUser();
		const mod = createUser({ role: "moderator", username: "secret_moderator" });
		const ticket = await post("/api/support", player, {
			subject: "Question",
			message: "Why was my submission denied please?",
			category: "other",
		});
		await post(`/api/admin/support/${ticket.data.id}/reply`, mod, { reply: "It broke guideline U2." });
		await post(`/api/admin/users/${player.id}/warn`, mod, { reason: "[F7 Harassment and abuse] in tickets" });

		const seen = JSON.stringify([
			(await call("/api/support/mine", { as: player })).data,
			(await call("/api/me/moderation", { as: player })).data,
			(await call("/api/notifications", { as: player })).data,
			(await call("/api/gdpr/export", { as: player })).data,
		]);
		expect(seen).not.toContain("secret_moderator");
		expect(seen).not.toContain(`User ${mod.id}`);
		expect((await call("/api/support/mine", { as: player })).data[0].replies[0].author_username).toBe("Staff");
		expect(JSON.stringify((await call("/api/admin/support?status=open", { as: mod })).data)).toContain(
			"secret_moderator"
		);
	});
});

describe("announcements and reminders", () => {
	test("an operator's announcement reaches everyone, whatever their preferences", async () => {
		const player = createUser();
		await post("/api/settings", player, {
			prefs: { notify: { submissions: false, tickets: false, reminders: false } },
		});
		expect(
			(
				await post("/api/admin/announcements", createUser({ role: "supervisor" }), {
					title: "Rules updated",
					body: "Please read the new fair play policy.",
				})
			).status
		).toBe(403);
		const sent = await post("/api/admin/announcements", createUser({ role: "operator" }), {
			title: "Rules updated",
			body: "Please read the new fair play policy.",
		});
		expect(sent.data.sent).toBeGreaterThan(1);
		expect((await call("/api/notifications", { as: player })).data.notifications[0]).toMatchObject({
			category: "announcements",
			title: "Rules updated",
		});
	});

	test("an announcement can target an audience, carry a link, pin a banner and be tested first", async () => {
		const op = createUser({ role: "operator" });
		const mod = createUser({ role: "moderator" });
		const player = createUser();
		const draft = { title: "Ranked duels are here", body: "Quick Play now has ratings. Give it a go." };
		const titles = async (user: typeof player) =>
			(await call("/api/notifications", { as: user })).data.notifications.map((n: any) => n.title);

		// A test goes to the sender alone and leaves no record.
		const before = (await call("/api/admin/announcements", { as: op })).data.history.length;
		expect((await post("/api/admin/announcements", op, { ...draft, test: true })).data).toMatchObject({
			test: true,
		});
		expect(await titles(op)).toContain("[Test] Ranked duels are here");
		expect(await titles(player)).not.toContain("[Test] Ranked duels are here");
		expect((await call("/api/admin/announcements", { as: op })).data.history.length).toBe(before);

		// Links stay on this site.
		for (const link of ["https://example.com", "//example.com", "daily"])
			expect((await post("/api/admin/announcements", op, { ...draft, link })).status).toBe(400);
		expect((await post("/api/admin/announcements", op, { ...draft, audience: "nobody" })).status).toBe(400);
		expect(
			(await post("/api/admin/announcements", op, { ...draft, audience: "staff", banner_hours: 1 })).status
		).toBe(400);

		// Staff only: the player hears nothing, and no banner goes up.
		await post("/api/admin/announcements", op, {
			title: "Staff meeting",
			body: "Friday at eight, in the usual place.",
			audience: "staff",
		});
		expect(await titles(mod)).toContain("Staff meeting");
		expect(await titles(player)).not.toContain("Staff meeting");
		expect((await call("/api/announcement")).data).toBeNull();

		// Everyone, with a link and a banner that logged-out visitors see too.
		const sent = await post("/api/admin/announcements", op, { ...draft, link: "/duels", banner_hours: 1 });
		expect(sent.status).toBe(200);
		expect((await call("/api/notifications", { as: player })).data.notifications[0]).toMatchObject({
			title: draft.title,
			link: "/duels",
		});
		expect((await call("/api/announcement")).data).toMatchObject({
			id: sent.data.id,
			title: draft.title,
			link: "/duels",
		});
		const history = (await call("/api/admin/announcements", { as: op })).data;
		expect(history.history[0]).toMatchObject({ id: sent.data.id, audience: "everyone", banner_live: true });
		expect(history.audiences.staff).toBeLessThan(history.audiences.everyone);
		expect((await call("/api/admin/announcements", { as: mod })).status).toBe(403);

		// Taken down early.
		expect((await post(`/api/admin/announcements/${sent.data.id}/end-banner`, mod)).status).toBe(403);
		expect((await post(`/api/admin/announcements/${sent.data.id}/end-banner`, op)).status).toBe(200);
		expect((await post(`/api/admin/announcements/${sent.data.id}/end-banner`, op)).status).toBe(409);
		expect((await call("/api/announcement")).data).toBeNull();
	});

	test("staff stats cover what is live, what is waiting and the last two weeks", async () => {
		const stats = (await call("/api/admin/stats", { as: createUser({ role: "moderator" }) })).data;
		expect(stats.live).toMatchObject({ duels: expect.any(Number), solo_games: expect.any(Number) });
		expect(stats.queues).toMatchObject({ submissions: expect.any(Number), tickets: expect.any(Number) });
		expect(stats.series).toHaveLength(14);
		expect(stats.series.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
		expect(stats.series.at(-1).new_users).toBeGreaterThan(0);
		expect(stats.users.total).toBeGreaterThan(0);
		expect(stats.locations).toHaveProperty("ungraded");
		expect((await call("/api/admin/stats", { as: createUser() })).status).toBe(403);
	});

	test("streak reminders go once, in the evening, to players who have not played today", () => {
		const atRisk = createUser();
		const playedToday = createUser();
		const optedOut = createUser();
		db.run("UPDATE users SET current_streak = 5, last_played_date = ? WHERE id IN (?, ?)", [
			utcDate(-1),
			atRisk.id,
			optedOut.id,
		]);
		db.run("UPDATE users SET current_streak = 5, last_played_date = ? WHERE id = ?", [utcDate(), playedToday.id]);
		db.run("UPDATE users SET prefs = ? WHERE id = ?", [
			JSON.stringify({ notify: { reminders: false } }),
			optedOut.id,
		]);
		const reminders = (id: number) =>
			db
				.query<{ n: number }, [number]>(
					"SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND category = 'reminders'"
				)
				.get(id)!.n;

		const morning = new Date();
		morning.setUTCHours(9);
		expect(sendStreakReminders(morning)).toBe(0);
		const evening = new Date();
		evening.setUTCHours(20);
		sendStreakReminders(evening);
		sendStreakReminders(evening);
		expect([reminders(atRisk.id), reminders(playedToday.id), reminders(optedOut.id)]).toEqual([1, 0, 0]);
	});
});

describe("live duels and history", () => {
	test("only listed duels that are under way appear, and anyone can read the list", async () => {
		const [a, b] = [createUser(), createUser()];
		const hidden = createRoom(a.id, 3);
		const listed = createRoom(a.id, 3, false, true);
		const quick = createRoom(b.id, 3, true);
		for (const room of [hidden, listed, quick]) room.status = "in_progress";
		const codes = (await call("/api/duels/live")).data.map((d: any) => d.code);
		expect(codes).toContain(listed.code);
		expect(codes).toContain(quick.code);
		expect(codes).not.toContain(hidden.code);
		expect(liveDuels().length).toBe(codes.length);
		for (const room of [hidden, listed, quick]) duelRooms.delete(room.code);

		const created = await post("/api/duels/rooms", a, { rounds: 3, listed: true });
		expect(duelRooms.get(created.data.code)!.listed).toBe(true);
		joinRoom(created.data.code, b.id);
	});

	test("profiles carry recent games, and a finished duel can be read round by round", async () => {
		const [a, b] = [createUser(), createUser()];
		db.run(
			"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, 12000, 5, 25000, 90)",
			[a.id]
		);
		const game = Number(
			db.run(
				"INSERT INTO duel_games (room_code, rounds, created_by, status, winner_id, finished_at) VALUES ('HIST01', 1, ?, 'finished', ?, unixepoch())",
				[a.id, a.id]
			).lastInsertRowid
		);
		db.run("INSERT INTO duel_participants (game_id, user_id, total_score) VALUES (?, ?, 4000), (?, ?, 1000)", [
			game,
			a.id,
			game,
			b.id,
		]);

		const profile = (await call(`/api/profile/${a.username}`)).data;
		expect(profile.recent.solo[0]).toMatchObject({ total_score: 12000, rounds: 5 });
		expect(profile.recent.duels[0]).toMatchObject({
			result: "win",
			score: 4000,
			opponent_score: 1000,
			opponent_username: b.username,
		});
		expect((await call(`/api/profile/${b.username}`)).data.recent.duels[0].result).toBe("loss");

		const history = await call(`/api/duels/history/${game}`);
		expect(history.status).toBe(200);
		expect(JSON.stringify(history.data)).not.toContain("guessed_x");
		expect((await call("/api/duels/history/999999")).status).toBe(404);
	});
});

describe("push subscriptions", () => {
	test("are refused when the server has no push keys, and need a login", async () => {
		expect((await post("/api/push/subscribe", undefined, {})).status).toBe(401);
		expect(
			(
				await post("/api/push/subscribe", createUser(), {
					endpoint: "https://push.example/abc",
					keys: { p256dh: "k", auth: "a" },
				})
			).status
		).toBe(503);
		expect((await call("/api/meta")).data.push_key).toBeNull();
	});
});

describe("specials", () => {
	test("the hub and its modes are for logged-in players only", async () => {
		expect((await call("/api/specials")).status).toBe(401);
		expect((await post("/api/solo/games", undefined, { special: "blitz" })).status).toBe(401);
		const sub = await call("/specials/reflex");
		expect(sub.status).toBe(302);
		expect(sub.headers.get("Location")).toBe("/specials");

		const player = createUser();
		const list = (await call("/api/specials", { as: player })).data;
		expect(list.map((s: { id: string }) => s.id)).toContain("blitz");
		expect((await call("/specials/reflex", { as: player })).status).toBe(200);
		expect((await post("/api/solo/games", player, { special: "nope" })).status).toBe(404);
	});

	test("Blitz uses its own rules and never reaches the leaderboard", async () => {
		clearLocations();
		for (let i = 0; i < 6; i++) createLocation({ hints: ["a hint"] });
		const player = createUser();
		const game = (await post("/api/solo/games", player, { special: "blitz" })).data;
		expect(game).toMatchObject({ special: "blitz", rounds: 5, time_limit: 15 });
		expect((await post(`/api/solo/games/${game.game_id}/hint`, player)).status).toBe(409);

		let result;
		for (let round = 1; round <= 5; round++) {
			result = (await post(`/api/solo/games/${game.game_id}/guess`, player, { x: 0, y: 0 })).data;
			if (round < 5) await post(`/api/solo/games/${game.game_id}/next`, player);
		}
		expect(result.summary).toMatchObject({ saved: false, special: "blitz", max_possible: 30000 });
		expect(db.query("SELECT 1 FROM solo_scores WHERE user_id = ?").get(player.id)).toBeNull();
	});
});

describe("seasonal specials", () => {
	const at = (iso: string) => Date.parse(iso);
	const statusOf = (id: string, user: User, when: string) => specialsFor(user, at(when)).find((s) => s.id === id);
	const player = { role: null } as User;
	const staff = { role: "moderator" } as User;

	test("come round every year, are listed beforehand and disappear afterwards", () => {
		expect(statusOf("night-shift", player, "2026-10-11T12:00:00Z")).toMatchObject({
			status: "upcoming",
			preview: false,
		});
		expect(statusOf("night-shift", player, "2026-10-31T12:00:00Z")).toMatchObject({ status: "live" });
		expect(statusOf("night-shift", player, "2027-10-31T12:00:00Z")).toMatchObject({ status: "live" });
		// The day after it ends it is already counting down to next year.
		expect(statusOf("night-shift", player, "2026-11-03T12:00:00Z")?.startsAt).toBe("2027-10-24T00:00:00.000Z");
	});

	test("a season can run over New Year", () => {
		expect(statusOf("snowed-in", player, "2026-12-25T12:00:00Z")).toMatchObject({ status: "live" });
		expect(statusOf("snowed-in", player, "2027-01-04T12:00:00Z")).toMatchObject({ status: "live" });
		expect(statusOf("snowed-in", player, "2027-01-07T12:00:00Z")).toMatchObject({ status: "upcoming" });
	});

	test("staff can try one early, players cannot", async () => {
		expect(statusOf("night-shift", staff, "2026-10-11T12:00:00Z")).toMatchObject({
			status: "upcoming",
			preview: true,
		});
		clearLocations();
		for (let i = 0; i < 5; i++) createLocation();
		// A seasonal mode that has not started is refused for players and open to staff.
		const closed = SPECIALS.find(
			(s) => s.season && specialsFor(player).find((l) => l.id === s.id)?.status === "upcoming"
		);
		if (closed) {
			expect((await post("/api/solo/games", createUser(), { special: closed.id })).status).toBe(404);
			expect(
				(await post("/api/solo/games", createUser({ role: "moderator" }), { special: closed.id })).status
			).toBe(200);
		}
	});

	test("Memory Match hands out pictures and nothing else", async () => {
		clearLocations();
		for (let i = 0; i < 9; i++) createLocation({ label: "Secret platform name" });
		const cards = await call("/api/specials/memory/cards", { as: createUser() });
		expect(cards.data.images).toHaveLength(8);
		expect(JSON.stringify(cards.data)).not.toContain("Secret platform name");
		expect((await call("/api/specials/memory/cards")).status).toBe(401);
	});
});

describe("the homepage season", () => {
	const on = (iso: string) => currentSeason(Date.parse(iso));

	test("follows the calendar, with or without a special of its own", async () => {
		expect(on("2026-10-11T12:00:00Z")).toBeNull();
		expect(on("2026-10-31T12:00:00Z")).toMatchObject({
			theme: "halloween",
			event: { title: "Night Shift", ends_at: "2026-11-03T00:00:00.000Z" },
		});
		expect(on("2026-12-25T12:00:00Z")).toMatchObject({ theme: "christmas", event: { title: "Snowed In" } });
		// New Year sits inside the Christmas season and takes over for its few days.
		expect(on("2026-12-31T23:00:00Z")).toMatchObject({ theme: "newyear", splash: "Happy New Year!", event: null });
		expect(on("2027-01-03T12:00:00Z")).toMatchObject({ theme: "christmas" });
		expect(on("2027-01-06T12:00:00Z")).toBeNull();
		expect(on("2027-02-14T12:00:00Z")).toMatchObject({ theme: "valentines", event: null });
		expect(on("2026-11-05T20:00:00Z")).toMatchObject({ theme: "bonfire" });
		// Logged-out visitors get it with the rest of the public page details.
		expect((await call("/api/meta")).data).toHaveProperty("season");
		// Any season can be previewed by name, whatever the date.
		expect((await call("/api/meta?season=easter")).data.season).toMatchObject({
			theme: "easter",
			splash: "Happy Easter!",
		});
		expect((await call("/api/meta?season=nonsense")).data.season).toBeNull();
	});

	test("Easter moves with the year", () => {
		expect(new Date(easterSunday(2026)).toISOString().slice(0, 10)).toBe("2026-04-05");
		expect(new Date(easterSunday(2027)).toISOString().slice(0, 10)).toBe("2027-03-28");
		expect(new Date(easterSunday(2038)).toISOString().slice(0, 10)).toBe("2038-04-25");
		expect(on("2026-04-03T12:00:00Z")).toMatchObject({ theme: "easter" });
		expect(on("2026-04-06T12:00:00Z")).toMatchObject({ theme: "easter" });
		expect(on("2026-04-07T12:00:00Z")).toBeNull();
		expect(on("2027-04-05T12:00:00Z")).toBeNull();
	});
});
