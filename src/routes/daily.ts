import { Hono } from "hono";
import { requirePlayer } from "../auth/guards";
import { currentUser } from "../auth/sessions";
import { beginDaily, dailyStatus, revealDailyHint, startDaily, submitDailyGuess } from "../game/daily";
import { parseGuess } from "../game/round";
import { readJson } from "../lib/http";

export const dailyRoutes = new Hono();

dailyRoutes.get("/", (c) => {
	const status = dailyStatus(currentUser(c));
	return status ? c.json(status) : c.text("No challenge available today. Check back later.", 404);
});

dailyRoutes.post("/start", (c) => c.json(startDaily(requirePlayer(c))));

dailyRoutes.post("/begin", (c) => c.json(beginDaily(requirePlayer(c))));

dailyRoutes.post("/hint", (c) => c.json(revealDailyHint(requirePlayer(c))));

dailyRoutes.post("/guess", async (c) => {
	const user = requirePlayer(c);
	const body = await readJson<{ x: number; y: number }>(c);
	return c.json(submitDailyGuess(user, parseGuess(body.x, body.y)));
});
