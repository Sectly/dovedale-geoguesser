import { beforeAll, describe, expect, jest, test } from "bun:test";
import type { WireConnection } from "@webwirejs/server";
import { db } from "../src/db";
import { cancelQuickplay, quickplay } from "../src/game/duels/matchmaking";
import {
	playerDisconnected,
	playerLoaded,
	playerReconnected,
	abandonDuel,
	closeAllDuels,
	createRoom,
	duelRooms,
	joinRoom,
	leaveWaitingRoom,
	startDuel,
	submitGuess,
	type DuelRoom,
} from "../src/game/duels/rooms";
import { DUEL_RULES, Round } from "../src/game/round";
import { issueAction } from "../src/moderation";
import { call, clearLocations, createLocation, createUser, post, resetReviewQueues, type TestUser } from "./helpers";

type FakeConn = WireConnection & { events: [string, any][] };

function fakeConn(): FakeConn {
	const events: [string, any][] = [];
	return {
		events,
		auth: null,
		on() {
			return this;
		},
		emit: (e: string, d: unknown) => void events.push([e, d]),
		close() {},
	} as unknown as FakeConn;
}

function seat(room: DuelRoom, user: TestUser): FakeConn {
	const conn = fakeConn();
	room.players.push({
		userId: user.id,
		username: user.username,
		displayName: user.username,
		avatarUrl: "",
		conn,
		connected: true,
		disconnects: 0,
		totalScore: 0,
	});
	return conn;
}

/** Puts a room straight into round one without waiting for the countdown. */
function beginRound(room: DuelRoom) {
	room.status = "in_progress";
	room.roundNumber = 1;
	room.round = new Round(room.locations[0], DUEL_RULES);
}

const eventNames = (conn: FakeConn) => conn.events.map(([name]) => name);

const fullUser = (u: TestUser) => db.query<any, [number]>("SELECT * FROM users WHERE id = ?").get(u.id);

beforeAll(() => {
	clearLocations();
	for (let i = 0; i < 4; i++) createLocation();
});

beforeAll(resetReviewQueues);

describe("duel rooms over HTTP", () => {
	test("create, join, and the errors a player can hit", async () => {
		const host = createUser();
		const guest = createUser();
		expect((await post("/api/duels/rooms")).status).toBe(401);
		const created = await post("/api/duels/rooms", host, { rounds: 99 });
		expect(created.status).toBe(200);
		const room = duelRooms.get(created.data.code)!;
		expect(room.rounds).toBe(10);

		expect((await post("/api/duels/rooms/NOPE99/join", guest)).status).toBe(404);
		expect((await post(`/api/duels/rooms/${room.code.toLowerCase()}/join`, guest)).status).toBe(200);

		seat(room, host);
		seat(room, guest);
		expect((await post(`/api/duels/rooms/${room.code}/join`, createUser())).status).toBe(409);
	});

	test("limited and banned players cannot create rooms", async () => {
		const limited = createUser();
		issueAction(limited, "limit_duel", "Test limit", null, Math.floor(Date.now() / 1000) + 3600);
		expect((await post("/api/duels/rooms", limited)).status).toBe(403);
	});
});

describe("duel game flow", () => {
	test("a round scores both players; a missing pin scores nothing", () => {
		const [a, b] = [createUser(), createUser()];
		const room = createRoom(a.id, 2);
		joinRoom(room.code, b.id);
		const connA = seat(room, a);
		seat(room, b);
		expect(startDuel(room)).toBeNull();
		expect(connA.events.at(-1)![0]).toBe("start_countdown");
		beginRound(room);

		const target = room.locations[0];
		submitGuess(room, a.id, { x: target.world_x, y: target.world_y });
		expect(room.round).not.toBeNull();
		submitGuess(room, b.id, null);
		expect(room.round).toBeNull();

		const [event, result] = connA.events.at(-1)!;
		expect(event).toBe("round_result");
		expect(result.correct_x).toBe(target.world_x);
		const byUser = Object.fromEntries(result.results.map((r: any) => [r.user_id, r]));
		expect(byUser[a.id].score).toBeGreaterThanOrEqual(5000);
		expect(byUser[b.id]).toMatchObject({ score: 0, distance: null, guessed_x: null });
		abandonDuel(room, b.id);
	});

	test("leaving between rounds ends the duel for good", async () => {
		const [a, b] = [createUser(), createUser()];
		const room = createRoom(a.id, 2);
		joinRoom(room.code, b.id);
		const connA = seat(room, a);
		seat(room, b);
		room.locations = [createLocation(), createLocation()].map((id) =>
			db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(id)
		);
		beginRound(room);
		submitGuess(room, a.id, { x: 0, y: 0 });
		submitGuess(room, b.id, { x: 0, y: 0 });
		expect(room.phase).not.toBeNull(); // the pause before round two

		abandonDuel(room, b.id);
		expect(room.status).toBe("finished");
		expect(room.phase).toBeNull();
		expect(connA.events.at(-1)![0]).toBe("opponent_disconnected");
		const game = db
			.query<{ status: string; winner_id: number }, [number]>(
				"SELECT status, winner_id FROM duel_games WHERE id = ?"
			)
			.get(room.dbId)!;
		expect(game).toEqual({ status: "finished", winner_id: a.id });
	});

	test("the round clock waits for both players to load the screenshot", () => {
		jest.useFakeTimers();
		try {
			const [a, b] = [createUser(), createUser()];
			const room = createRoom(a.id, 1);
			joinRoom(room.code, b.id);
			const connA = seat(room, a);
			seat(room, b);
			expect(startDuel(room)).toBeNull();
			jest.advanceTimersByTime(3_000);
			expect(eventNames(connA).at(-1)).toBe("round_loading");
			expect(room.awaitingLoad).toBe(true);
			submitGuess(room, a.id, { x: 0, y: 0 });
			expect(room.outcomes.size).toBe(0); // nothing counts before the clock starts

			playerLoaded(room, a.id);
			expect(room.awaitingLoad).toBe(true);
			jest.advanceTimersByTime(1_500);
			playerLoaded(room, b.id);
			const [event, start] = connA.events.at(-1)!;
			expect(event).toBe("round_start");
			expect(start).toMatchObject({ loading: false, time_remaining: 60 });
			abandonDuel(room, b.id);

			// A player who never reports in only holds things up for the loading window.
			const slow = createRoom(a.id, 1);
			joinRoom(slow.code, b.id);
			const connSlow = seat(slow, a);
			seat(slow, b);
			startDuel(slow);
			jest.advanceTimersByTime(3_000);
			playerLoaded(slow, a.id);
			jest.advanceTimersByTime(6_000);
			expect(eventNames(connSlow).at(-1)).toBe("round_start");
			abandonDuel(slow, b.id);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a dropped connection pauses the duel and a reconnect resumes it", () => {
		jest.useFakeTimers();
		try {
			const [a, b] = [createUser(), createUser()];
			const room = createRoom(a.id, 2);
			joinRoom(room.code, b.id);
			const connA = seat(room, a);
			seat(room, b);
			room.locations = [createLocation(), createLocation()].map((id) =>
				db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(id)
			);
			beginRound(room);
			jest.advanceTimersByTime(10_000);
			const before = room.round!.remaining()!;

			room.players[1].connected = false;
			playerDisconnected(room, b.id);
			expect(connA.events.at(-1)![0]).toBe("paused");
			expect(room.round!.paused).toBe(true);
			submitGuess(room, a.id, { x: 0, y: 0 });
			expect(room.outcomes.size).toBe(0); // no guessing while paused

			// Twenty seconds away costs nobody any time on the clock.
			jest.advanceTimersByTime(20_000);
			expect(room.status).toBe("in_progress");
			room.players[1].connected = true;
			playerReconnected(room);
			expect(connA.events.at(-1)).toEqual(["resuming", { seconds: 3 }]);
			jest.advanceTimersByTime(3_000);
			const [event, resumed] = connA.events.at(-1)!;
			expect(event).toBe("resumed");
			expect(room.paused).toBeNull();
			expect(resumed.round.time_remaining).toBe(Math.ceil(before));
			submitGuess(room, a.id, { x: 0, y: 0 });
			expect(room.outcomes.size).toBe(1);
			abandonDuel(room, b.id);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a player who stays gone forfeits", () => {
		jest.useFakeTimers();
		try {
			const [a, b] = [createUser(), createUser()];
			const room = createRoom(a.id, 1);
			joinRoom(room.code, b.id);
			const connA = seat(room, a);
			seat(room, b);
			room.locations = [createLocation()].map((id) =>
				db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(id)
			);
			beginRound(room);
			room.players[1].connected = false;
			playerDisconnected(room, b.id);
			jest.advanceTimersByTime(31_000);
			expect(room.status).toBe("finished");
			const [event, data] = connA.events.at(-1)!;
			expect(event).toBe("opponent_disconnected");
			expect(data.winner.user_id).toBe(a.id);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a restart closes every room, tells the players and names no winner", () => {
		const [a, b, c] = [createUser(), createUser(), createUser()];
		const playing = createRoom(a.id, 1);
		joinRoom(playing.code, b.id);
		const connA = seat(playing, a);
		seat(playing, b);
		playing.locations = [createLocation()].map((id) =>
			db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(id)
		);
		beginRound(playing);
		const waiting = createRoom(c.id, 1);
		const connC = seat(waiting, c);

		closeAllDuels("Restarting");
		expect(duelRooms.size).toBe(0);
		expect(connA.events.at(-1)).toEqual(["server_restart", { message: "Restarting" }]);
		expect(connC.events.at(-1)![0]).toBe("server_restart");
		const game = (id: number) =>
			db.query<any, [number]>("SELECT status, winner_id FROM duel_games WHERE id = ?").get(id);
		expect(game(playing.dbId)).toEqual({ status: "abandoned", winner_id: null });
		expect(game(waiting.dbId)).toBeNull();
	});

	test("a duel cannot start with more rounds than there are locations", () => {
		const [a, b] = [createUser(), createUser()];
		const room = createRoom(a.id, 10);
		joinRoom(room.code, b.id);
		seat(room, a);
		seat(room, b);
		clearLocations();
		createLocation();
		expect(startDuel(room)).toContain("Not enough locations");
		expect(room.status).toBe("waiting");
	});

	test("a player who leaves the lobby is not counted in the game", () => {
		const [a, b] = [createUser(), createUser()];
		const room = createRoom(a.id, 1);
		joinRoom(room.code, b.id);
		seat(room, a);
		seat(room, b);
		leaveWaitingRoom(room, b.id);
		expect(room.players.map((p) => p.userId)).toEqual([a.id]);
		const participants = db
			.query<{ user_id: number }, [number]>("SELECT user_id FROM duel_participants WHERE game_id = ?")
			.all(room.dbId);
		expect(participants).toEqual([{ user_id: a.id }]);
		leaveWaitingRoom(room, a.id);
		expect(duelRooms.has(room.code)).toBe(false);
	});
});

describe("quick play", () => {
	test("two players asking for the same rounds are matched into one room", () => {
		const [a, b, c] = [createUser(), createUser(), createUser()].map(fullUser);
		const first = quickplay(a, 5, () => true)!;
		expect(first.status).toBe("waiting");
		// Nobody is matched into a room whose host has not connected yet.
		expect(quickplay(b, 5, () => true)!.code).not.toBe(first.code);
		cancelQuickplay(b.id);

		const room = duelRooms.get(first.code)!;
		expect(room.quickplay).toBe(true);
		seat(room, { id: a.id, username: a.username, cookie: "" });
		expect(quickplay(c, 3, () => true)!.code).not.toBe(first.code);
		cancelQuickplay(c.id);
		expect(quickplay(b, 5, () => true)).toEqual({ status: "matched", code: first.code });

		// If the matched player backs out, the host goes back to waiting for someone else.
		cancelQuickplay(b.id);
		expect(duelRooms.has(first.code)).toBe(true);
		expect(quickplay(c, 5, () => true)).toEqual({ status: "matched", code: first.code });
		cancelQuickplay(a.id);
		cancelQuickplay(c.id);
		expect(duelRooms.has(first.code)).toBe(false);
	});

	test("quickplay rooms cannot be joined by code, only watched", async () => {
		const host = createUser();
		const code = (await post("/api/duels/quickplay", host, { rounds: 5 })).data.code;
		expect((await post(`/api/duels/rooms/${code}/join`, createUser())).status).toBe(409);
		expect((await call("/api/duels/quickplay", { method: "DELETE", as: host })).status).toBe(200);
		expect(duelRooms.has(code)).toBe(false);
	});
});
