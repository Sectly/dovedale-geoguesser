/** Solo: a run of rounds scored by the server. Works logged out; only logged-in games are saved. */

import "./lib/site.js";
import { MapCanvas } from "./map-canvas.js";
import { Sounds } from "./sounds.js";
import { countUp, el, escHtml, locId, scoreTone, show, streakBadgeHtml } from "./lib/dom.js";
import { api, fetchUser, loginUrl } from "./lib/api.js";
import { copyText, showToast } from "./lib/toast.js";
import { checkAchievements } from "./lib/achievements.js";
import { addKeybinds } from "./lib/keys.js";
import { celebrate } from "./lib/effects.js";
import {
	RoundView,
	difficultyText,
	renderRoundResult,
	reportLocation,
	reportLocationUrl,
	setupPills,
} from "./round.js";
import { PhotoEffects } from "./photo-effects.js";

let user = null;
let view = null;
let replayMap = null;
let game = null;
let rounds = [];
let summary = null;
let getRounds, getTimeLimit, getDifficulty;
/** The pills carry numbers; these are the names the server knows them by. */
const DIFFICULTY_NAMES = [null, "easy", "medium", "hard"];
/** Set when the page was opened from Specials (/play?special=blitz): the server picks the rules. */
const special = new URLSearchParams(location.search).get("special");
let specialEffect = null;
let specialEffectOption;

async function init() {
	getRounds = setupPills(".rounds-pill", (n) => (el("rounds-preview").textContent = n));
	getTimeLimit = setupPills(".time-pill", (s) => {
		el("time-preview").innerHTML = s
			? `${s}s`
			: '<span class="material-symbols-outlined text-2xl leading-none" title="No time limit">all_inclusive</span>';
	});
	getDifficulty = setupPills(".difficulty-pill", (level) => {
		el("difficulty-note").textContent = level
			? "Practice: not counted on the leaderboard."
			: "Locations are graded by how players have done on them.";
	});
	for (const pill of document.querySelectorAll(".difficulty-pill")) {
		/** Runs before the pill's own handler, so a difficulty with no locations cannot be picked. */
		pill.addEventListener(
			"click",
			(e) => pill.getAttribute("aria-disabled") === "true" && e.stopImmediatePropagation(),
			true
		);
	}
	if (!special) loadDifficulties();
	el("start-btn").addEventListener("click", startGame);
	el("next-btn").addEventListener("click", nextRound);
	el("replay-btn").addEventListener("click", showReplay);
	el("replay-back-btn").addEventListener("click", () => switchScreen("summary-screen"));
	el("play-again-btn").addEventListener("click", () => switchScreen("start-screen"));
	el("summary-share-btn").addEventListener("click", shareSummary);

	/** Built up front so the map tiles are already loaded when the first round starts. */
	view = new RoundView({
		onGuess: submitGuess,
		onHint: () => api(`/api/solo/games/${game.game_id}/hint`, { method: "POST" }),
	});
	const visible = (id) => !el(id).classList.contains("hidden");
	const advance = () => {
		if (visible("start-screen")) return startGame();
		if (visible("round-screen") && el("result-screen").classList.contains("shown")) return nextRound();
		if (visible("summary-screen")) return switchScreen("start-screen");
		return false;
	};
	addKeybinds("Solo", [
		[["Enter", "Space"], "Play, next round, or play again", advance],
		[["R"], "View the replay map (after a game)", () => (visible("summary-screen") ? showReplay() : false)],
	]);
	user = await fetchUser();
	show("login-save-hint", !user && !special);
	if (special) setupSpecial();
}

async function loadDifficulties() {
	const counts = await api("/api/solo/difficulties").catch(() => null);
	if (!counts) return;
	for (const pill of document.querySelectorAll(".difficulty-pill")) {
		const name = DIFFICULTY_NAMES[Number(pill.dataset.val)];
		if (!name) continue;
		/** Marked unavailable rather than disabled, so hovering it can still say why. */
		pill.setAttribute("aria-disabled", String(!counts[name]));
		pill.classList.toggle("opacity-40", !counts[name]);
		pill.classList.toggle("cursor-not-allowed", !counts[name]);
		pill.title = counts[name]
			? `${counts[name]} ${name} location${counts[name] === 1 ? "" : "s"}`
			: `No locations have been graded ${name} yet`;
	}
}

async function setupSpecial() {
	if (!user) return location.replace("/specials");
	const info = (await api("/api/specials").catch(() => [])).find(
		(s) => s.id === special && (s.status === "live" || s.preview)
	);
	if (!info) return location.replace("/specials");
	specialEffect = info.effect || null;
	specialEffectOption = info.flashSeconds;
	document.title = `${info.title} | Dovedale GeoGuesser`;
	el("start-icon").textContent = info.icon;
	el("start-title").textContent = info.title;
	el("start-subtitle").textContent = "Specials";
	const card = el("start-card");
	for (const child of [...card.children]) {
		if (child.id !== "start-btn" && child.id !== "start-error") child.remove();
	}
	card.insertAdjacentHTML(
		"afterbegin",
		`<p class="text-sm text-zinc-400 text-center mb-6">${escHtml(info.blurb)}</p>`
	);
	el("start-btn").textContent = `Play ${info.title}`;
	card.insertAdjacentHTML("afterend", '<a href="/specials" class="m-btn m-btn-text mt-4">Back to Specials</a>');
}

function switchScreen(id) {
	for (const screen of ["start-screen", "round-screen", "summary-screen", "replay-screen"])
		show(screen, screen === id);
}

function startError(message) {
	el("start-error").textContent = message;
	show("start-error", !!message);
}

async function startGame() {
	const btn = el("start-btn");
	if (btn.disabled) return;
	btn.disabled = true;
	startError("");
	try {
		game = await api("/api/solo/games", {
			json: special
				? { special }
				: {
						rounds: getRounds(),
						time_limit: getTimeLimit(),
						difficulty: DIFFICULTY_NAMES[getDifficulty()] ?? undefined,
					},
		});
		rounds = [];
		summary = null;
		switchScreen("round-screen");
		await beginRound(game.round);
	} catch (err) {
		startError(err.message);
	} finally {
		btn.disabled = false;
	}
}

/** Shows the round, and only asks the server to start the clock once the screenshot is on screen. */
async function beginRound(round) {
	el("round-num").textContent = round.number;
	el("round-total").textContent = round.total;
	el("result-screen").classList.remove("shown");
	PhotoEffects.apply(specialEffect, specialEffectOption);
	await view.show(round);
	if (round.loading) round = (await api(`/api/solo/games/${game.game_id}/begin`, { method: "POST" })).round;
	Sounds.play("start");
	view.go(round);
	PhotoEffects.begin();
}

/** The game is gone (server restart or hours idle); nothing to do but start over. */
function gameLost(err) {
	switchScreen("start-screen");
	startError(err.message);
}

async function submitGuess(pin) {
	view.stop();
	PhotoEffects.clear();
	let result;
	try {
		result = await api(`/api/solo/games/${game.game_id}/guess`, { json: pin ?? {} });
	} catch (err) {
		if (err.status !== 0) return gameLost(err);
		/** Offline: let them try the same guess again once the connection is back. */
		showToast(err.message, "error");
		view.locked = false;
		view._setGuessEnabled(true);
		el("click-hint").textContent = "Couldn't send your guess. Press Submit to retry";
		return;
	}

	rounds.push(result);
	summary = result.summary;
	view.showAnswer(result, pin);
	renderRoundResult(result);
	el("result-location-id").textContent = [locId(result.location_id), result.label, difficultyText(result.difficulty)]
		.filter(Boolean)
		.join(" · ");
	el("result-report-link").href = reportLocationUrl(result.location_id);
	el("result-report-link").onclick = (e) => reportLocation(e, result.location_id);
	el("next-btn").textContent = result.finished ? "See Results" : "Next round";
	el("result-screen").classList.add("shown");
	view.fitResult(result, [pin]);
	if (user) checkAchievements(1200);
}

async function nextRound() {
	if (summary) return showSummary();
	const btn = el("next-btn");
	if (btn.disabled) return;
	btn.disabled = true;
	try {
		await beginRound((await api(`/api/solo/games/${game.game_id}/next`, { method: "POST" })).round);
	} catch (err) {
		if (err.status === 0) showToast(err.message, "error");
		else gameLost(err);
	} finally {
		btn.disabled = false;
	}
}

function showSummary() {
	switchScreen("summary-screen");
	Sounds.play(summary.personal_best || summary.total_score / summary.max_possible >= 0.55 ? "win" : "good");
	if (summary.personal_best) celebrate();
	el("result-screen").classList.remove("shown");

	const pct = summary.total_score / summary.max_possible;
	const grade = pct >= 0.9 ? "S" : pct >= 0.75 ? "A" : pct >= 0.55 ? "B" : pct >= 0.35 ? "C" : "D";
	countUp(el("summary-total"), summary.total_score, { duration: 1400 });
	if (grade === "S" || grade === "A") celebrate();
	el("summary-total").className = `text-7xl font-bold mb-1 font-mono grade-${grade.toLowerCase()}`;
	el("summary-out-of").textContent = `Grade ${grade} · out of ${summary.max_possible.toLocaleString()}`;

	el("summary-rounds").innerHTML = rounds
		.map((r, i) => {
			const tone = scoreTone(r.score);
			return `<div class="round-row flex items-center gap-3 py-3">
				<span class="text-zinc-500 text-xs w-8 flex-shrink-0 font-medium">R${i + 1}</span>
				<div class="flex-1 min-w-0">
					<div class="text-xs text-zinc-400 truncate mb-1">${escHtml(r.label || locId(r.location_id))}</div>
					<div class="bg-zinc-800 rounded-full h-1.5 overflow-hidden">
						<div class="h-1.5 rounded-full ${tone.bar}" style="width:${(r.score / 5000) * 100}%"></div>
					</div>
				</div>
				<span class="text-sm font-mono font-bold ${tone.text} w-16 text-right flex-shrink-0">${r.score.toLocaleString()}</span>
			</div>`;
		})
		.join("");

	el("summary-streak").innerHTML = streakBadgeHtml(summary.current_streak, {
		best: summary.current_streak === summary.longest_streak,
	});
	el("summary-save-area").innerHTML = summary.special
		? '<p class="text-zinc-500 text-sm">Specials scores are not saved to the leaderboard. <a href="/specials" class="text-blue-400 hover:underline">Back to Specials</a></p>'
		: summary.difficulty
			? `<p class="text-zinc-500 text-sm">Practice on ${escHtml(summary.difficulty)} locations: not saved to the leaderboard.</p>`
			: summary.saved
				? `${summary.personal_best ? `<p class="streak-pop text-yellow-400 text-sm font-semibold mb-1 flex items-center justify-center gap-1.5"><span class="material-symbols-outlined text-base leading-none" style="font-variation-settings:'FILL' 1">trending_up</span>New personal best! Up from ${summary.previous_best.toLocaleString()}</p>` : ""}<p class="text-green-400 text-sm">Score saved to the leaderboard.</p>`
				: `<p class="text-zinc-500 text-sm"><a href="${escHtml(loginUrl("/play"))}" class="text-blue-400 hover:underline">Log in</a> before you play to save your scores to the leaderboard.</p>`;
}

/** Copies the finished game to share: a square per round and the total, nothing that names a location. */
async function shareSummary() {
	if (!summary) return;
	const square = (score) => (score >= 4000 ? "🟩" : score >= 2000 ? "🟨" : score > 0 ? "🟧" : "⬜");
	const lines = [
		`Dovedale GeoGuesser · Solo, ${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
		`${rounds.map((r) => square(r.score)).join("")} ${summary.total_score.toLocaleString()} of ${summary.max_possible.toLocaleString()}`,
		summary.personal_best ? "New personal best" : "",
		`${location.origin}/play`,
	].filter(Boolean);
	if (await copyText(lines.join("\n"))) showToast("Result copied. Paste it anywhere.", "success");
	else showToast("Couldn't copy the result.", "error");
}

function showReplay() {
	switchScreen("replay-screen");
	replayMap ??= new MapCanvas(el("replay-canvas"), {});
	replayMap.clearPin();
	rounds.forEach((r, i) => replayMap.showResult(r.correct_x, r.correct_y, r.guessed_x, r.guessed_y, i + 1));
	el("replay-legend").textContent = `${rounds.length} rounds · green = correct · red = your guess`;
}

init();
