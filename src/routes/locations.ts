import { Hono } from "hono";
import type { Context } from "hono";
import { db, type User } from "../db";
import { LIMITS } from "../config";
import { isStaff, requirePlayer, requireUser } from "../auth/guards";
import { cleanHints } from "../game/locations";
import { parseGuess } from "../game/round";
import { fail, idParam, readForm, readJson, text } from "../lib/http";
import { requireFeature } from "../system/features";
import { checkUserRateLimit } from "../lib/rate-limit";
import { DAY, HOUR, nowSec } from "../lib/time";
import { saveUploadedImage } from "../lib/uploads";
import { displayName, notify } from "../lib/webhook";
import { formCoords } from "./submissions";
import { suggestionsClosed } from "../game/tournaments";

export const locationRoutes = new Hono();
export const suggestionRoutes = new Hono();

const MIN_ACCOUNT_DAYS = 7;
const MIN_GAMES_PLAYED = 5;
const NOTE_MAX = 200;

function suggestionProgress(user: User) {
	const played =
		db
			.query<{ total: number }, [number, number]>(
				"SELECT (SELECT COUNT(*) FROM solo_scores WHERE user_id = ?) + (SELECT COUNT(*) FROM daily_scores WHERE user_id = ?) AS total"
			)
			.get(user.id, user.id)?.total ?? 0;
	return {
		days: { have: Math.floor((nowSec() - user.created_at) / DAY), need: MIN_ACCOUNT_DAYS },
		games: { have: played, need: MIN_GAMES_PLAYED },
	};
}

/** Why this user may not suggest changes yet, or null when they may. Staff and helpers are always allowed. */
function suggestionBlocker(user: User): string | null {
	if (isStaff(user)) return null;
	const closed = suggestionsClosed();
	if (closed) return closed;
	const { days, games } = suggestionProgress(user);
	if (days.have < days.need) return `Your account must be at least ${days.need} days old to suggest changes`;
	if (games.have < games.need) return `You must have played at least ${games.need} games to suggest changes`;
	return null;
}

function requireSuggester(c: Context): User {
	const user = requirePlayer(c);
	const blocker = suggestionBlocker(user);
	if (blocker) fail(403, blocker);
	return user;
}

/** Labels give the answers away, so this list is guarded like them. */
locationRoutes.get("/", (c) => {
	requireSuggester(c);
	return c.json(
		db.query("SELECT id, image_path, label FROM locations WHERE is_active = 1 ORDER BY created_at DESC").all()
	);
});

/** Every answer on the map, so only for people trusted to suggest corrections. */
locationRoutes.get("/with-coords", (c) => {
	requireSuggester(c);
	return c.json(
		db
			.query(
				"SELECT id, image_path, label, world_x, world_y FROM locations WHERE is_active = 1 ORDER BY created_at DESC"
			)
			.all()
	);
});

suggestionRoutes.get("/eligibility", (c) => {
	const user = requireUser(c);
	const closed = isStaff(user) ? null : suggestionsClosed();
	const reason = user.is_banned ? "You are banned" : suggestionBlocker(user);
	return c.json({
		eligible: !reason,
		reason,
		closed: !!closed,
		agreed: !!user.suggestions_agreed,
		progress: reason && !closed && !user.is_banned ? suggestionProgress(user) : null,
	});
});

suggestionRoutes.post("/agree", (c) => {
	const user = requireUser(c);
	db.run("UPDATE users SET suggestions_agreed = 1, suggestions_agreed_at = unixepoch() WHERE id = ?", [user.id]);
	return c.json({ success: true });
});

type Suggestion = {
	type: "hint" | "screenshot" | "coordinates" | "removal" | "full_edit";
	content: Record<string, unknown>;
	image: string | null;
	/** Shown in the staff notification. */
	summary: string | null;
};

async function readFormSuggestion(form: FormData): Promise<Suggestion> {
	const note = text(form.get("note"), NOTE_MAX) || null;

	if (form.get("type") !== "full_edit") {
		const image = await saveUploadedImage(form.get("image"));
		return { type: "screenshot", content: { note }, image, summary: note };
	}

	const coords = formCoords(form);
	const hints = cleanHints(form.get("hints"));
	const label = text(form.get("label"), LIMITS.labelMax) || null;
	const file = form.get("image");
	const hasImage = file instanceof File && file.size > 0;
	if (!hasImage && !coords && !hints.length && !label) fail(400, "At least one change is required");
	if (label && label.length < LIMITS.labelEditMin) fail(400, "That label is too short");

	const image = hasImage ? await saveUploadedImage(file) : null;
	return {
		type: "full_edit",
		content: { world_x: coords?.x ?? null, world_y: coords?.y ?? null, hints, label, note },
		image,
		summary: note,
	};
}

function readJsonSuggestion(body: Record<string, unknown>): Suggestion {
	if (body.type === "hint") {
		const hint = text(body.text, LIMITS.hintLength);
		if (!hint) fail(400, "Hint text required");
		return { type: "hint", content: { text: hint }, image: null, summary: `"${hint}"` };
	}
	if (body.type === "coordinates") {
		const coords = parseGuess(body.world_x, body.world_y) ?? fail(400, "Coordinates required");
		const note = text(body.note, NOTE_MAX) || null;
		return {
			type: "coordinates",
			content: { world_x: coords.x, world_y: coords.y, note },
			image: null,
			summary: note,
		};
	}
	if (body.type === "removal") {
		const reason = text(body.reason, 300);
		if (!reason) fail(400, "Reason required");
		return { type: "removal", content: { reason }, image: null, summary: `"${reason}"` };
	}
	fail(400, "Invalid suggestion type");
}

const SUGGESTION_TITLES: Record<Suggestion["type"], string> = {
	hint: "**Hint suggestion**",
	screenshot: "**Screenshot suggestion**",
	coordinates: "**Coordinates correction**",
	full_edit: "**Full edit suggestion**",
	removal: "**Removal suggestion**",
};

locationRoutes.post("/:id/suggest", async (c) => {
	const user = requireSuggester(c);
	if (!user.suggestions_agreed) fail(403, "You must agree to the suggestions policy first");
	requireFeature("suggestions", user, "Suggestions are closed for now. Please try again later.");

	const locationId = idParam(c);
	const location = db
		.query<{ label: string | null }, [number]>("SELECT label FROM locations WHERE id = ? AND is_active = 1")
		.get(locationId);
	if (!location) fail(404, "Location not found");
	if (!checkUserRateLimit(user, "suggest", 10, HOUR * 1000)) fail(429, "Too many suggestions. Try again later.");

	const isForm = (c.req.header("content-type") || "").includes("multipart/form-data");
	const suggestion = isForm ? await readFormSuggestion(await readForm(c)) : readJsonSuggestion(await readJson(c));

	db.run(
		"INSERT INTO location_suggestions (location_id, user_id, type, content, image_path) VALUES (?, ?, ?, ?, ?)",
		[locationId, user.id, suggestion.type, JSON.stringify(suggestion.content), suggestion.image]
	);
	notify(
		"suggestions",
		`${SUGGESTION_TITLES[suggestion.type]} on "${location.label || `#${locationId}`}" by **${displayName(user)}**${suggestion.summary ? `\n> ${suggestion.summary}` : ""}`,
		"/admin#suggestions"
	);
	return c.json({ success: true });
});
