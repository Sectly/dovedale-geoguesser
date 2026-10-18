import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { teamWireServer } from "../src/game/teams-wire";
import { createLocation, createUser, post, type TestUser } from "./helpers";

/** Stands in for a socket: records what the server sends and lets a test send events as the page. */
class FakeConn extends EventEmitter {
	auth: { userId: number | null };
	got: { event: string; data: any }[] = [];
	constructor(userId: number | null) {
		super();
		this.auth = { userId };
	}
	override emit(event: string, data?: unknown): boolean {
		this.got.push({ event, data });
		return super.emit(event, data);
	}
	last(event: string) {
		return this.got.filter((g) => g.event === event).at(-1)?.data;
	}
}

/** The library's server is an event emitter, though its types do not say so. */
const server = teamWireServer as unknown as EventEmitter;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function watch(user: TestUser, room: string, here = true) {
	const conn = new FakeConn(user.id);
	server.emit("connection", conn);
	conn.emit("team_watch", { room, here });
	return conn;
}

async function newRoom() {
	for (let i = 0; i < 3; i++) createLocation();
	const [host, mate] = [createUser(), createUser()];
	const code = (await post("/api/teams/rooms", host, { rounds: 3 })).data.code as string;
	await post(`/api/teams/rooms/${code}/join`, mate);
	return { host, mate, code };
}

describe("team duels socket", () => {
	test("sends the room when a page starts watching", async () => {
		const { host, code } = await newRoom();
		const conn = watch(host, code);
		const state = conn.last("team_state");
		expect(state.code).toBe(code);
		expect(state.members).toHaveLength(2);
		expect(state.you.id).toBe(host.id);
	});

	test("pushes every change to each player in the room", async () => {
		const { host, mate, code } = await newRoom();
		const [a, b] = [watch(host, code), watch(mate, code)];
		await post(`/api/teams/rooms/${code}/team`, mate, { team: "a" });
		await tick();
		expect(a.last("team_state").members.find((m: any) => m.id === mate.id).team).toBe("a");
		expect(b.last("team_state").you.team).toBe("a");
		await post(`/api/teams/rooms/${code}/team`, mate, { team: "b" });
		await post(`/api/teams/rooms/${code}/start`, host);
		await tick();
		expect(a.last("team_state").phase).toBe("ready");
		expect(b.last("team_state").phase_ms_left).toBeGreaterThan(0);
	});

	test("keeps each team's pins from the other team", async () => {
		const { host, mate, code } = await newRoom();
		const third = createUser();
		await post(`/api/teams/rooms/${code}/join`, third);
		await post(`/api/teams/rooms/${code}/team`, third, { team: "a" });
		const [a, b] = [watch(host, code), watch(mate, code)];
		await post(`/api/teams/rooms/${code}/start`, host);
		const { tickTeamRooms } = await import("../src/game/teams");
		tickTeamRooms(Date.now() + 5000);
		await post(`/api/teams/rooms/${code}/pin`, third, { x: 10, y: 20 });
		await tick();
		expect(a.last("team_state").team_pins).toEqual([{ id: third.id, x: 10, y: 20, locked: false }]);
		expect(b.last("team_state").team_pins).toEqual([]);
	});

	test("tells the page when its room has closed", async () => {
		const { host, mate, code } = await newRoom();
		const conn = watch(host, code);
		await post(`/api/teams/rooms/${code}/leave`, mate);
		await post(`/api/teams/rooms/${code}/leave`, host);
		await tick();
		expect(conn.last("team_closed")).toBeTruthy();
	});

	test("ignores pages that are not logged in", async () => {
		const { code } = await newRoom();
		const conn = new FakeConn(null);
		server.emit("connection", conn);
		conn.emit("team_watch", { room: code });
		expect(conn.last("team_state")).toBeUndefined();
	});

	test("does not count a hidden page as being there", async () => {
		const { host, mate, code } = await newRoom();
		watch(host, code);
		const hidden = watch(mate, code, false);
		const realNow = Date.now;
		Date.now = () => realNow() + 10_000;
		try {
			hidden.emit("team_here", { here: false });
			const watcher = watch(host, code);
			expect(watcher.last("team_state").members.find((m: any) => m.id === mate.id).away).toBe(true);
			expect(watcher.last("team_state").members.find((m: any) => m.id === host.id).away).toBe(false);
		} finally {
			Date.now = realNow;
		}
	});
});
