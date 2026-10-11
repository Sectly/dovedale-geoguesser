import { db } from "../db";

/** True when a process manager (PM2) is running the server and will start it again if it exits. */
export const SUPERVISED = process.env.pm_id !== undefined;

let stopping = false;

/** Leaves the database tidy and exits. Under a process manager this is how the server restarts. */
export function shutdown(reason: string): never {
	if (!stopping) {
		stopping = true;
		console.log(`[server] ${reason}, shutting down`);
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			db.close();
		} catch (err) {
			console.error("[server] Could not close the database cleanly:", err);
		}
	}
	process.exit(0);
}
