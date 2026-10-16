import { Hono } from "hono";
import { nudgeTournamentChat } from "../events";
import { hasRole, requirePlayer } from "../auth/guards";
import { currentUser } from "../auth/sessions";
import {
	checkIn,
	currentSummary,
	joinByInvite,
	markReady,
	pastTournaments,
	tournamentView,
	vote,
} from "../game/tournaments";
import { fail, idParam, readJson, text } from "../lib/http";
import { chatHistory, reportChat, sendChat } from "../game/chat";

export const tournamentRoutes = new Hono();

/** Open to everyone: watching needs no login. */
tournamentRoutes.get("/current", (c) => c.json(currentSummary()));

tournamentRoutes.get("/past", (c) => c.json(pastTournaments()));

tournamentRoutes.get("/:id", (c) => {
	const user = currentUser(c);
	return c.json(tournamentView(idParam(c), hasRole(user, "moderator"), user?.id ?? null));
});

tournamentRoutes.post("/:id/checkin", (c) => {
	checkIn(idParam(c), requirePlayer(c));
	return c.json({ success: true });
});

tournamentRoutes.post("/:id/join", async (c) => {
	const code = text((await readJson<{ code: string }>(c)).code, 12);
	if (!code) fail(400, "Enter the invite code.");
	joinByInvite(idParam(c), requirePlayer(c), code);
	return c.json({ success: true });
});

tournamentRoutes.post("/:id/vote", async (c) => {
	const side = (await readJson<{ side: number }>(c)).side;
	if (side !== 0 && side !== 1) fail(400, "Pick a player.");
	vote(idParam(c), requirePlayer(c), side);
	return c.json({ success: true });
});

tournamentRoutes.post("/:id/ready", (c) => {
	markReady(idParam(c), requirePlayer(c));
	return c.json({ success: true });
});

/** What the viewer may do in chat, and the latest messages if they may read them. */
tournamentRoutes.get("/:id/chat", (c) => c.json(chatHistory(currentUser(c), idParam(c))));

/** Staff see every message, blocked ones included, so they are told whatever the outcome. */
tournamentRoutes.post("/:id/chat", async (c) => {
	const body = (await readJson<{ text: unknown }>(c)).text;
	const id = idParam(c);
	try {
		return c.json(sendChat(requirePlayer(c), id, body));
	} finally {
		nudgeTournamentChat(id);
	}
});

tournamentRoutes.post("/:id/chat/:messageId/report", (c) => {
	const id = idParam(c);
	reportChat(requirePlayer(c), id, idParam(c, "messageId"));
	nudgeTournamentChat(id);
	return c.json({ success: true });
});
