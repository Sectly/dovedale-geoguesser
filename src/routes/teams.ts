import { Hono } from "hono";
import type { Context } from "hono";
import type { User } from "../db";
import { requirePlayer } from "../auth/guards";
import { parseGuess } from "../game/round";
import {
	TEAM_ROUNDS,
	chooseTeam,
	createTeamRoom,
	joinTeamRoom,
	leaveTeamRoom,
	moveTeamPin,
	resetTeamRoom,
	startTeamGame,
	submitTeamGuess,
	teamRoomState,
} from "../game/teams";
import { clampInt, fail, readJson } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { HOUR } from "../lib/time";
import { liveSpecial } from "../specials";

/** Routes mounted at /api/teams: the 2v2 team mode in Specials. */
export const teamRoutes = new Hono();

function requireTeamPlayer(c: Context): User {
	const user = requirePlayer(c);
	if (user.duel_limited) fail(403, "Your duel ability has been temporarily limited");
	if (!liveSpecial("teams", user)) fail(404, "Team duels aren't running right now.");
	return user;
}

const code = (c: Context) => c.req.param("code") ?? "";
const done = (c: Context) => c.json({ success: true });

teamRoutes.post("/rooms", async (c) => {
	const user = requireTeamPlayer(c);
	if (!checkUserRateLimit(user, "team-room", 10, HOUR * 1000)) fail(429, "Too many rooms created. Try again later.");
	const body = await readJson<{ rounds: number }>(c);
	const rounds = clampInt(body.rounds, TEAM_ROUNDS.default, TEAM_ROUNDS.min, TEAM_ROUNDS.max);
	return c.json({ code: createTeamRoom(user, rounds) });
});

teamRoutes.get("/rooms/:code", (c) => c.json(teamRoomState(code(c), requireTeamPlayer(c))));

teamRoutes.post("/rooms/:code/join", (c) => {
	joinTeamRoom(code(c), requireTeamPlayer(c));
	return done(c);
});

teamRoutes.post("/rooms/:code/team", async (c) => {
	const user = requireTeamPlayer(c);
	chooseTeam(code(c), user, (await readJson<{ team: string }>(c)).team);
	return done(c);
});

teamRoutes.post("/rooms/:code/start", (c) => {
	startTeamGame(code(c), requireTeamPlayer(c));
	return done(c);
});

teamRoutes.post("/rooms/:code/again", (c) => {
	resetTeamRoom(code(c), requireTeamPlayer(c));
	return done(c);
});

teamRoutes.post("/rooms/:code/pin", async (c) => {
	const user = requireTeamPlayer(c);
	const body = await readJson<{ x: number; y: number }>(c);
	moveTeamPin(code(c), user, parseGuess(body.x, body.y));
	return done(c);
});

teamRoutes.post("/rooms/:code/guess", async (c) => {
	const user = requireTeamPlayer(c);
	const body = await readJson<{ x: number; y: number }>(c);
	submitTeamGuess(code(c), user, parseGuess(body.x, body.y));
	return done(c);
});

teamRoutes.post("/rooms/:code/leave", (c) => {
	leaveTeamRoom(code(c), requirePlayer(c));
	return done(c);
});
