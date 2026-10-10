const ROUND_TIME = 90;
const HINT_COST = 500;

let currentUser = null;
let mapCanvas = null;
let pinWorld = null;
let timerInterval = null;
let timerRemaining = ROUND_TIME;
let hintsUsed = 0;
let hintsShown = 0;
let hints = [];
let startTime = 0;
let guessSubmitted = false;

function setGuessBtnDisabled(disabled) {
	const btn = el("guess-btn");
	btn.disabled = disabled;
	btn.className = disabled
		? "pointer-events-auto bg-zinc-700 text-zinc-500 pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm whitespace-nowrap cursor-not-allowed transition flex items-center gap-2"
		: "pointer-events-auto bg-blue-600 hover:bg-blue-500 active:scale-95 transition pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm shadow-sm whitespace-nowrap cursor-pointer flex items-center gap-2";
}

function showNoChallenge(msg) {
	el("loading-msg").textContent = msg;
	el("loading-home-btn")?.classList.remove("hidden");
}

async function init() {
	currentUser = await fetchUser();

	if (!currentUser) {
		el("loading-screen").classList.add("hidden");
		el("login-gate").classList.remove("hidden");
		return;
	}

	const r = await fetch("/api/daily").catch(() => null);
	if (!r || !r.ok) {
		showNoChallenge(
			r && r.status === 401
				? "Please log in again to play today\u2019s challenge."
				: "No challenge available today. Check back later."
		);
		return;
	}
	const data = await r.json();
	if (!data) {
		showNoChallenge("No challenge available today. Check back later.");
		return;
	}

	if (data.already_played) {
		renderAuthArea(["auth-area-played"]);
		el("loading-screen").classList.add("hidden");
		el("already-played-screen").classList.remove("hidden");
		return;
	}

	renderAuthArea(["auth-area"]);
	hints = data.hints || [];
	el("round-photo").src = data.image_url;
	el("loading-screen").classList.add("hidden");
	el("game-screen").classList.remove("hidden");

	mapCanvas = new MapCanvas(el("map-canvas"), {
		onPinPlaced: (wx, wy) => {
			if (guessSubmitted) return;
			pinWorld = { x: wx, y: wy };
			setGuessBtnDisabled(false);
			el("click-hint").textContent = "Pin placed. Click to move";
		},
	});

	el("zoom-in").addEventListener("click", () => mapCanvas?.zoomIn());
	el("zoom-out").addEventListener("click", () => mapCanvas?.zoomOut());
	el("guess-btn").addEventListener("click", submitGuess);

	renderHints();
	startTimer();
	startTime = Date.now();
}

function renderAuthArea(ids = ["auth-area"]) {
	const html = currentUser
		? `<div class="flex items-center gap-2">
               ${currentUser.avatar_url ? `<img src="${escHtml(currentUser.avatar_url)}" class="w-6 h-6 rounded-full" />` : ""}
               <span class="text-xs text-zinc-300">${escHtml(currentUser.display_name || currentUser.username)}</span>
               <a href="/api/auth/logout" class="text-xs text-zinc-500 hover:text-zinc-300 transition">Logout</a>
           </div>`
		: "";
	ids.forEach((id) => {
		const a = el(id);
		if (a) a.innerHTML = html;
	});
}

function renderHints() {
	const panel = el("hints-panel");
	if (!hints.length) {
		panel.innerHTML = "";
		return;
	}
	panel.innerHTML = `
        <button id="hint-btn" class="bg-zinc-900/80 hover:bg-zinc-800 transition px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border border-zinc-700">
            <span class="material-symbols-outlined text-sm leading-none text-yellow-400">lightbulb</span>
            Hint (-${HINT_COST} pts)
        </button>
        <div id="hint-list" class="flex flex-col gap-1"></div>`;
	el("hint-btn").addEventListener("click", revealNextHint);
}

function revealNextHint() {
	if (hintsShown >= hints.length) return;
	hintsUsed++;
	const text = hints[hintsShown++];
	const item = document.createElement("div");
	item.className = "bg-yellow-900/60 border border-yellow-700/50 text-yellow-200 text-xs px-3 py-1.5 rounded-lg";
	item.innerHTML = `<span class="material-symbols-outlined text-xs align-middle" style="font-variation-settings:'FILL' 1">lightbulb</span> `;
	item.appendChild(document.createTextNode(text));
	el("hint-list").appendChild(item);
	if (hintsShown >= hints.length) {
		const btn = el("hint-btn");
		if (btn) {
			btn.disabled = true;
			btn.className += " opacity-40 cursor-not-allowed";
		}
	}
}

function setTimerColor(remaining) {
	const d = el("timer-display");
	d.classList.remove("text-green-400", "text-yellow-400", "text-orange-400", "text-red-400", "timer-urgent");
	const pct = remaining / ROUND_TIME;
	if (pct > 0.5) d.classList.add("text-green-400");
	else if (pct > 0.25) d.classList.add("text-yellow-400");
	else if (pct > 0.1) d.classList.add("text-orange-400");
	else d.classList.add("text-red-400");
	if (remaining <= 10) d.classList.add("timer-urgent");
}

function startTimer() {
	clearInterval(timerInterval);
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

async function submitGuess() {
	if (guessSubmitted) return;
	guessSubmitted = true;
	clearInterval(timerInterval);
	mapCanvas?.setPinEnabled(false);
	setGuessBtnDisabled(true);

	const timeTaken = Math.min(ROUND_TIME, (Date.now() - startTime) / 1000);
	const body = {
		guessed_x: pinWorld?.x ?? null,
		guessed_y: pinWorld?.y ?? null,
		time_taken: timeTaken,
		hints_used: hintsUsed,
	};

	try {
		const r = await fetch("/api/daily/score", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await r.json();
		if (r.ok) {
			if (pinWorld && data.correct_x !== undefined) {
				mapCanvas?.showResult(data.correct_x, data.correct_y, pinWorld.x, pinWorld.y);
			} else if (data.correct_x !== undefined) {
				mapCanvas?.showResult(data.correct_x, data.correct_y);
			}
			showResult(data);
		} else {
			showResultError(data.error || "Error submitting guess");
		}
	} catch {
		showResultError("Failed to submit");
	}
}

function showResult(data) {
	const score = data.score ?? 0;
	el("result-score-display").textContent = score.toLocaleString() + " pts";
	el("result-score-display").className =
		"text-3xl font-bold leading-none " +
		(score >= 4000
			? "text-green-400"
			: score >= 2500
				? "text-blue-400"
				: score >= 1000
					? "text-orange-400"
					: "text-red-400");
	el("result-distance-display").textContent =
		data.distance !== null ? `~${data.distance.toLocaleString()} units away` : "No guess submitted";
	el("result-location-label").textContent = data.location_id
		? "LOC-" + String(data.location_id).padStart(4, "0")
		: "";

	const bar = el("result-score-bar");
	setTimeout(() => {
		bar.style.width = Math.round((score / 5000) * 100) + "%";
	}, 50);

	if (data.current_streak > 0) {
		el("result-streak-display").innerHTML = `
            <div class="inline-flex items-center gap-1.5 bg-orange-900/40 border border-orange-700/40 px-3 py-1 rounded-full text-orange-300 text-xs">
                <span class="material-symbols-outlined text-sm leading-none text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>
                ${data.current_streak}-day streak
            </div>`;
	}

	el("result-screen").classList.add("shown");
}

function showResultError(msg) {
	el("result-score-display").textContent = msg;
	el("result-distance-display").textContent = "";
	el("result-screen").classList.add("shown");
}

init();
