import { Hono } from "hono";
import type { Context } from "hono";
import { requireStaff } from "../../auth/guards";
import {
	addPlayers,
	awardMatch,
	cancelTournament,
	controlTournament,
	createTournament,
	deleteTournament,
	listTournaments,
	movePlayer,
	openTournament,
	postMessage,
	redrawTournament,
	removePlayer,
	restartMatch,
	setCheckedIn,
	setResults,
	setSlot,
	shufflePlayers,
	startTournament,
	tournamentView,
	unpublishTournament,
	tournamentRules,
	updateTournament,
	type Control,
	type TournamentInput,
} from "../../game/tournaments";
import { fail, idParam, readJson, text } from "../../lib/http";

export const adminTournamentRoutes = new Hono();

/** Moderators run the night. */
const staffOf = (c: Context) => requireStaff(c, "moderator");
/** Creating, opening, unpublishing, starting, cancelling and deleting. */
const seniorOf = (c: Context) => requireStaff(c, "supervisor");
const ok = (c: Context, id: number) => c.json(tournamentView(id, true));

adminTournamentRoutes.get("/", (c) => {
	staffOf(c);
	return c.json(listTournaments());
});

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
