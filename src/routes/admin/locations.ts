import { Hono } from "hono";
import { db, type Location } from "../../db";
import { GAME, LIMITS } from "../../config";
import { requireStaff } from "../../auth/guards";
import { cleanHints, difficultyOf, resetLocationStats } from "../../game/locations";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { deleteUpload } from "../../lib/uploads";

export const adminLocationRoutes = new Hono();

function getLocation(id: number): Location {
	return (
		db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?").get(id) ?? fail(404, "Location not found")
	);
}

/** Deletes a location together with the history rows that reference it, then its screenshot. */
export async function deleteLocation(id: number) {
	const location = getLocation(id);
	db.transaction(() => {
		db.run("DELETE FROM daily_challenges WHERE location_id = ?", [id]);
		db.run("DELETE FROM duel_round_scores WHERE location_id = ?", [id]);
		db.run("DELETE FROM locations WHERE id = ?", [id]);
	})();
	await deleteUpload(location.image_path);
	return location;
}

/** The list is open to helpers, who need it to judge suggestions; changing a location is not. */
adminLocationRoutes.get("/", (c) => {
	requireStaff(c, "helper");
	return c.json(
		db
			.query(
				`SELECT l.*, u.username AS submitted_by_username, u.display_name AS submitted_by_display_name,
					a.username AS approved_by_username, a.display_name AS approved_by_display_name,
					COALESCE(s.plays, 0) AS plays,
					CASE WHEN s.plays > 0 THEN ROUND(s.recent_sum / MIN(s.plays, ${GAME.difficulty.window})) END AS avg_score
				FROM locations l
				LEFT JOIN users u ON u.id = l.submitted_by
				LEFT JOIN users a ON a.id = l.approved_by
				LEFT JOIN location_stats s ON s.location_id = l.id
				ORDER BY l.created_at DESC`
			)
			.all()
			.map((location: any) => ({ ...location, difficulty: difficultyOf(location.id) }))
	);
});

/**
 * How a location has played: how often it came up and how players did on it, by mode.
 * Totals only, no names, so helpers may see it. Guesses come from the recent-guess log, which keeps
 * each player's latest ones, so they are a recent sample rather than all-time.
 */
adminLocationRoutes.get("/:id/breakdown", (c) => {
	requireStaff(c, "helper");
	const id = idParam(c);
	if (!db.query("SELECT 1 FROM locations WHERE id = ?").get(id)) fail(404, "Location not found");
	return c.json({
		totals: db.query("SELECT plays, score_sum, updated_at FROM location_stats WHERE location_id = ?").get(id) ?? {
			plays: 0,
			score_sum: 0,
			updated_at: null,
		},
		modes: db
			.query(
				`SELECT mode, COUNT(*) AS guesses, ROUND(AVG(points)) AS avg_points, ROUND(AVG(distance)) AS avg_distance,
					ROUND(AVG(time_taken), 1) AS avg_time, MAX(created_at) AS last_at
				FROM guess_log WHERE location_id = ? GROUP BY mode ORDER BY guesses DESC`
			)
			.all(id),
		/** Guesses per thousand points: 0 is under 1,000, 4 is 4,000 and up. */
		spread: db
			.query(
				"SELECT MIN(points / 1000, 4) AS band, COUNT(*) AS guesses FROM guess_log WHERE location_id = ? GROUP BY band"
			)
			.all(id),
		duels: db
			.query(
				`SELECT COUNT(DISTINCT game_id) AS games, COUNT(*) AS guesses, ROUND(AVG(score)) AS avg_score,
					COALESCE(SUM(guessed_x IS NULL), 0) AS no_guess
				FROM duel_round_scores WHERE location_id = ?`
			)
			.get(id),
		daily: db
			.query(
				`SELECT dc.date, COUNT(ds.id) AS players, ROUND(AVG(ds.score)) AS avg_score, ROUND(AVG(ds.hints_used), 1) AS avg_hints
				FROM daily_challenges dc LEFT JOIN daily_scores ds ON ds.date = dc.date
				WHERE dc.location_id = ? GROUP BY dc.date ORDER BY dc.date DESC LIMIT 6`
			)
			.all(id),
		suggestions: db
			.query("SELECT status, COUNT(*) AS n FROM location_suggestions WHERE location_id = ? GROUP BY status")
			.all(id),
	});
});

/** Forgets how players have done on a location, e.g. after its screenshot or pin was corrected. */
adminLocationRoutes.post("/:id/stats/reset", (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	resetLocationStats(location.id);
	auditLog(staff, "location_stats_reset", {
		targetType: "location",
		targetId: location.id,
		details: location.label,
	});
	return c.json({ success: true });
});

adminLocationRoutes.post("/:id/toggle", (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	db.run("UPDATE locations SET is_active = ? WHERE id = ?", [location.is_active ? 0 : 1, location.id]);
	auditLog(staff, location.is_active ? "location_deactivate" : "location_activate", {
		targetType: "location",
		targetId: location.id,
		details: location.label,
	});
	return c.json({ success: true, is_active: !location.is_active });
});

adminLocationRoutes.post("/:id/label", async (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	const label = text((await readJson<{ label: string }>(c)).label, LIMITS.labelMax + 1);
	if (label.length < LIMITS.labelEditMin || label.length > LIMITS.labelMax)
		fail(400, `Label must be ${LIMITS.labelEditMin}-${LIMITS.labelMax} characters`);
	db.run("UPDATE locations SET label = ? WHERE id = ?", [label, location.id]);
	auditLog(staff, "location_label_edit", {
		targetType: "location",
		targetId: location.id,
		details: `"${location.label ?? ""}" to "${label}"`.slice(0, 300),
	});
	return c.json({ success: true });
});

adminLocationRoutes.post("/:id/hints", async (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	const hints = cleanHints((await readJson<{ hints: string[] }>(c)).hints);
	db.run("UPDATE locations SET hints = ? WHERE id = ?", [JSON.stringify(hints), location.id]);
	auditLog(staff, "location_hints_edit", {
		targetType: "location",
		targetId: location.id,
		details:
			`${location.label ?? `#${location.id}`}: now ${hints.length} hint${hints.length === 1 ? "" : "s"}${hints.length ? ` (${hints.join(" / ")})` : ""}`.slice(
				0,
				300
			),
	});
	return c.json({ success: true });
});

adminLocationRoutes.delete("/:id", async (c) => {
	const staff = requireStaff(c, "operator");
	const location = await deleteLocation(idParam(c));
	auditLog(staff, "location_delete", { targetType: "location", targetId: location.id, details: location.label });
	return c.json({ success: true });
});
