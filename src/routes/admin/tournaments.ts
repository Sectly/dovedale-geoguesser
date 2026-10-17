import { Hono } from "hono";
import type { Context } from "hono";
import { requireStaff } from "../../auth/guards";
import { nudgeTournamentChat } from "../../events";
import {
	addPlayers,
	awardMatch,
	cancelTournament,
	controlTournament,
	createTournament,
	deleteTournament,
	featureMatch,
	listTournaments,
	movePlayer,
	announceTournament,
	openTournament,
	postMessage,
	redrawTournament,
	removePlayer,
	removeUnready,
	resetTournamentHistory,
	restartMatch,
	setCheckedIn,
	setInvite,
	setResults,
	setSlot,
	shufflePlayers,
	startOneMatch,
	startTournament,
	tournamentView,
	unpublishTournament,
	tournamentRules,
	updateChatSettings,
	updateTournament,
	type Control,
	type TournamentInput,
} from "../../game/tournaments";
import { fail, idParam, readJson, text } from "../../lib/http";
import { approveChat, clearChat, deleteChat, dismissReports, staffChat, timeOutSender } from "../../game/chat";

export const adminTournamentRoutes = new Hono();

/** Moderators run the night. */
const staffOf = (c: Context) => requireStaff(c, "moderator");
/** Creating, announcing, opening, unpublishing, starting, cancelling and deleting. */
const seniorOf = (c: Context) => requireStaff(c, "supervisor");
const ok = (c: Context, id: number) => c.json(tournamentView(id, true));

adminTournamentRoutes.get("/", (c) => {
	staffOf(c);
	return c.json(listTournaments());
});

/** Operators only: every tournament and its matches go, and numbering starts again from 1. */
adminTournamentRoutes.delete("/", (c) => c.json(resetTournamentHistory(requireStaff(c, "operator"))));

adminTournamentRoutes.get("/rules", (c) => {
	staffOf(c);
	return c.json(tournamentRules());
});

adminTournamentRoutes.post("/", async (c) => {
	const id = createTournament(seniorOf(c), await readJson<TournamentInput>(c));
	return ok(c, id);
});

adminTournamentRoutes.get("/:id", (c) => {
	staffOf(c);
	return ok(c, idParam(c));
});

adminTournamentRoutes.patch("/:id", async (c) => {
	const id = idParam(c);
	updateTournament(staffOf(c), id, await readJson<TournamentInput>(c));
	return ok(c, id);
});

adminTournamentRoutes.delete("/:id", (c) => {
	deleteTournament(seniorOf(c), idParam(c));
	return c.json({ success: true });
});

adminTournamentRoutes.post("/:id/announce", (c) => {
	const id = idParam(c);
	announceTournament(seniorOf(c), id);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/open", (c) => {
	const id = idParam(c);
	openTournament(seniorOf(c), id);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/unpublish", (c) => {
	const id = idParam(c);
	unpublishTournament(seniorOf(c), id);
	return ok(c, id);
});

/** Usernames separated by commas, spaces or new lines. */
adminTournamentRoutes.post("/:id/players", async (c) => {
	const id = idParam(c);
	const names = text((await readJson<{ usernames: string }>(c)).usernames, 4000)
		.split(/[\s,]+/)
		.filter(Boolean);
	if (!names.length) fail(400, "Enter at least one username.");
	const result = addPlayers(staffOf(c), id, names);
	return c.json({ ...result, tournament: tournamentView(id, true) });
});

adminTournamentRoutes.delete("/:id/players/:userId", (c) => {
	const id = idParam(c);
	removePlayer(staffOf(c), id, idParam(c, "userId"));
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/players/:userId/move", async (c) => {
	const id = idParam(c);
	const by = (await readJson<{ by: number }>(c)).by;
	movePlayer(staffOf(c), id, idParam(c, "userId"), by === -1 ? -1 : 1);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/players/:userId/checkin", async (c) => {
	const id = idParam(c);
	const body = await readJson<{ checked_in: boolean }>(c);
	setCheckedIn(staffOf(c), id, idParam(c, "userId"), body.checked_in === true);
	return ok(c, id);
});

/** `on` makes a new code each time; false turns invites off. */
adminTournamentRoutes.post("/:id/invite", async (c) => {
	const id = idParam(c);
	setInvite(staffOf(c), id, (await readJson<{ on: boolean }>(c)).on === true);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/shuffle", (c) => {
	const id = idParam(c);
	shufflePlayers(staffOf(c), id);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/start", (c) => {
	const id = idParam(c);
	startTournament(seniorOf(c), id);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/redraw", (c) => {
	const id = idParam(c);
	redrawTournament(staffOf(c), id);
	return ok(c, id);
});

const CONTROLS: Control[] = ["skip", "add_time", "pause", "resume", "continue"];

adminTournamentRoutes.post("/:id/control", async (c) => {
	const id = idParam(c);
	const action = (await readJson<{ action: Control }>(c)).action;
	if (!action || !CONTROLS.includes(action)) fail(400, "Unknown action");
	controlTournament(staffOf(c), id, action);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/matches/:matchId/award", async (c) => {
	const id = idParam(c);
	const winner = (await readJson<{ user_id: number }>(c)).user_id;
	if (typeof winner !== "number") fail(400, "Choose the winner.");
	awardMatch(staffOf(c), id, idParam(c, "matchId"), winner);
	return ok(c, id);
});

/** The player who didn't ready up is out; the one who did goes through. */
adminTournamentRoutes.post("/:id/matches/:matchId/not-ready", (c) => {
	const id = idParam(c);
	removeUnready(staffOf(c), id, idParam(c, "matchId"));
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/matches/:matchId/start", (c) => {
	const id = idParam(c);
	startOneMatch(staffOf(c), id, idParam(c, "matchId"));
	return ok(c, id);
});

/** `match_id` null goes back to following the closest game. */
adminTournamentRoutes.post("/:id/feature", async (c) => {
	const id = idParam(c);
	const matchId = (await readJson<{ match_id: number | null }>(c)).match_id;
	featureMatch(staffOf(c), id, typeof matchId === "number" ? matchId : null);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/matches/:matchId/restart", (c) => {
	const id = idParam(c);
	restartMatch(staffOf(c), id, idParam(c, "matchId"));
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/matches/:matchId/slot", async (c) => {
	const id = idParam(c);
	const body = await readJson<{ side: number; username: string }>(c);
	const username = text(body.username, 40);
	if (!username) fail(400, "Enter a username.");
	setSlot(staffOf(c), id, idParam(c, "matchId"), body.side === 1 ? 1 : 0, username);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/message", async (c) => {
	const id = idParam(c);
	postMessage(staffOf(c), id, text((await readJson<{ text: string }>(c)).text, 400));
	return ok(c, id);
});

/** `until` in milliseconds; null hides the results. */
adminTournamentRoutes.post("/:id/results", async (c) => {
	const id = idParam(c);
	const until = (await readJson<{ until: number | null }>(c)).until;
	if (until !== null && typeof until !== "number") fail(400, "Pick a time.");
	setResults(staffOf(c), id, until ?? null);
	return ok(c, id);
});

adminTournamentRoutes.post("/:id/cancel", (c) => {
	const id = idParam(c);
	cancelTournament(seniorOf(c), id);
	return ok(c, id);
});

/* ---- Chat ---- */

/** Other staff with the chat card open see each change. */
adminTournamentRoutes.use("/:id/chat/*", async (c, next) => {
	await next();
	const id = Number(c.req.param("id"));
	if (c.req.method !== "GET" && c.res.ok && Number.isInteger(id)) nudgeTournamentChat(id);
});

adminTournamentRoutes.get("/:id/chat", (c) => {
	staffOf(c);
	return c.json(staffChat(idParam(c)));
});

/** Any of `on`, `delay_ms`, `slow_seconds` and `staff_only`. */
adminTournamentRoutes.post("/:id/chat/settings", async (c) => {
	const id = idParam(c);
	updateChatSettings(staffOf(c), id, await readJson(c));
	return c.json(staffChat(id));
});

adminTournamentRoutes.post("/:id/chat/clear", (c) => {
	const id = idParam(c);
	clearChat(staffOf(c), id);
	return c.json(staffChat(id));
});

adminTournamentRoutes.delete("/:id/chat/:messageId", (c) => {
	const id = idParam(c);
	deleteChat(staffOf(c), id, idParam(c, "messageId"));
	return c.json(staffChat(id));
});

adminTournamentRoutes.post("/:id/chat/:messageId/approve", (c) => {
	const id = idParam(c);
	approveChat(staffOf(c), id, idParam(c, "messageId"));
	return c.json(staffChat(id));
});

adminTournamentRoutes.post("/:id/chat/:messageId/dismiss", (c) => {
	const id = idParam(c);
	dismissReports(staffOf(c), id, idParam(c, "messageId"));
	return c.json(staffChat(id));
});

/** `minutes`: one of the lengths the panel offers. */
adminTournamentRoutes.post("/:id/chat/:messageId/timeout", async (c) => {
	const id = idParam(c);
	const minutes = (await readJson<{ minutes: unknown }>(c)).minutes;
	timeOutSender(staffOf(c), id, idParam(c, "messageId"), minutes);
	return c.json(staffChat(id));
});
