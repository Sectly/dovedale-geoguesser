import { Hono } from "hono";
import { hasRole, requirePlayer } from "../auth/guards";
import { currentUser } from "../auth/sessions";
import { checkIn, currentSummary, markReady, pastTournaments, tournamentView, vote } from "../game/tournaments";
import { fail, idParam, readJson } from "../lib/http";

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
