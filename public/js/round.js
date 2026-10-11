/**
 * The round screen shared by solo, daily and duels: screenshot, timer, hints,
 * map pin and the guess button. The page tells it what round to show and what to
 * do with a guess; everything the player sees while guessing lives here.
 *
 * Expects these element ids on the page: round-photo, photo-panel, resize-handle,
 * timer-display, timer-val, map-canvas, click-hint, guess-btn, and optionally
 * hints-panel and location-id-badge.
 */

const GUESS_BTN_BASE =
	"pointer-events-auto pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm whitespace-nowrap transition flex items-center gap-2 ";
const GUESS_BTN_ON = "bg-blue-600 hover:bg-blue-500 active:scale-95 shadow-sm cursor-pointer";
const GUESS_BTN_OFF = "bg-zinc-700 text-zinc-500 cursor-not-allowed";
const TIMER_TONES = ["text-green-400", "text-yellow-400", "text-orange-400", "text-red-400", "text-zinc-400"];

class RoundView {
	/**
	 * @param {object} handlers
	 * @param {(pin: {x: number, y: number} | null) => void} handlers.onGuess
	 *   Called once per round, when the player submits or the timer runs out.
	 * @param {() => Promise<{hint: string}>} [handlers.onHint]
	 *   Fetches the next hint from the server. Hints are hidden without it.
	 */
	constructor({ onGuess, onHint }) {
		this.onGuess = onGuess;
		this.onHint = onHint || null;
		this.pin = null;
		this.locked = true;
		this.canGuess = true;
		this.timerId = null;
		this.deadline = null;
		this.timeLimit = 0;
		this.hintsTotal = 0;
		this.hintsShown = 0;
		this.hintCost = 0;

		this.map = new MapCanvas(el("map-canvas"), {
			onPinPlaced: (x, y) => {
				this.pin = { x, y };
				Sounds.play("pin");
				this._setGuessEnabled(true);
				el("click-hint").innerHTML =
					'Pin placed. Press <kbd class="kbd">Space</kbd> or <kbd class="kbd">Enter</kbd> to submit, or click to move it';
			},
		});
		this.map.setPinEnabled(false);

		el("guess-btn").addEventListener("click", () => this.submit());
		const duringRound = (fn) => () => (this._visible() ? fn() : false);
		const submitIfReady = duringRound(() => (!this.locked && this.pin ? this.submit() : false));
		addKeybinds("During a round", [
			[["Space", "Enter"], "Submit your guess", submitIfReady],
			[
				["H"],
				"Reveal a hint",
				duringRound(() => (el("hint-btn") && !el("hint-btn").disabled ? el("hint-btn").click() : false)),
			],
			[["+", "="], "Zoom the map in", duringRound(() => el("zoom-in")?.click())],
			[["-"], "Zoom the map out", duringRound(() => el("zoom-out")?.click())],
		]);
		setupPhotoLens(el("round-photo"));
		setupResizeHandle();
	}

	/**
	 * Puts a round on screen without starting it: the screenshot loads, the map is
	 * locked and the clock shows the full time. Resolves once the screenshot is
	 * visible (or has clearly failed), which is the moment to ask for the clock.
	 * `canGuess: false` is for spectators: same screen, no pin and no button.
	 */
	show(round, { canGuess = true } = {}) {
		this.stop();
		this.canGuess = canGuess;
		this.pin = null;
		this.map.clearPin();
		this.map.restoreView();
		this._setGuessEnabled(false);
		el("guess-btn").classList.toggle("hidden", !canGuess);
		el("click-hint").textContent = "Loading the screenshot…";
		const badge = el("location-id-badge");
		if (badge) badge.textContent = round.location_id ? locId(round.location_id) : "";

		this.hintCost = round.hint_cost || 0;
		this.hintsTotal = canGuess && this.onHint ? round.hints_total || 0 : 0;
		this.hintsShown = 0;
		this._renderHints(round.hints || []);
		const hintBtn = el("hint-btn");
		if (hintBtn) hintBtn.disabled = true;

		this.timeLimit = round.time_limit || 0;
		el("timer-display").classList.toggle("hidden", !this.timeLimit);
		el("timer-display").classList.remove(...TIMER_TONES, "timer-urgent");
		el("timer-display").classList.add("text-zinc-400");
		el("timer-val").textContent = this.timeLimit;

		this.loaded = this._loadPhoto(round.image_url);
		return this.loaded;
	}

	/** Starts the clock on the round already on screen and hands control to the player. */
	go(round) {
		this.locked = !this.canGuess;
		this.map.setPinEnabled(this.canGuess);
		el("click-hint").textContent = this.canGuess ? "Click the map to place your pin" : "Spectating";
		const hintBtn = el("hint-btn");
		if (hintBtn) hintBtn.disabled = this.hintsShown >= this.hintsTotal;
		this._startTimer(round.time_limit, round.time_remaining);
	}

	/** Shows a round that is already running, e.g. after a reload or when joining late. */
	start(round, options) {
		this.show(round, options);
		this.go(round);
	}

	_loadPhoto(url) {
		const photo = el("round-photo");
		const panel = el("photo-panel");
		if (photo.getAttribute("src") === url && photo.complete && photo.naturalWidth) return Promise.resolve();
		panel.classList.add("photo-loading");
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timeout);
				if (photo.getAttribute("src") === url) panel.classList.remove("photo-loading");
				resolve();
			};
			// A broken or very slow image must not hold the round up forever.
			const timeout = setTimeout(done, 8000);
			photo.onload = done;
			photo.onerror = done;
			photo.src = url;
		});
	}

	/** Submits the current pin (or no guess at all). Does nothing once the round is locked. */
	submit() {
		if (this.locked) return;
		this.lock();
		Sounds.play("submit");
		this.onGuess(this.pin);
	}

	/** Stops accepting input but leaves the clock alone (used while waiting on an opponent). */
	lock() {
		this.locked = true;
		this.map.setPinEnabled(false);
		this._setGuessEnabled(false);
		const hintBtn = el("hint-btn");
		if (hintBtn) hintBtn.disabled = true;
	}

	/** Freezes the clock where it is, e.g. while a duel waits for someone to reconnect. */
	pause() {
		clearInterval(this.timerId);
		this.timerId = null;
		el("timer-display").classList.remove("timer-urgent");
		this.map.setPinEnabled(false);
	}

	/** Restarts a paused clock with the time the server says is left, keeping the pin in place. */
	resume(remaining, { guessed = false } = {}) {
		if (guessed) this.lock();
		else if (this.canGuess) {
			this.locked = false;
			this.map.setPinEnabled(true);
			this._setGuessEnabled(!!this.pin);
		}
		this._startTimer(this.timeLimit, remaining);
	}

	/** Ends the round on screen: no more input and no more clock. */
	stop() {
		this.lock();
		clearInterval(this.timerId);
		this.timerId = null;
		el("timer-display").classList.remove("timer-urgent");
	}

	/** Drops the correct pin on the map, alongside the player's own if they placed one. */
	showAnswer(answer, guess = this.pin) {
		if (guess) this.map.showResult(answer.correct_x, answer.correct_y, guess.x, guess.y);
		else this.map.showResult(answer.correct_x, answer.correct_y);
	}

	/**
	 * Brings the answer and the guesses into the part of the map the result sheet leaves
	 * uncovered. Call it once the sheet has its content, so its height is known.
	 */
	fitResult(answer, guesses = [this.pin], sheet = el("result-screen")) {
		this.map.fitTo(
			[{ x: answer.correct_x, y: answer.correct_y }, ...guesses.filter(Boolean).map(({ x, y }) => ({ x, y }))],
			{ insetBottom: sheet?.offsetHeight || 0 }
		);
	}

	_visible() {
		return el("map-canvas").offsetParent !== null;
	}

	_setGuessEnabled(enabled) {
		const btn = el("guess-btn");
		btn.disabled = !enabled;
		btn.className = GUESS_BTN_BASE + (enabled ? GUESS_BTN_ON : GUESS_BTN_OFF) + (this.canGuess ? "" : " hidden");
	}

	_startTimer(limit, remaining) {
		const display = el("timer-display");
		this.timeLimit = limit || 0;
		display.classList.toggle("hidden", !this.timeLimit);
		if (!this.timeLimit) return;

		// Work from a deadline so a throttled background tab cannot stretch the round.
		clearInterval(this.timerId);
		this.timerId = null;
		this.deadline = Date.now() + (remaining ?? limit) * 1000;
		const tick = () => {
			const left = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
			el("timer-val").textContent = left;
			const pct = left / this.timeLimit;
			display.classList.remove(...TIMER_TONES, "timer-urgent");
			display.classList.add(TIMER_TONES[pct > 0.5 ? 0 : pct > 0.25 ? 1 : pct > 0.1 ? 2 : 3]);
			if (left <= 10 && !this.locked) display.classList.add("timer-urgent");
			// One tick per second through the last five.
			if (left <= 5 && left > 0 && left !== this._lastTick && !this.locked) Sounds.play("tick");
			this._lastTick = left;
			if (left <= 0) {
				clearInterval(this.timerId);
				this.timerId = null;
				this.submit();
			}
		};
		tick();
		if (this.timerId === null && Date.now() < this.deadline) this.timerId = setInterval(tick, 250);
	}

	_renderHints(revealed) {
		const panel = el("hints-panel");
		if (!panel) return;
		panel.innerHTML = "";
		if (!this.hintsTotal) return;

		const btn = document.createElement("button");
		btn.id = "hint-btn";
		btn.className =
			"bg-zinc-900/80 hover:bg-zinc-800 transition px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed";
		btn.innerHTML = `<span class="material-symbols-outlined text-sm leading-none text-yellow-400">lightbulb</span>
			<span>Hint <span class="text-zinc-400">(-${this.hintCost} pts)</span></span>`;
		btn.title = `Reveal a hint for ${this.hintCost} points`;
		btn.addEventListener("click", () => this._revealHint());
		const list = document.createElement("div");
		list.id = "hint-list";
		list.className = "flex flex-col gap-1";
		panel.append(btn, list);
		for (const hint of revealed) this._addHint(hint);
	}

	_addHint(text) {
		this.hintsShown++;
		const item = document.createElement("div");
		item.className = "bg-yellow-900/60 border border-yellow-700/50 text-yellow-200 text-xs px-3 py-1.5 rounded-lg";
		item.innerHTML = `<span class="material-symbols-outlined text-xs align-middle" style="font-variation-settings:'FILL' 1">lightbulb</span> `;
		item.appendChild(document.createTextNode(text));
		el("hint-list").appendChild(item);
		if (this.hintsShown >= this.hintsTotal) el("hint-btn").disabled = true;
	}

	async _revealHint() {
		const btn = el("hint-btn");
		if (this.locked || btn.disabled) return;
		btn.disabled = true;
		try {
			const { hint } = await this.onHint();
			Sounds.play("hint");
			this._addHint(hint);
		} catch (err) {
			showToast(err.message, "error");
		}
		if (!this.locked && this.hintsShown < this.hintsTotal) btn.disabled = false;
	}
}

/** Fills the result sheet's score, distance and bar. Used by solo and daily. */
function renderRoundResult(result, max = 5000) {
	const tone = scoreTone(result.score, max);
	Sounds.forScore(result.score, max);
	const score = el("result-score-display");
	countUp(score, result.score, { duration: 800, format: (n) => `${n.toLocaleString()} pts` });
	score.className = `text-3xl font-bold leading-none ${tone.text}`;

	const details = [
		result.distance !== null ? `~${result.distance.toLocaleString()} units away` : "No guess submitted",
	];
	if (result.hints_used) details.push(`${result.hints_used} hint${result.hints_used === 1 ? "" : "s"} used`);
	el("result-distance-display").textContent = details.join(" · ");

	const bar = el("result-score-bar");
	bar.style.width = "0%";
	bar.className = `score-bar h-2 rounded-full ${tone.bar}`;
	requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = `${(result.score / max) * 100}%`)));
}

/** "Hard location" and the like for a result line, or nothing while a location is still ungraded. */
function difficultyText(difficulty) {
	return difficulty ? `${difficulty[0].toUpperCase()}${difficulty.slice(1)} location` : "";
}

/* ---- Reactions: preset icons players can send each other (duels and team games) ---- */

const EMOTE_COOLDOWN_MS = 1500;
const EMOTE_SHOWN_MS = 3000;
/**
 * The key that sends each reaction while the picker is open, following the number row:
 * 1 to 9, 0 for the tenth, then - and + for the eleventh and twelfth.
 */
const EMOTE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "+"];
/** + is Shift and = on most keyboards; either one counts. */
const EMOTE_KEY_ALIASES = { "=": "+" };
let emoteList = [];

/**
 * Draws the reaction picker from the list the server offers. An empty list hides it, and
 * so does `canSend: false` (spectators), though the reactions themselves still show.
 * Expects #emote-bar and #emote-feed on the page.
 */
function renderEmoteBar(list, canSend = true) {
	const offered = Array.isArray(list) ? list.filter((name) => /^[a-z0-9_]+$/.test(name)) : [];
	const changed = offered.join() !== emoteList.join();
	emoteList = offered;
	show("emote-bar", emoteList.length > 0 && canSend);
	if (!changed) return;
	el("emote-bar").innerHTML =
		`<button data-emote-toggle class="emote-btn" title="Send a reaction" data-tip-key="E" aria-label="Send a reaction" aria-expanded="false">
			<span class="material-symbols-outlined">add_reaction</span>
		</button>
		<div data-emote-choices class="emote-picker" hidden>${emoteList
			.map(
				(name, i) =>
					`<button data-emote="${name}" class="emote-btn" title="${name.replaceAll("_", " ")}" ${EMOTE_KEYS[i] ? `data-tip-key="${EMOTE_KEYS[i]}"` : ""} aria-label="${name.replaceAll("_", " ")}"><span class="material-symbols-outlined">${name}</span></button>`
			)
			.join("")}</div>`;
}

/** Wires the picker up once per page. `send` is handed the name of the chosen reaction. */
function bindEmoteBar(send) {
	const bar = el("emote-bar");
	const choices = () => bar.querySelector("[data-emote-choices]");
	const setOpen = (open) => {
		if (!choices()) return;
		choices().hidden = !open;
		bar.querySelector("[data-emote-toggle]").setAttribute("aria-expanded", String(open));
	};
	bar.addEventListener("click", (e) => {
		if (e.target.closest("[data-emote-toggle]")) return setOpen(choices().hidden);
		const choice = e.target.closest("[data-emote]");
		if (!choice || choice.disabled) return;
		send(choice.dataset.emote);
		setOpen(false);
		// The server allows one every so often; show that instead of letting clicks vanish.
		const buttons = [...bar.querySelectorAll("[data-emote]")];
		for (const button of buttons) button.disabled = true;
		setTimeout(() => buttons.forEach((button) => (button.disabled = false)), EMOTE_COOLDOWN_MS);
	});
	// Clicking anywhere else puts the picker away.
	document.addEventListener("click", (e) => bar.contains(e.target) || setOpen(false));

	// E opens the picker and a number sends that reaction, so nobody has to leave the map for the mouse.
	const usable = () => !bar.classList.contains("hidden") && bar.offsetParent !== null;
	const sendNumbered = (e) => {
		if (!usable() || !choices() || choices().hidden) return false;
		const key = EMOTE_KEY_ALIASES[e.key] ?? e.key;
		const choice = choices().querySelectorAll("[data-emote]")[EMOTE_KEYS.indexOf(key)];
		return choice ? choice.click() : false;
	};
	addKeybinds("Reactions", [
		[["E"], "Open or close the reaction picker", () => (usable() ? setOpen(choices().hidden) : false)],
		// Listed as one row in the help; the digits themselves are bound just below.
		[["1-9", "0", "-", "+"], "Send that reaction (while the picker is open)", () => false],
	]);
	// Ahead of anything else on these keys (- and + zoom the map), and only while the picker is open.
	for (const key of [...EMOTE_KEYS, ...Object.keys(EMOTE_KEY_ALIASES)])
		_pageKeys.set(key, [sendNumbered, ...(_pageKeys.get(key) || []).filter((handler) => handler !== sendNumbered)]);
}

/** Pops one reaction up beside the screenshot for a moment, with its sound. */
function showEmoteBubble(emote, { name, avatarUrl, color }) {
	if (!emoteList.includes(emote)) return;
	Sounds.play(Sounds.has(`emote_${emote}`) ? `emote_${emote}` : "emote");
	const bubble = document.createElement("div");
	bubble.className = "emote-pop emote-bubble";
	bubble.setAttribute("role", "status");
	bubble.innerHTML = `${avatarHtml(avatarUrl, "w-9 h-9")}
		<span class="emote-bubble-name">${escHtml(name)}</span>
		<span class="material-symbols-outlined" style="color:${color}">${emote}</span>`;
	const feed = el("emote-feed");
	feed.appendChild(bubble);
	// Keep the stack short when players trade reactions quickly.
	while (feed.children.length > 4) feed.firstElementChild.remove();
	setTimeout(() => bubble.remove(), EMOTE_SHOWN_MS);
}

function reportLocationUrl(locationId) {
	return `/settings?ticket=report_location&loc=${locationId}`;
}

/** Makes a group of pill buttons act like a radio group. Returns a getter for the selected value. */
function setupPills(selector, onChange) {
	const pills = [...document.querySelectorAll(selector)];
	const ON = ["border-blue-500", "bg-blue-600/15", "text-blue-300"];
	const OFF = ["border-zinc-700", "text-zinc-400", "hover:border-zinc-500", "hover:text-zinc-200"];
	let value = null;
	const select = (pill) => {
		for (const p of pills) {
			p.classList.remove(...ON);
			p.classList.add(...OFF);
			p.setAttribute("aria-pressed", "false");
		}
		pill.classList.remove(...OFF);
		pill.classList.add(...ON);
		pill.setAttribute("aria-pressed", "true");
		value = Number(pill.dataset.val);
		onChange?.(value);
	};
	for (const pill of pills) pill.addEventListener("click", () => select(pill));
	select(pills.find((p) => p.hasAttribute("data-default")) || pills[0]);
	return () => value;
}

/** Lets the player drag the divider between the screenshot and the map. */
function setupResizeHandle() {
	const handle = el("resize-handle");
	const panel = el("photo-panel");
	if (!handle || !panel) return;
	const container = panel.parentElement;
	const isDesktop = () => window.innerWidth >= 768;
	let dragging = false;

	const start = (e) => {
		dragging = true;
		handle.classList.add("dragging");
		document.body.style.cursor = isDesktop() ? "col-resize" : "row-resize";
		document.body.style.userSelect = "none";
		e.preventDefault();
	};
	const move = (x, y) => {
		if (!dragging) return;
		const rect = container.getBoundingClientRect();
		if (isDesktop()) panel.style.width = `${Math.min(70, Math.max(20, ((x - rect.left) / rect.width) * 100))}%`;
		else panel.style.height = `${Math.min(65, Math.max(18, ((y - rect.top) / rect.height) * 100))}%`;
	};
	const end = () => {
		dragging = false;
		handle.classList.remove("dragging");
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	};

	handle.addEventListener("mousedown", start);
	document.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));
	document.addEventListener("mouseup", end);
	handle.addEventListener("touchstart", start, { passive: false });
	document.addEventListener(
		"touchmove",
		(e) => {
			if (!dragging) return;
			e.preventDefault();
			move(e.touches[0].clientX, e.touches[0].clientY);
		},
		{ passive: false }
	);
	document.addEventListener("touchend", end);
}

/** A magnifying lens that follows the mouse over the screenshot; scroll to resize it. */
function setupPhotoLens(img) {
	if (!img) return;
	const lens = document.createElement("div");
	lens.style.cssText =
		"position:absolute;width:200px;height:200px;border-radius:50%;border:2px solid rgba(255,255,255,0.35);box-shadow:0 4px 24px rgba(0,0,0,0.6);pointer-events:none;display:none;background-repeat:no-repeat;z-index:20;transform:translate(-50%,-50%);";
	img.parentElement.appendChild(lens);

	let size = 200;
	let zoom = 3;
	let last = null;

	const hide = () => {
		last = null;
		lens.style.display = "none";
	};
	const update = (clientX, clientY) => {
		const rect = img.getBoundingClientRect();
		const naturalW = img.naturalWidth || rect.width;
		const naturalH = img.naturalHeight || rect.height;
		const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
		const w = naturalW * scale;
		const h = naturalH * scale;
		const left = (rect.width - w) / 2;
		const top = (rect.height - h) / 2;
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		// The image is letterboxed inside its box; only magnify the picture itself.
		if (!img.naturalWidth || x < left || x > left + w || y < top || y > top + h) return hide();

		last = { clientX, clientY };
		lens.style.width = lens.style.height = `${size}px`;
		lens.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
		lens.style.backgroundSize = `${w * zoom}px ${h * zoom}px`;
		lens.style.backgroundPosition = `-${((x - left) / w) * w * zoom - size / 2}px -${((y - top) / h) * h * zoom - size / 2}px`;
		lens.style.left = `${x}px`;
		lens.style.top = `${y}px`;
		lens.style.display = "block";
	};

	img.addEventListener("mousemove", (e) => update(e.clientX, e.clientY));
	img.addEventListener("mouseleave", hide);
	img.addEventListener(
		"wheel",
		(e) => {
			if (!last) return;
			e.preventDefault();
			const step = e.deltaY < 0 ? 1.1 : 1 / 1.1;
			size = Math.min(360, Math.max(80, size * step));
			zoom = Math.min(8, Math.max(1.5, zoom * step));
			update(last.clientX, last.clientY);
		},
		{ passive: false }
	);
}
