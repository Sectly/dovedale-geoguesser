/** Daily challenge: one round a day. The server keeps the clock, so a reload resumes the same attempt. */

import "./lib/site.js";
import { MapCanvas } from "./map-canvas.js";
import { el, locId, scoreTone, show, streakBadgeHtml } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { copyText, showToast } from "./lib/toast.js";
import { checkAchievements } from "./lib/achievements.js";
import { celebrate } from "./lib/effects.js";
import { RoundView, difficultyText, renderRoundResult, reportLocation, reportLocationUrl } from "./round.js";

let view = null;

function fail(message) {
	el("loading-msg").textContent = message;
	show("loading-spinner", false);
	show("loading-home-btn");
}

function switchScreen(id) {
	for (const screen of ["loading-screen", "login-gate", "already-played-screen", "game-screen"])
		show(screen, screen === id);
}

async function init() {
	const user = await fetchUser();
	if (!user) return switchScreen("login-gate");

	try {
		const status = await api("/api/daily");
		if (status.already_played) return showAlreadyPlayed({ ...status.result, date: status.date });

		view = new RoundView({ onGuess: submitGuess, onHint: () => api("/api/daily/hint", { method: "POST" }) });
		let round = await api("/api/daily/start", { method: "POST" });
		switchScreen("game-screen");
		/** The clock only starts once the screenshot is on screen. */
		await view.show(round);
		if (round.loading) round = await api("/api/daily/begin", { method: "POST" });
		else showToast("Picking up where you left off. The clock kept running.");
		view.go(round);
	} catch (err) {
		fail(err.status === 404 ? "No challenge available today. Check back later." : err.message);
	}
}

function showAlreadyPlayed(result) {
	switchScreen("already-played-screen");
	const tone = scoreTone(result.score);
	el("played-score").textContent = `${result.score.toLocaleString()} pts`;
	el("played-score").className = `text-5xl font-bold font-mono ${tone.text}`;
	el("played-details").textContent = [
		result.distance !== null ? `~${result.distance.toLocaleString()} units away` : "No guess submitted",
		result.label,
	]
		.filter(Boolean)
		.join(" · ");
	startResetCountdown("played-reset");
	el("played-share-btn").onclick = () => shareResult(result);
	new MapCanvas(el("replay-canvas"), {}).showResult(
		result.correct_x,
		result.correct_y,
		result.guessed_x,
		result.guessed_y
	);
}

/** Copies a result to share: the score, but nothing that gives the location away. */
async function shareResult(result) {
	const day = new Date(`${result.date}T00:00:00Z`).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});
	const filled = Math.max(0, Math.min(5, Math.round((result.score / 5000) * 5)));
	const details = [
		result.distance !== null ? `~${result.distance.toLocaleString()} units away` : "No guess",
		result.time_taken !== null && result.time_taken !== undefined ? `${Math.round(result.time_taken)}s` : "",
		result.hints_used ? `${result.hints_used} hint${result.hints_used === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	const lines = [
		`Dovedale GeoGuesser · Daily ${day}`,
		`${"🟩".repeat(filled)}${"⬜".repeat(5 - filled)} ${result.score.toLocaleString()} pts`,
		details.join(" · "),
		result.current_streak > 1 ? `${result.current_streak}-day streak` : "",
		`${location.origin}/daily`,
	].filter(Boolean);
	if (await copyText(lines.join("\n"))) showToast("Result copied. Paste it anywhere.", "success");
	else showToast("Couldn't copy the result.", "error");
}

/** Counts down to the next challenge, which unlocks at midnight UTC. */
function startResetCountdown(id) {
	const target = el(id);
	if (!target) return;
	const tick = () => {
		const now = new Date();
		const left = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
		const h = Math.floor(left / 3_600_000);
		const m = Math.floor((left % 3_600_000) / 60_000);
		target.textContent = `Next challenge in ${h}h ${String(m).padStart(2, "0")}m`;
	};
	tick();
	setInterval(tick, 30_000);
}

async function submitGuess(pin) {
	view.stop();
	let result;
	try {
		result = await api("/api/daily/guess", { json: pin ?? {} });
	} catch (err) {
		if (err.status === 0) {
			showToast(err.message, "error");
			view.locked = false;
			view._setGuessEnabled(true);
			el("click-hint").textContent = "Couldn't send your guess. Press Submit to retry";
			return;
		}
		switchScreen("loading-screen");
		return fail(err.message);
	}

	view.showAnswer(result, pin);
	renderRoundResult(result);
	if (result.score >= 4500) celebrate();
	el("result-location-label").textContent = [
		locId(result.location_id),
		result.label,
		difficultyText(result.difficulty),
	]
		.filter(Boolean)
		.join(" · ");
	el("result-share-btn").onclick = () => shareResult(result);
	el("result-report-link").href = reportLocationUrl(result.location_id);
	el("result-report-link").onclick = (e) => reportLocation(e, result.location_id);
	show("result-report-link");
	el("result-streak-display").innerHTML = streakBadgeHtml(result.current_streak, {
		best: result.current_streak === result.longest_streak,
	});
	startResetCountdown("result-reset");
	el("result-screen").classList.add("shown");
	view.fitResult(result, [pin]);
	checkAchievements(1200);
}

init();
