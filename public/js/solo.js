/** Solo: a run of rounds scored by the server. Works logged out; only logged-in games are saved. */

let user = null;
let view = null;
let replayMap = null;
let game = null;
let rounds = [];
let summary = null;
let getRounds, getTimeLimit;
/** Set when the page was opened from Specials (/play?special=blitz): the server picks the rules. */
const special = new URLSearchParams(location.search).get("special");
/** How this special changes the screenshot ("torch", "snow"), if it does. */
let specialEffect = null;

async function init() {
	getRounds = setupPills(".rounds-pill", (n) => (el("rounds-preview").textContent = n));
	getTimeLimit = setupPills(".time-pill", (s) => {
		el("time-preview").innerHTML = s
			? `${s}s`
			: '<span class="material-symbols-outlined text-2xl leading-none">all_inclusive</span>';
	});
	el("start-btn").addEventListener("click", startGame);
	el("next-btn").addEventListener("click", nextRound);
	el("replay-btn").addEventListener("click", showReplay);
	el("replay-back-btn").addEventListener("click", () => switchScreen("summary-screen"));
	el("play-again-btn").addEventListener("click", () => switchScreen("start-screen"));

	// Built up front so the map tiles are already loaded when the first round starts.
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

/** Swaps the usual options for the special's own description; its rules are fixed. */
async function setupSpecial() {
	if (!user) return location.replace("/specials");
	const info = (await api("/api/specials").catch(() => [])).find(
		(s) => s.id === special && (s.status === "live" || s.preview)
	);
	if (!info) return location.replace("/specials");
	specialEffect = info.effect || null;
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
			json: special ? { special } : { rounds: getRounds(), time_limit: getTimeLimit() },
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
	PhotoEffects.apply(specialEffect);
	await view.show(round);
	if (round.loading) round = (await api(`/api/solo/games/${game.game_id}/begin`, { method: "POST" })).round;
	Sounds.play("start");
	view.go(round);
}

/** The game is gone (server restart or hours idle); nothing to do but start over. */
function gameLost(err) {
	switchScreen("start-screen");
	startError(err.message);
}

async function submitGuess(pin) {
	view.stop();
	// The round is over, so the player may see the whole picture.
	PhotoEffects.clear();
	let result;
	try {
		result = await api(`/api/solo/games/${game.game_id}/guess`, { json: pin ?? {} });
	} catch (err) {
		if (err.status !== 0) return gameLost(err);
		// Offline: let them try the same guess again once the connection is back.
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
	el("result-location-id").textContent = [locId(result.location_id), result.label].filter(Boolean).join(" · ");
	el("result-report-link").href = reportLocationUrl(result.location_id);
	el("next-btn").textContent = result.finished ? "See Results" : "Next Round";
	el("result-screen").classList.add("shown");
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
	Sounds.play(summary.total_score / summary.max_possible >= 0.55 ? "win" : "good");
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
		: summary.saved
			? '<p class="text-green-400 text-sm">Score saved to the leaderboard.</p>'
			: `<p class="text-zinc-500 text-sm"><a href="${escHtml(loginUrl("/play"))}" class="text-blue-400 hover:underline">Log in</a> before you play to save your scores to the leaderboard.</p>`;
}

function showReplay() {
	switchScreen("replay-screen");
	replayMap ??= new MapCanvas(el("replay-canvas"), {});
	replayMap.clearPin();
	rounds.forEach((r, i) => replayMap.showResult(r.correct_x, r.correct_y, r.guessed_x, r.guessed_y, i + 1));
	el("replay-legend").textContent = `${rounds.length} rounds · green = correct · red = your guess`;
}

init();
