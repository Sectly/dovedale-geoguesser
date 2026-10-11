import { Hono } from "hono";
import type { Context } from "hono";
import { GAME } from "../config";
import { requirePlayer } from "../auth/guards";
import { currentUser } from "../auth/sessions";
import { beginSoloRound, nextSoloRound, revealSoloHint, startSoloGame, submitSoloGuess } from "../game/solo";
import { parseGuess } from "../game/round";
import { pickLocations } from "../game/locations";
import { clientIp, fail, intQuery, readJson } from "../lib/http";
import { uploadUrl } from "../lib/uploads";
import { checkRateLimit } from "../lib/rate-limit";
import { SPECIAL_MODES, liveSpecial, specialsFor } from "../specials";

export const soloRoutes = new Hono();

/** Solo is open to everyone; banned accounts play as guests so nothing they do is saved. */
function playerId(c: Context): number | null {
	const user = currentUser(c);
	return user && !user.is_banned ? user.id : null;
}

soloRoutes.post("/games", async (c) => {
	const userId = playerId(c);
	const limiterKey = userId !== null ? `solo:u${userId}` : `solo:ip:${clientIp(c)}`;
	if (!checkRateLimit(limiterKey, 30, 10 * 60 * 1000))
		fail(429, "You're starting games too quickly. Try again shortly.");

	const body = await readJson<{ rounds: number; time_limit: number; special: string }>(c);
	if (body.special !== undefined) {
		// Specials are for logged-in players, and only while they are running.
		const player = requirePlayer(c);
		const mode = typeof body.special === "string" ? SPECIAL_MODES[body.special] : undefined;
		if (!mode || !liveSpecial(body.special, player)) fail(404, "That special isn't running right now.");
		return c.json(
			startSoloGame(player.id, mode.rounds, mode.rules.timeLimit, { id: body.special, rules: mode.rules })
		);
	}
	const rounds = GAME.solo.rounds.includes(body.rounds!) ? body.rounds! : GAME.solo.defaultRounds;
	const timeLimit = GAME.solo.timeLimits.includes(body.time_limit!) ? body.time_limit! : GAME.solo.defaultTimeLimit;
	return c.json(startSoloGame(userId, rounds, timeLimit));
});

soloRoutes.post("/games/:id/begin", (c) => c.json(beginSoloRound(c.req.param("id"), playerId(c))));

soloRoutes.post("/games/:id/hint", (c) => c.json(revealSoloHint(c.req.param("id"), playerId(c))));

soloRoutes.post("/games/:id/guess", async (c) => {
	const body = await readJson<{ x: number; y: number }>(c);
	return c.json(submitSoloGuess(c.req.param("id"), playerId(c), parseGuess(body.x, body.y)));
});

soloRoutes.post("/games/:id/next", (c) => c.json(nextSoloRound(c.req.param("id"), playerId(c))));

/** Routes mounted at /api/specials. */
export const specialRoutes = new Hono();

specialRoutes.get("/", (c) => c.json(specialsFor(requirePlayer(c))));

/** Screenshots for Memory Match: pictures only, with nothing that says where they were taken. */
specialRoutes.get("/memory/cards", (c) => {
	if (!liveSpecial("memory", requirePlayer(c))) fail(404, "Memory Match isn't running right now.");
	const pairs = intQuery(c, "pairs", 8, 2, 12);
	return c.json({ images: pickLocations(pairs).map((location) => uploadUrl(location.image_path)) });
});
