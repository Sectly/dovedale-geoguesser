import { Hono } from "hono";
import { db } from "../db";
import { LIMITS } from "../config";
import { requirePlayer, requireUser } from "../auth/guards";
import { cleanHints } from "../game/locations";
import { fail, readForm, text } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { DAY, HOUR, nowSec } from "../lib/time";
import { saveUploadedImage } from "../lib/uploads";
import { displayName, notify } from "../lib/webhook";
import { requireFeature } from "../system/features";

export const submissionRoutes = new Hono();

/** Reads a pair of map coordinates from a form, or null when either is missing or not a number. */
export function formCoords(form: FormData): { x: number; y: number } | null {
	const x = parseFloat(String(form.get("world_x") ?? ""));
	const y = parseFloat(String(form.get("world_y") ?? ""));
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

submissionRoutes.post("/", async (c) => {
	const user = requirePlayer(c);
	if (user.upload_limited) fail(403, "Your upload ability has been temporarily limited");
	requireFeature("submissions", user, "Submissions are closed for now. Please try again later.");

	const form = await readForm(c);
	const label = text(form.get("label"), LIMITS.labelMax + 1);
	if (label.length < LIMITS.labelMin || label.length > LIMITS.labelMax)
		fail(400, `Label must be between ${LIMITS.labelMin} and ${LIMITS.labelMax} characters (got ${label.length})`);
	const coords = formCoords(form) ?? fail(400, "Place a pin on the map first");
	const hints = cleanHints(form.get("hints"));

	/** Checked after validation so a typo does not burn one of the hourly submissions. */
	if (!checkUserRateLimit(user, "sub", 8, HOUR * 1000)) fail(429, "Too many submissions. Try again later.");
	const filename = await saveUploadedImage(form.get("image"));
	const result = db.run(
		"INSERT INTO submissions (image_path, world_x, world_y, label, hints, submitted_by) VALUES (?, ?, ?, ?, ?, ?)",
		[filename, coords.x, coords.y, label, JSON.stringify(hints), user.id]
	);

	notify(
		"submissions",
		`**New submission** #${result.lastInsertRowid} from **${displayName(user)}** (@${user.username})\n> "${label}"`,
		"/admin#submissions"
	);
	return c.json({ success: true });
});

submissionRoutes.get("/mine", (c) => {
	const user = requireUser(c);
	const rows = db
		.query(
			`SELECT id, image_path, label, hints, world_x, world_y, status, deny_reason, created_at, reviewed_at
			FROM submissions
			WHERE submitted_by = ? AND NOT (status = 'denied' AND reviewed_at < ?)
			ORDER BY created_at DESC LIMIT 50`
		)
		.all(user.id, nowSec() - 30 * DAY);
	return c.json(rows);
});
