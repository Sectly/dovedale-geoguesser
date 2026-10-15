import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { GAME } from "../src/config";
import { db } from "../src/db";
import { BACKUP_LIMITS, createBackup, listBackups } from "../src/backups";
import { tickTeamRooms } from "../src/game/teams";
import { pruneLogs, writeLog } from "../src/lib/logs";
import { createRoom, duelRooms, joinRoom, startDuel } from "../src/game/duels/rooms";
import { setMaintenance } from "../src/system/maintenance";
import { cancelRestart, restartIn, scheduleRestart } from "../src/system/restart";
import { call, clearLocations, createLocation, createUser, post, resetReviewQueues, type TestUser } from "./helpers";

const operator = () => createUser({ role: "operator" });

beforeAll(resetReviewQueues);

describe("system tools are for operators only", () => {
	test("supervisors and players cannot reach them", async () => {
		for (const path of ["info", "backups", "logs", "update", "maintenance"]) {
			expect((await call(`/api/admin/system/${path}`, { as: createUser({ role: "supervisor" }) })).status).toBe(
				403
			);
			expect((await call(`/api/admin/system/${path}`, { as: createUser() })).status).toBe(403);
		}
		expect((await call("/api/admin/system/info", { as: operator() })).status).toBe(200);
		expect(
			(await post("/api/admin/system/restart", createUser({ role: "supervisor" }), { confirm: true })).status
		).toBe(403);
		expect(
			(await post("/api/admin/system/update", createUser({ role: "supervisor" }), { confirm: true })).status
		).toBe(403);
	});
});

describe("backups", () => {
	test("an operator can make, list, download and delete one", async () => {
		const op = operator();
		const made = await post("/api/admin/system/backups", op);
		expect(made.status).toBe(200);
		const listed = (await call("/api/admin/system/backups", { as: op })).data.backups;
		expect(listed.map((b: { name: string }) => b.name)).toContain(made.data.name);

		const download = await call(`/api/admin/system/backups/${made.data.name}/download`, { as: op });
		expect(download.status).toBe(200);
		expect(download.headers.get("Content-Disposition")).toContain(made.data.name);
		expect(
			db.query("SELECT 1 FROM audit_log WHERE action = 'backup_download' AND details = ?").get(made.data.name)
		).not.toBeNull();

		expect((await call(`/api/admin/system/backups/${made.data.name}`, { method: "DELETE", as: op })).status).toBe(
			200
		);
		expect((await call(`/api/admin/system/backups/${made.data.name}/download`, { as: op })).status).toBe(404);
	});

	test("names that are not backups are refused", async () => {
		const op = operator();
		for (const name of ["..%2Fgeoguesser.sqlite", "geoguesser.sqlite", "manual-..%2F..%2Fx.sqlite"]) {
			expect((await call(`/api/admin/system/backups/${name}/download`, { as: op })).status).toBe(404);
			expect((await call(`/api/admin/system/backups/${name}`, { method: "DELETE", as: op })).status).toBe(404);
		}
	});

	test("old backups of each kind are removed as new ones are made", () => {
		for (let i = 0; i < BACKUP_LIMITS.manual + 3; i++) createBackup(db, "manual", `limit-test-${i}`);
		for (let day = 1; day <= BACKUP_LIMITS.daily + 2; day++)
			createBackup(db, "daily", `2020-01-${String(day).padStart(2, "0")}`);
		const kinds = listBackups().map((b) => b.kind);
		expect(kinds.filter((k) => k === "manual")).toHaveLength(BACKUP_LIMITS.manual);
		expect(kinds.filter((k) => k === "daily")).toHaveLength(BACKUP_LIMITS.daily);
	});
});

describe("server log", () => {
	test("entries can be filtered, searched and cleared, and the table stays small", async () => {
		const op = operator();
		writeLog("error", ["[test] something exploded", new Error("needle in the stack")]);
		writeLog("warn", ["[test] just a warning"]);

		const errors = (await call("/api/admin/system/logs?level=error&q=needle", { as: op })).data;
		expect(errors.logs[0]).toMatchObject({ level: "error", message: "[test] something exploded" });
		expect(errors.logs[0].detail).toContain("needle in the stack");
		expect((await call("/api/admin/system/logs?level=warn&q=needle", { as: op })).data.logs).toHaveLength(0);

		for (let i = 0; i < 3100; i++) db.run("INSERT INTO server_logs (level, message) VALUES ('info', 'filler')");
		pruneLogs();
		expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM server_logs").get()!.n).toBeLessThanOrEqual(3000);

		expect((await call("/api/admin/system/logs", { method: "DELETE", as: op })).status).toBe(200);
		expect((await call("/api/admin/system/logs", { as: op })).data.logs).toHaveLength(0);
	});
});

describe("updates", () => {
	test("status reports the checkout and an update needs confirming", async () => {
		const op = operator();
		const status = (await call("/api/admin/system/update", { as: op })).data;
		expect(status.available).toBe(true);
		expect(status.current.hash).toMatch(/^[0-9a-f]{40}$/);
		expect((await post("/api/admin/system/update", op, {})).status).toBe(400);
		expect((await post("/api/admin/system/restart", op, {})).status).toBe(400);
		/** Tests never run under a process manager, so a restart has nothing to bring the server back. */
		expect((await post("/api/admin/system/restart", op, { confirm: true })).status).toBe(409);
	});
});

describe("planned restarts", () => {
	afterAll(() => void cancelRestart());

	test("everyone is told, new duels are held back, and it can be called off", async () => {
		for (let i = 0; i < 3; i++) createLocation();
		const [host, guest] = [createUser(), createUser()];
		const room = createRoom(host.id, 1);
		joinRoom(room.code, guest.id);
		expect((await call("/api/status")).headers.get("X-Restart-In")).toBeNull();
		expect((await call("/api/status")).headers.get("X-App")).toBe("dovedale");
		expect((await call("/play")).headers.get("X-App")).toBe("dovedale");

		expect(scheduleRestart("test")).toBeGreaterThan(0);
		expect(Number((await call("/api/status")).headers.get("X-Restart-In"))).toBe(restartIn()!);
		expect((await post("/api/duels/rooms", host, { rounds: 1 })).status).toBe(503);
		expect(startDuel(room)).toContain("restart");
		expect((await post("/api/solo/games", undefined, {})).status).not.toBe(503);

		expect((await post("/api/admin/system/restart/cancel", operator())).status).toBe(409);
		expect(cancelRestart()).toBe(true);
		expect(cancelRestart()).toBe(false);
		expect((await call("/api/status")).headers.get("X-Restart-In")).toBeNull();
		expect((await post("/api/duels/rooms", host, { rounds: 1 })).status).toBe(200);
		expect(startDuel(room)).not.toContain("restart");
		duelRooms.delete(room.code);
	});
});

describe("restart notice", () => {
	test("gives a duel time to finish, and stops waiting once it has", () => {
		const [host, guest] = [createUser(), createUser()];
		const room = createRoom(host.id, 1);
		joinRoom(room.code, guest.id);
		jest.useFakeTimers();
		try {
			room.status = "in_progress";
			expect(scheduleRestart("test")).toBe(GAME.restart.notice);
			jest.advanceTimersByTime(10_000);
			expect(restartIn()!).toBeGreaterThan(GAME.restart.quietNotice);

			room.status = "finished";
			jest.advanceTimersByTime(2500);
			expect(restartIn()!).toBeLessThanOrEqual(GAME.restart.quietNotice);
		} finally {
			cancelRestart();
			jest.useRealTimers();
			duelRooms.delete(room.code);
		}
	});
});

describe("maintenance mode", () => {
	afterAll(() => void setMaintenance(false, "", "test"));

	test("locks players out, lets staff carry on, and keeps login open", async () => {
		const op = operator();
		const player = createUser();
		const on = await post("/api/admin/system/maintenance", op, { enabled: true, message: "Back at noon" });
		expect(on.data).toMatchObject({ enabled: true, message: "Back at noon" });

		const page = await call("/play", { as: player, headers: { Accept: "text/html" } });
		expect(page.status).toBe(503);
		expect(page.data).toContain("Down for maintenance");
		expect(page.data).toContain('data-status="503"');
		expect(page.data).toContain("Back at noon");
		expect((await post("/api/solo/games", player, {})).status).toBe(503);
		expect((await call("/api/leaderboard/solo")).status).toBe(503);
		expect((await call("/css/shared.css")).status).toBe(200);
		expect((await call("/api/auth/me", { as: player })).status).toBe(200);
		expect((await call("/api/status")).status).toBe(200);

		expect((await call("/play", { as: op })).status).toBe(200);
		expect((await call("/api/auth/me", { as: op })).data.maintenance).toBe("Back at noon");
		expect((await call("/api/auth/me", { as: player })).data.maintenance).toBe(false);

		await post("/api/admin/system/maintenance", op, { enabled: false });
		expect((await call("/play", { as: player })).status).toBe(200);
	});
});

describe("team duels", () => {
	const room = (code: string, as: TestUser) => call(`/api/teams/rooms/${code}`, { as }).then((r) => r.data);

	test("two teams play a game and each round counts the team's best guess", async () => {
		clearLocations();
		for (let i = 0; i < 4; i++) createLocation({ x: 1000, y: 1000 });
		const [a1, a2, b1, b2, late] = [createUser(), createUser(), createUser(), createUser(), createUser()];
		const code = (await post("/api/teams/rooms", a1, { rounds: 3 })).data.code;
		for (const player of [a2, b1, b2])
			expect((await post(`/api/teams/rooms/${code}/join`, player)).status).toBe(200);
		expect((await post(`/api/teams/rooms/${code}/join`, late)).status).toBe(409);

		const lobby = await room(code, a1);
		expect(lobby.members.map((m: { team: string }) => m.team).sort()).toEqual(["a", "a", "b", "b"]);
		const teamOf = (u: TestUser) => lobby.members.find((m: { id: number }) => m.id === u.id).team;
		const teamA = [a1, a2, b1, b2].filter((u) => teamOf(u) === "a");
		const teamB = [a1, a2, b1, b2].filter((u) => teamOf(u) === "b");

		expect((await post(`/api/teams/rooms/${code}/start`, teamB[0])).status).toBe(403);
		expect((await post(`/api/teams/rooms/${code}/start`, a1)).status).toBe(200);

		const now = Date.now();
		tickTeamRooms(now + 5000);
		let state = await room(code, teamA[0]);
		expect(state).toMatchObject({ status: "playing", phase: "guessing", round_number: 1, reveal: null });
		expect(JSON.stringify(state)).not.toContain("correct_x");

		await post(`/api/teams/rooms/${code}/pin`, teamA[1], { x: 900, y: 900 });
		expect((await room(code, teamA[0])).team_pins).toMatchObject([{ id: teamA[1].id, x: 900, y: 900 }]);
		expect((await room(code, teamB[0])).team_pins).toEqual([]);

		await post(`/api/teams/rooms/${code}/guess`, teamA[0], { x: 1000, y: 1000 });
		await post(`/api/teams/rooms/${code}/guess`, teamA[1], { x: -20000, y: -9000 });
		await post(`/api/teams/rooms/${code}/guess`, teamB[0], { x: 9000, y: 9000 });
		expect((await post(`/api/teams/rooms/${code}/guess`, teamA[0], { x: 1, y: 1 })).status).toBe(409);
		await post(`/api/teams/rooms/${code}/guess`, teamB[1], {});

		state = await room(code, teamB[1]);
		expect(state.phase).toBe("reveal");
		expect(state.reveal.team_scores.a).toBe(5000);
		expect(state.reveal.team_scores.b).toBeLessThan(5000);
		expect(state.totals.a).toBe(5000);
		expect(state.reveal.guesses).toHaveLength(4);
	});

	test("the host sets the rounds in the lobby, and the finished game says how it went", async () => {
		clearLocations();
		for (let i = 0; i < 5; i++) createLocation({ x: 1000, y: 1000 });
		const [host, rival] = [createUser(), createUser()];
		const code = (await post("/api/teams/rooms", host, { rounds: 5 })).data.code;
		await post(`/api/teams/rooms/${code}/join`, rival);
		expect((await post(`/api/teams/rooms/${code}/rounds`, rival, { rounds: 3 })).status).toBe(403);
		expect((await post(`/api/teams/rooms/${code}/rounds`, host, { rounds: 3 })).status).toBe(200);
		expect((await room(code, rival)).rounds).toBe(3);
		expect((await room(code, rival)).summary).toBeNull();

		await post(`/api/teams/rooms/${code}/start`, host);
		expect((await post(`/api/teams/rooms/${code}/rounds`, host, { rounds: 10 })).status).toBe(409);
		let clock = Date.now();
		tickTeamRooms((clock += 5000));
		await post(`/api/teams/rooms/${code}/guess`, host, { x: 1000, y: 1000 });
		await post(`/api/teams/rooms/${code}/guess`, rival, {});
		expect((await room(code, host)).phase).toBe("reveal");
		/** The clock here runs ahead of the players, so they count as away and the other rounds end unguessed. */
		for (let round = 2; round <= 3; round++) {
			tickTeamRooms((clock += 11000));
			tickTeamRooms((clock += 5000));
		}
		tickTeamRooms((clock += 11000));

		const final = await room(code, rival);
		const hostTeam = final.members.find((m: { id: number }) => m.id === host.id).team;
		const rivalTeam = hostTeam === "a" ? "b" : "a";
		expect(final).toMatchObject({ status: "finished", winner: hostTeam, rounds: 3 });
		expect(final.summary.rounds_won).toEqual({ [hostTeam]: 1, [rivalTeam]: 0 });
		expect(final.summary.players).toContainEqual({ id: host.id, best: 5000, counted: 1 });
		expect(final.summary.players).toContainEqual({ id: rival.id, best: 0, counted: 0 });
	});

	test("it needs a login, both teams, and is closed to banned players", async () => {
		expect((await post("/api/teams/rooms", undefined, {})).status).toBe(401);
		const host = createUser();
		const code = (await post("/api/teams/rooms", host, {})).data.code;
		expect((await post(`/api/teams/rooms/${code}/start`, host)).status).toBe(409);
		expect((await call(`/api/teams/rooms/${code}`, { as: createUser() })).status).toBe(403);
		expect((await call("/api/teams/rooms/NOPE00", { as: host })).status).toBe(404);

		const banned = createUser();
		await post(`/api/admin/users/${banned.id}/ban`, operator(), { type: "perm", reason: "Testing team access" });
		expect((await post("/api/teams/rooms", banned, {})).status).toBe(403);
	});
});
