import { DEV_DISCORD_ID, DEV_MODE, PORT } from "./src/config";
import { db } from "./src/db";
import { app } from "./src/app";
import { SUPERVISED } from "./src/lib/lifecycle";
import { captureConsole, logInfo } from "./src/lib/logs";
import { reportProblem } from "./src/lib/problems";
import { notify } from "./src/lib/webhook";
import { backfillAchievementsOnce } from "./src/achievements";
import { resetDuelsOnStartup } from "./src/game/duels/rooms";
import { restoreSoloGames } from "./src/game/solo";
import { startCleanupJobs } from "./src/jobs/cleanup";
import { migrateLegacyModeration } from "./src/moderation";
import { websocket } from "./src/routes/duels";
import { ensureStyles, watchStyles } from "./src/styles";
import { scheduleRestart, stopCleanly } from "./src/system/restart";
import { generateTileVariants } from "./src/tile-images";

/** Also keep warnings and errors where operators can read them in the staff panel. */
captureConsole();

process.on("uncaughtException", (err) => {
	console.error("[server] Uncaught exception (server kept running):", err);
	reportProblem("Uncaught exception", err);
});
process.on("unhandledRejection", (reason) => {
	console.error("[server] Unhandled promise rejection (server kept running):", reason);
	reportProblem("Unhandled promise rejection", reason);
});

if (DEV_MODE) {
	console.warn("AUTH_DEV=true: OAuth is bypassed and a fake dev account is used");
} else {
	db.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE discord_id = ?)", [DEV_DISCORD_ID]);
}

migrateLegacyModeration();
/** The stylesheet is a build product: make sure it exists, and keep it fresh while developing. */
await ensureStyles();
if (DEV_MODE) watchStyles();

resetDuelsOnStartup();
backfillAchievementsOnce();
const restoredGames = restoreSoloGames();
if (restoredGames) console.log(`[server] Picked up ${restoredGames} solo game(s) from before the restart`);
startCleanupJobs();
generateTileVariants().catch((err) => console.error("Tile variant generation failed:", err));

logInfo(`Dovedale GeoGuesser listening on http://localhost:${PORT}${SUPERVISED ? " (managed by PM2)" : ""}`);
/** A start nobody asked for (a crash, the host rebooting) is worth knowing about. */
notify(
	"system",
	`**Server started**\nListening on port ${PORT}${DEV_MODE ? ", with the development login enabled" : ""}.`,
	"/admin#stats"
);

/** Stop cleanly when the host stops or restarts us. */
process.on("SIGTERM", () => stopCleanly("SIGTERM received"));
process.on("SIGINT", () => stopCleanly("SIGINT received"));
/** `pm2 sendSignal SIGUSR2` (see deploy.sh) asks for a restart with the usual warning to players. */
if (process.platform !== "win32") process.on("SIGUSR2", () => void scheduleRestart("Restart requested by the host"));

export default {
	fetch: app.fetch,
	port: PORT,
	websocket,
	idleTimeout: 60,
	/** The largest legitimate request is one 8 MB screenshot plus its form fields. */
	maxRequestBodySize: 12 * 1024 * 1024,
	/** Last resort for anything that fails outside the app's own error handler. */
	error(err: Error) {
		console.error("[server] Request failed outside the app:", err);
		return new Response("Something went wrong on our end. Please try again.", {
			status: 500,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	},
};
