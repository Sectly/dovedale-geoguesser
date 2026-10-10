let ROUND_TIME = 90;
const MAX_SCORE_PER_ROUND = 5000;
const HINT_COST = 500;

let mapCanvas = null;
let replayCanvas = null;
let currentUser = null;
let locations = [];
let currentRound = 0;
let totalRounds = 5;
let roundScores = [];
let roundData = [];
let pinWorld = null;
let timerInterval = null;
let timerRemaining = ROUND_TIME;
let roundStartTime = 0;
let hintsUsed = 0;
let hintsShown = 0;
let guessSubmitted = false;

async function init() {
	currentUser = await fetchUser();
	renderAuthArea();
	setupPhotoLens(document.getElementById("round-photo"));
	el("start-btn").addEventListener("click", startGame);
	el("guess-btn").addEventListener("click", submitGuess);
	el("next-btn").addEventListener("click", nextRound);
	el("replay-btn").addEventListener("click", showReplay);
	el("replay-back-btn").addEventListener("click", () => {
		el("replay-screen").classList.add("hidden");
		el("summary-screen").classList.remove("hidden");
	});
	el("play-again-btn").addEventListener("click", () => {
		el("summary-screen").classList.add("hidden");
		el("start-screen").classList.remove("hidden");
	});
}

function renderAuthArea() {
	const area = el("auth-area");
	if (currentUser) {
		area.innerHTML = `
            <div class="flex items-center gap-2">
                <a href="/u/${encodeURIComponent(currentUser.username)}" class="flex items-center gap-2 hover:opacity-80 transition">
                    ${currentUser.avatar_url ? `<img src="${escHtml(currentUser.avatar_url)}" class="w-7 h-7 rounded-full" />` : ""}
                    <span class="text-sm text-zinc-300">${escHtml(currentUser.display_name || currentUser.username)}</span>
                </a>
                <a href="/api/auth/logout" class="text-xs text-zinc-500 hover:text-zinc-300 transition ml-1">Logout</a>
            </div>`;
		const hint = el("login-save-hint");
		if (hint) hint.style.display = "none";
	} else {
		area.innerHTML = `<a href="/api/auth/login?redirect=/play" class="text-sm bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg">Login with Discord</a>`;
	}
}

async function startGame() {
	totalRounds = parseInt(el("rounds-select").value);
	ROUND_TIME = parseInt(el("time-select").value);
	el("start-error").classList.add("hidden");

	try {
		const r = await fetch(`/api/locations/random?count=${totalRounds}`);
		if (r.status === 401) {
			window.location.href = `/api/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
			return;
		}
		if (!r.ok) throw new Error(await r.text());
		locations = await r.json();
	} catch (err) {
		el("start-error").textContent = err.message || "Failed to load locations.";
		el("start-error").classList.remove("hidden");
		return;
	}

	if (locations.length === 0) {
		el("start-error").textContent = "No locations available yet. Check back later!";
		el("start-error").classList.remove("hidden");
		return;
	}

	totalRounds = locations.length;
	currentRound = 0;
	roundScores = [];
	roundData = [];

	el("start-screen").classList.add("hidden");
	el("round-screen").classList.remove("hidden");

	const canvas = el("map-canvas");
	mapCanvas = new MapCanvas(canvas, {
		onPinPlaced: (wx, wy) => {
			pinWorld = { x: wx, y: wy };
			const gb = el("guess-btn");
			gb.disabled = false;
			gb.className =
				"pointer-events-auto bg-blue-600 hover:bg-blue-500 active:scale-95 transition pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm shadow-sm whitespace-nowrap cursor-pointer flex items-center gap-2";
			el("click-hint").textContent = "Pin placed - submit or move it";
		},
	});

	showRound();
}

function showRound() {
	const loc = locations[currentRound];
	el("round-num").textContent = currentRound + 1;
	el("round-total").textContent = totalRounds;
	el("round-photo").src = `/uploads/${loc.image_path}`;
	el("location-id-badge").textContent = locId(loc.id);
	el("result-screen").classList.remove("shown");
	const gb = el("guess-btn");
	gb.disabled = true;
	gb.className =
		"pointer-events-auto bg-zinc-700 text-zinc-500 pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm whitespace-nowrap cursor-not-allowed transition flex items-center gap-2";
	el("click-hint").textContent = "Click the map to place your pin";
	mapCanvas?.setPinEnabled(true);

	pinWorld = null;
	hintsUsed = 0;
	hintsShown = 0;
	guessSubmitted = false;
	mapCanvas?.clearPin();
	renderHints(loc.hints || []);
	startTimer();
	roundStartTime = Date.now();
}

function renderHints(hints) {
	const panel = el("hints-panel");
	if (!hints.length) {
		panel.innerHTML = `
            <button onclick="showNoHints()" class="bg-zinc-900/80 hover:bg-zinc-800 transition px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border border-zinc-700 opacity-60">
                <span class="material-symbols-outlined text-sm leading-none text-zinc-500">lightbulb</span>
                Hint
            </button>
            <div id="hint-list" class="flex flex-col gap-1"></div>`;
		return;
	}
	panel.innerHTML = `
        <button id="hint-btn" onclick="revealNextHint()" class="bg-zinc-900/80 hover:bg-zinc-800 transition px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border border-zinc-700">
            <span class="material-symbols-outlined text-sm leading-none text-yellow-400">lightbulb</span>
            Hint (-${HINT_COST} pts)
        </button>
        <div id="hint-list" class="flex flex-col gap-1"></div>`;
	el("hint-btn")._hints = hints;
}

function showNoHints() {
	const list = el("hint-list");
	if (!list || list.children.length) return;
	const item = document.createElement("div");
	item.className = "bg-zinc-800/80 border border-zinc-700 text-zinc-500 text-xs px-3 py-1.5 rounded-lg";
	item.textContent = "No hints available for this location.";
	list.appendChild(item);
}

function revealNextHint() {
	const btn = el("hint-btn");
	if (!btn) return;
	const hints = btn._hints || [];
	if (hintsShown >= hints.length) return;

	hintsUsed++;
	const text = hints[hintsShown++];
	const item = document.createElement("div");
	item.className = "bg-yellow-900/60 border border-yellow-700/50 text-yellow-200 text-xs px-3 py-1.5 rounded-lg";
	item.innerHTML = `<span class="material-symbols-outlined text-xs align-middle" style="font-variation-settings:'FILL' 1">lightbulb</span> `;
	item.appendChild(document.createTextNode(text));
	el("hint-list").appendChild(item);

	if (hintsShown >= hints.length) {
		btn.disabled = true;
		btn.className = btn.className + " opacity-40 cursor-not-allowed";
	}
}

function setTimerColor(remaining) {
	const d = el("timer-display");
	d.classList.remove("text-green-400", "text-yellow-400", "text-orange-400", "text-red-400", "timer-urgent");
	if (ROUND_TIME === 0) {
		d.classList.add("text-zinc-400");
		return;
	}
	const pct = remaining / ROUND_TIME;
	if (pct > 0.5) d.classList.add("text-green-400");
	else if (pct > 0.25) d.classList.add("text-yellow-400");
	else if (pct > 0.1) d.classList.add("text-orange-400");
	else d.classList.add("text-red-400");
	if (remaining <= 10) d.classList.add("timer-urgent");
}

function startTimer() {
	clearInterval(timerInterval);
	const timerDisplay = el("timer-display");
	if (ROUND_TIME === 0) {
		timerDisplay.classList.add("hidden");
		return;
	}
	timerDisplay.classList.remove("hidden");
	timerRemaining = ROUND_TIME;
	el("timer-val").textContent = timerRemaining;
	setTimerColor(timerRemaining);

	timerInterval = setInterval(() => {
		timerRemaining--;
		el("timer-val").textContent = timerRemaining;
		setTimerColor(timerRemaining);
		if (timerRemaining <= 0) {
			clearInterval(timerInterval);
			submitGuess();
		}
	}, 1000);
}

function submitGuess() {
	if (guessSubmitted) return;
	guessSubmitted = true;
	clearInterval(timerInterval);
	mapCanvas?.setPinEnabled(false);
	const loc = locations[currentRound];

	let distance = null;
	let score = 0;

	if (pinWorld) {
		distance = Math.hypot(pinWorld.x - loc.world_x, pinWorld.y - loc.world_y);
		score = Math.max(0, Math.round(5000 * Math.exp(-distance / 9322)));
		score = Math.max(0, score - hintsUsed * HINT_COST);
		mapCanvas?.showResult(loc.world_x, loc.world_y, pinWorld.x, pinWorld.y);
	} else {
		mapCanvas?.showResult(loc.world_x, loc.world_y);
	}

	roundScores.push(score);
	roundData.push({
		locationId: loc.id,
		correctX: loc.world_x,
		correctY: loc.world_y,
		guessX: pinWorld?.x ?? null,
		guessY: pinWorld?.y ?? null,
		label: loc.label,
		score,
		distance,
		hintsUsed,
	});

	showRoundResult(score, distance, loc.label, loc.id);
}

function showRoundResult(score, distance, label, locationId) {
	const scoreEl = el("result-score-display");
	scoreEl.textContent = score.toLocaleString() + " pts";
	scoreEl.className = `text-3xl font-bold leading-none ${score > 3000 ? "text-green-400" : score > 1500 ? "text-yellow-400" : "text-red-400"}`;
	el("result-distance-display").textContent =
		distance !== null ? `~${Math.round(distance).toLocaleString()} units away` : "No guess submitted";
	el("result-location-id").textContent = locId(locationId);

	const reportLink = el("result-report-link");
	reportLink.href = `/settings?ticket=report_location&loc=${locationId}`;

	const pct = (score / MAX_SCORE_PER_ROUND) * 100;
	const bar = el("result-score-bar");
	bar.style.width = "0%";
	bar.className = `score-bar h-3 rounded-full ${score > 3000 ? "bg-green-500" : score > 1500 ? "bg-yellow-500" : "bg-red-500"}`;
	setTimeout(() => {
		bar.style.width = `${pct}%`;
	}, 50);

	const isLast = currentRound >= totalRounds - 1;
	el("next-btn").textContent = isLast ? "See Results" : "Next Round";
	el("result-screen").classList.add("shown");
}

function nextRound() {
	currentRound++;
	if (currentRound >= totalRounds) showSummary();
	else showRound();
}

async function showSummary() {
	el("round-screen").classList.add("hidden");
	el("result-screen").classList.remove("shown");
	el("summary-screen").classList.remove("hidden");

	const total = roundScores.reduce((a, b) => a + b, 0);
	const maxPossible = totalRounds * MAX_SCORE_PER_ROUND;
	const pctTotal = total / maxPossible;
	const grade =
		pctTotal >= 0.9 ? "S" : pctTotal >= 0.75 ? "A" : pctTotal >= 0.55 ? "B" : pctTotal >= 0.35 ? "C" : "D";
	const gradeClass = { S: "grade-s", A: "grade-a", B: "grade-b", C: "grade-c", D: "grade-d" }[grade];
	const totalEl = el("summary-total");
	totalEl.textContent = total.toLocaleString();
	totalEl.className = `text-7xl font-bold mb-1 font-mono ${gradeClass}`;
	el("summary-out-of").textContent = `${grade} · out of ${maxPossible.toLocaleString()}`;

	const container = el("summary-rounds");
	container.innerHTML = "";
	roundScores.forEach((score, i) => {
		const pct = Math.round((score / MAX_SCORE_PER_ROUND) * 100);
		const d = roundData[i];
		const barColor = score > 3000 ? "bg-green-500" : score > 1500 ? "bg-yellow-500" : "bg-red-500";
		const scoreColor = score > 3000 ? "text-green-400" : score > 1500 ? "text-yellow-400" : "text-red-400";
		container.innerHTML += `
            <div class="round-row flex items-center gap-3 py-3 px-0 rounded-lg transition">
                <span class="text-zinc-500 text-xs w-12 flex-shrink-0 font-medium">R${i + 1}</span>
                <div class="flex-1 bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                    <div class="h-1.5 rounded-full ${barColor}" style="width:${pct}%"></div>
                </div>
                <span class="text-sm font-mono font-bold ${scoreColor} w-20 text-right flex-shrink-0">${score.toLocaleString()}</span>
            </div>`;
	});

	const saveArea = el("summary-save-area");
	el("summary-streak").innerHTML = "";

	if (currentUser) {
		try {
			const r = await fetch("/api/solo/score", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					total_score: total,
					rounds: totalRounds,
					max_possible: maxPossible,
					time_limit: ROUND_TIME,
				}),
			});
			if (r.ok) {
				const data = await r.json();
				saveArea.innerHTML = `<p class="text-green-400 text-sm">Score saved to leaderboard!</p>`;
				if (data.current_streak > 0) {
					const isNew = data.current_streak > 1;
					el("summary-streak").innerHTML = `
                        <div class="inline-flex items-center gap-2 bg-orange-900/40 border border-orange-700/40 px-4 py-2 rounded-xl text-orange-300 text-sm mb-4">
                            <span class="material-symbols-outlined text-xl text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>
                            ${isNew ? `${data.current_streak}-day streak!` : "Streak started!"}
                            ${data.current_streak === data.longest_streak && data.current_streak > 1 ? ' <span class="text-xs text-orange-400 ml-1">(personal best)</span>' : ""}
                        </div>`;
				}
			}
		} catch {
			saveArea.innerHTML = `<p class="text-zinc-500 text-sm">Could not save score.</p>`;
		}
	} else {
		saveArea.innerHTML = `<p class="text-zinc-500 text-sm"><a href="/api/auth/login?redirect=/play" class="text-blue-400 hover:underline">Log in</a> to save your score to the leaderboard.</p>`;
	}
}

function showReplay() {
	el("summary-screen").classList.add("hidden");
	el("replay-screen").classList.remove("hidden");

	if (!replayCanvas) {
		replayCanvas = new MapCanvas(el("replay-canvas"), {});
	}

	el("replay-legend").textContent = `${roundData.length} rounds: green = correct, red = your guess`;
	replayCanvas.clearPin();

	roundData.forEach((d, i) => {
		if (d.guessX !== null) replayCanvas.showResult(d.correctX, d.correctY, d.guessX, d.guessY, i + 1);
		else replayCanvas.showResult(d.correctX, d.correctY, null, null, i + 1);
	});
}

window.revealNextHint = revealNextHint;
window.showNoHints = showNoHints;

init();
