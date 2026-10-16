import { afterEach, describe, expect, test } from "bun:test";
import type { WireConnection } from "@webwirejs/server";
import { db } from "../src/db";
import { abandonDuel, createRoom, duelRooms, previewPin } from "../src/game/duels/rooms";
import { DUEL_RULES, Round } from "../src/game/round";
import { resetTournaments } from "../src/game/tournaments";
import { quickplay } from "../src/game/duels/matchmaking";
import { call, createLocation, createUser, post, type TestUser } from "./helpers";

const quietConn = () => ({ auth: null, on() {}, emit() {}, close() {} }) as unknown as WireConnection;

function seatBoth(code: string) {
	const room = duelRooms.get(code)!;
	for (const userId of [
		room.creatorId,
		...db
			.query<{ user_id: number }, [number]>("SELECT user_id FROM duel_participants WHERE game_id = ?")
			.all(room.dbId)
			.map((r) => r.user_id),
	]) {
		if (room.players.some((p) => p.userId === userId)) continue;
		room.players.push({
			userId,
			username: `u${userId}`,
			displayName: `u${userId}`,
			avatarUrl: "",
			conn: quietConn(),
			connected: true,
			disconnects: 0,
			totalScore: 0,
		});
	}
	room.status = "in_progress";
	return room;
}

const tick = () => Bun.sleep(10);

async function setUp(count: number) {
	const staff = createUser({ role: "supervisor" });
	const players = Array.from({ length: count }, () => createUser());
	const created = await post("/api/admin/tournaments", staff, {
		title: "Game night",
		rounds: 1,
		breaks: { match: 10 },
	});
	expect(created.status).toBe(200);
	const id = created.data.id as number;
	const added = await post(`/api/admin/tournaments/${id}/players`, staff, {
		usernames: players.map((p) => p.username).join(", "),
	});
	expect(added.data.missing).toEqual([]);
	return { staff, players, id };
}

async function openAndCheckIn(id: number, staff: TestUser, players: TestUser[]) {
	expect((await post(`/api/admin/tournaments/${id}/open`, staff)).status).toBe(200);
	for (const p of players) expect((await post(`/api/tournaments/${id}/checkin`, p)).status).toBe(200);
}

const view = async (id: number) => (await call(`/api/tournaments/${id}`)).data;

afterEach(() => {
	for (const room of duelRooms.values()) if (room.tournament) duelRooms.delete(room.code);
	resetTournaments();
	db.run("DELETE FROM tournaments");
});

describe("tournaments", () => {
	test("drafts are hidden from players and the current summary", async () => {
		const { id } = await setUp(2);
		expect((await call(`/api/tournaments/${id}`)).status).toBe(404);
		expect((await call("/api/tournaments/current")).data).toBeNull();
	});

	test("only staff can set one up", async () => {
		const player = createUser();
		expect((await post("/api/admin/tournaments", player, { title: "Nope" })).status).toBe(403);
	});

	test("players not on the list can't check in", async () => {
		const { id, staff } = await setUp(2);
		await post(`/api/admin/tournaments/${id}/open`, staff);
		expect((await post(`/api/tournaments/${id}/checkin`, createUser())).status).toBe(403);
	});

	test("five players draw an eight-place bracket with byes for the top seeds", async () => {
		const { id, staff, players } = await setUp(5);
		await openAndCheckIn(id, staff, players);
		const started = await post(`/api/admin/tournaments/${id}/start`, staff);
		expect(started.status).toBe(200);
		const t = started.data;
		expect(t.status).toBe("live");
		expect(t.rounds.map((r: any) => r.name)).toEqual(["Quarter-finals", "Semi-finals", "Final"]);
		const first = t.rounds[0].matches;
		/** Seeds 1 to 3 have nobody opposite; seeds 4 and 5 play. */
		expect(first.filter((m: any) => m.closed.some(Boolean))).toHaveLength(3);
		expect(first[0].players[0]).toBe(players[0].id);
		expect(t.phase.kind).toBe("break");
		expect(t.phase.label).toBe("start");
		const upNext = first.find((m: any) => m.id === t.phase.match_id);
		expect(upNext.players.sort()).toEqual([players[3].id, players[4].id].sort());
	});

	test("a match runs from ready to result, and the winner moves on", async () => {
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		for (const p of players) expect((await post(`/api/tournaments/${id}/ready`, p)).status).toBe(200);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		let t = await view(id);
		expect(t.phase.kind).toBe("match");
		const room = seatBoth(t.phase.code);
		expect(room.tournament).toEqual({ id, matchId: t.phase.match_id });

		abandonDuel(room, players[0].id);
		t = await view(id);
		expect(t.phase.kind).toBe("result");
		expect(t.rounds[0].matches[0].winner).toBe(players[1].id);
		expect(t.rounds[0].matches[0].decided).toBe("forfeit");

		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		t = await view(id);
		expect(t.status).toBe("finished");
		expect(t.champion).toBe(players[1].id);
		expect((await call("/api/tournaments/current")).data).toMatchObject({ id, status: "finished" });
	});

	test("a break runs out with a player not ready, and staff decide", async () => {
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		await post(`/api/tournaments/${id}/ready`, players[0]);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		const t = await view(id);
		expect(t.phase.kind).toBe("hold");
		expect(t.phase.reason).toBe("not_ready");
		const awarded = await post(`/api/admin/tournaments/${id}/matches/${t.phase.match_id}/award`, staff, {
			user_id: players[0].id,
		});
		expect(awarded.data.rounds[0].matches[0].decided).toBe("staff");
	});

	test("both players ready cuts a long match break short", async () => {
		const { id, staff, players } = await setUp(4);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		await call(`/api/admin/tournaments/${id}`, { method: "PATCH", as: staff, json: { breaks: { match: 600 } } });
		const first = await view(id);
		const match = first.rounds[0].matches.find((m: any) => m.id === first.phase.match_id);
		const room = (async () => {
			for (const pid of match.players)
				await post(
					`/api/tournaments/${id}/ready`,
					players.find((p) => p.id === pid)!
				);
			await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
			await tick();
			return seatBoth((await view(id)).phase.code);
		})();
		abandonDuel(await room, match.players[0]);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		let t = await view(id);
		expect(t.phase.kind).toBe("break");
		expect(t.phase.label).toBe("match");
		expect(t.phase.ends_at - t.now).toBeGreaterThan(500_000);
		const next = t.rounds[0].matches.find((m: any) => m.id === t.phase.match_id);
		for (const pid of next.players)
			await post(
				`/api/tournaments/${id}/ready`,
				players.find((p) => p.id === pid)!
			);
		t = await view(id);
		expect(t.phase.ends_at - t.now).toBeLessThanOrEqual(10_000);
	});

	test("taking out a player gives their opponent a walkover", async () => {
		const { id, staff, players } = await setUp(4);
		await openAndCheckIn(id, staff, players);
		const t = (await post(`/api/admin/tournaments/${id}/start`, staff)).data;
		const second = t.rounds[0].matches.find((m: any) => m.id !== t.phase.match_id);
		const [out, stays] = second.players;
		await call(`/api/admin/tournaments/${id}/players/${out}`, { method: "DELETE", as: staff });
		const after = await view(id);
		const match = after.rounds[0].matches.find((m: any) => m.id === second.id);
		expect(match.players).toEqual([null, stays]);
		expect(match.closed).toEqual([true, false]);
	});

	test("staff can put a late arrival in a bye before it is reached", async () => {
		const { id, staff, players } = await setUp(3);
		await openAndCheckIn(id, staff, players);
		const t = (await post(`/api/admin/tournaments/${id}/start`, staff)).data;
		const bye = t.rounds[0].matches.find((m: any) => m.closed.some(Boolean));
		const side = bye.closed.indexOf(true);
		const late = createUser();
		const filled = await post(`/api/admin/tournaments/${id}/matches/${bye.id}/slot`, staff, {
			side,
			username: late.username,
		});
		expect(filled.status).toBe(200);
		const match = filled.data.rounds[0].matches.find((m: any) => m.id === bye.id);
		expect(match.players[side]).toBe(late.id);
		expect(match.closed).toEqual([false, false]);
		expect(filled.data.notice.text).toContain("joins the bracket");
	});

	test("only one tournament can be on at a time", async () => {
		const first = await setUp(2);
		await post(`/api/admin/tournaments/${first.id}/open`, first.staff);
		const second = await post("/api/admin/tournaments", first.staff, { title: "Another" });
		expect((await post(`/api/admin/tournaments/${second.data.id}/open`, first.staff)).status).toBe(409);
		expect((await call("/api/tournaments/current")).data.id).toBe(first.id);
	});

	test("spectators see a pin before it is submitted; the opponent and other duels don't", () => {
		const [a, b] = [createUser(), createUser()];
		const location = db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(createLocation())!;
		const watching: string[] = [];
		const opponent: string[] = [];
		const spectator = {
			auth: null,
			on() {},
			emit: (e: string) => watching.push(e),
			close() {},
		} as unknown as WireConnection;
		const opponentConn = {
			auth: null,
			on() {},
			emit: (e: string) => opponent.push(e),
			close() {},
		} as unknown as WireConnection;
		for (const tournament of [{ id: 1, matchId: 0 }, null]) {
			const room = createRoom(a.id, 3, false, false, tournament);
			room.players.push(
				{
					userId: a.id,
					username: "a",
					displayName: "a",
					avatarUrl: "",
					conn: quietConn(),
					connected: true,
					disconnects: 0,
					totalScore: 0,
				},
				{
					userId: b.id,
					username: "b",
					displayName: "b",
					avatarUrl: "",
					conn: opponentConn,
					connected: true,
					disconnects: 0,
					totalScore: 0,
				}
			);
			room.spectators.add(spectator);
			room.status = "in_progress";
			room.round = new Round(location, DUEL_RULES);
			previewPin(room, room.players[0], { x: 10, y: 20 });
			room.tournament = null;
			duelRooms.delete(room.code);
		}
		expect(watching).toEqual(["pin_preview"]);
		expect(opponent).toEqual([]);
	});

	/** Gives the next match to its first player and skips the result. */
	async function awardNext(id: number, staff: TestUser) {
		const t = await view(id);
		const m = t.rounds.flatMap((r: any) => r.matches).find((x: any) => x.id === t.phase.match_id);
		await post(`/api/admin/tournaments/${id}/matches/${m.id}/award`, staff, { user_id: m.players[0] });
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		return m;
	}

	test("a match for third place is played before the final, and the results stay up afterwards", async () => {
		const { id, staff, players } = await setUp(4);
		await call(`/api/admin/tournaments/${id}`, { method: "PATCH", as: staff, json: { third_place: true } });
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		const semis = [await awardNext(id, staff), await awardNext(id, staff)];
		const third = await awardNext(id, staff);
		expect(third.third).toBe(true);
		expect(third.name).toBe("Third place");
		expect(third.players.sort()).toEqual(semis.map((m: any) => m.players[1]).sort());
		const final = await awardNext(id, staff);
		expect(final.third).toBe(false);
		const t = await view(id);
		expect(t.status).toBe("finished");
		expect(t.champion).toBe(final.players[0]);

		const summary = (await call("/api/tournaments/current")).data;
		expect(summary).toMatchObject({ id, status: "finished" });
		expect((await call("/api/tournaments/past")).data[0].id).toBe(id);
		await post(`/api/admin/tournaments/${id}/results`, staff, { until: null });
		expect((await call("/api/tournaments/current")).data).toBeNull();
		await post(`/api/admin/tournaments/${id}/results`, staff, { until: Date.now() + 60_000 });
		expect((await call("/api/tournaments/current")).data.id).toBe(id);
	});

	test("spectators pick a winner before the match; players can't", async () => {
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		const fan = createUser();
		expect((await post(`/api/tournaments/${id}/vote`, fan, { side: 1 })).status).toBe(200);
		expect((await post(`/api/tournaments/${id}/vote`, players[0], { side: 0 })).status).toBe(403);
		const t = (await call(`/api/tournaments/${id}`, { as: fan })).data;
		expect(t.rounds[0].matches[0].votes).toEqual([0, 1]);
		expect(t.my_votes[t.phase.match_id]).toBe(1);
	});

	test("players whose duels are limited can't be added", async () => {
		const { id, staff } = await setUp(2);
		const limited = createUser();
		db.run("UPDATE users SET duel_limited = 1 WHERE id = ?", [limited.id]);
		const added = await post(`/api/admin/tournaments/${id}/players`, staff, { usernames: limited.username });
		expect(added.data.limited).toEqual([limited.username]);
		expect(added.data.added).toEqual([]);
	});

	test("Continue gives a short countdown, and the players stay ready through it", async () => {
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		expect((await view(id)).phase.kind).toBe("hold");
		const t = (await post(`/api/admin/tournaments/${id}/control`, staff, { action: "continue" })).data;
		expect(t.phase.kind).toBe("break");
		expect(t.phase.ends_at - t.now).toBeLessThanOrEqual(10_000);
		expect(t.ready.sort()).toEqual(players.map((p) => p.id).sort());
	});

	test("a player waiting in Quick Play leaves the queue when their match starts", async () => {
		createLocation();
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		const user = db.query<any, [number]>("SELECT * FROM users WHERE id = ?").get(players[0].id);
		const queued = quickplay(user, 3, () => true)!;
		expect(duelRooms.get(queued.code)?.status).toBe("waiting");
		for (const p of players) await post(`/api/tournaments/${id}/ready`, p);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		expect((await view(id)).phase.kind).toBe("match");
		expect(duelRooms.has(queued.code)).toBe(false);
	});

	test("tournament matches stay off profiles and leaderboards", async () => {
		const { id, staff, players } = await setUp(2);
		await openAndCheckIn(id, staff, players);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		for (const p of players) await post(`/api/tournaments/${id}/ready`, p);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await tick();
		const room = seatBoth((await view(id)).phase.code);
		abandonDuel(room, players[0].id);
		const profile = (await call(`/api/profile/${players[1].username}`)).data;
		expect(profile.duels.games).toBe(0);
		expect(profile.recent.duels).toEqual([]);
	});

	test("supervisors create, open, start and cancel; moderators run the rest", async () => {
		const mod = createUser({ role: "moderator" });
		expect((await post("/api/admin/tournaments", mod, { title: "Nope" })).status).toBe(403);
		const { id, staff, players } = await setUp(2);
		expect((await post(`/api/admin/tournaments/${id}/open`, mod)).status).toBe(403);
		expect((await call(`/api/admin/tournaments/${id}`, { method: "DELETE", as: mod })).status).toBe(403);
		await openAndCheckIn(id, staff, players);
		expect((await post(`/api/admin/tournaments/${id}/start`, mod)).status).toBe(403);
		await post(`/api/admin/tournaments/${id}/start`, staff);
		expect((await post(`/api/admin/tournaments/${id}/control`, mod, { action: "add_time" })).status).toBe(200);
		expect((await post(`/api/admin/tournaments/${id}/message`, mod, { text: "Five minutes" })).status).toBe(200);
		expect((await post(`/api/admin/tournaments/${id}/cancel`, mod)).status).toBe(403);
		expect((await post(`/api/admin/tournaments/${id}/cancel`, staff)).status).toBe(200);
	});

	test("moderators can read the limits the staff panel's guide quotes", async () => {
		const rules = await call("/api/admin/tournaments/rules", { as: createUser({ role: "moderator" }) });
		expect(rules.status).toBe(200);
		expect(rules.data).toMatchObject({
			players: 64,
			roster: 128,
			minRounds: 1,
			readySeconds: 10,
			resultsHours: 12,
		});
		expect((await call("/api/admin/tournaments/rules", { as: createUser() })).status).toBe(403);
	});

	test("an invite code lets players join themselves, and staff see who used which code", async () => {
		const { id, staff } = await setUp(2);
		const mod = createUser({ role: "moderator" });
		const first = (await post(`/api/admin/tournaments/${id}/invite`, mod, { on: true })).data.invite_code;
		expect(first).toMatch(/^[A-Z0-9]{6}$/);
		const joiner = createUser();
		/** Not open yet. */
		expect((await post(`/api/tournaments/${id}/join`, joiner, { code: first })).status).toBe(409);
		await post(`/api/admin/tournaments/${id}/open`, staff);

		const pub = (await call(`/api/tournaments/${id}`)).data;
		expect(pub.invite_open).toBe(true);
		expect(pub.invite_code).toBeUndefined();
		expect((await post(`/api/tournaments/${id}/join`, joiner, { code: "WRONG1" })).status).toBe(403);
		expect((await post(`/api/tournaments/${id}/join`, joiner, { code: first.toLowerCase() })).status).toBe(200);

		const second = (await post(`/api/admin/tournaments/${id}/invite`, staff, { on: true })).data.invite_code;
		expect(second).not.toBe(first);
		const late = createUser();
		expect((await post(`/api/tournaments/${id}/join`, late, { code: first })).status).toBe(403);
		expect((await post(`/api/tournaments/${id}/join`, late, { code: second })).status).toBe(200);

		const limited = createUser();
		db.run("UPDATE users SET duel_limited = 1 WHERE id = ?", [limited.id]);
		expect((await post(`/api/tournaments/${id}/join`, limited, { code: second })).status).toBe(403);

		const t = (await call(`/api/admin/tournaments/${id}`, { as: staff })).data;
		const via = (u: TestUser) => t.roster.find((r: any) => r.user_id === u.id);
		expect(via(joiner)).toMatchObject({ checked_in: true, invite_code: first });
		expect(via(late)).toMatchObject({ checked_in: true, invite_code: second });
		expect(t.roster.filter((r: any) => r.invite_code === null)).toHaveLength(2);

		await post(`/api/admin/tournaments/${id}/invite`, staff, { on: false });
		expect((await post(`/api/tournaments/${id}/join`, createUser(), { code: second })).status).toBe(403);
		expect((await call(`/api/tournaments/${id}`)).data.invite_open).toBe(false);
	});
});
