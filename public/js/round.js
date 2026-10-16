/**
 * The round screen shared by solo, daily and duels: screenshot, timer, hints, map pin and guess button.
 * Needs these ids: round-photo, photo-panel, resize-handle, timer-display, timer-val, map-canvas, click-hint, guess-
 * btn.
 * Optional: hints-panel, location-id-badge.
 */

import { MapCanvas } from "./map-canvas.js";
import { Sounds } from "./sounds.js";
import { avatarHtml, countUp, el, escHtml, locId, scoreTone, show } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { showToast } from "./lib/toast.js";
import { _pageKeys, addKeybinds } from "./lib/keys.js";
import { setupPhotoLens } from "./lib/effects.js";

const GUESS_BTN_BASE =
	"pointer-events-auto pl-4 pr-5 py-2.5 rounded-full font-semibold text-sm whitespace-nowrap transition flex items-center gap-2 ";
const GUESS_BTN_ON = "bg-blue-600 hover:bg-blue-500 active:scale-95 shadow-sm cursor-pointer";
const GUESS_BTN_OFF = "bg-zinc-700 text-zinc-500 cursor-not-allowed";
/** How many times a failed screenshot is asked for again before the player is told. */
const PHOTO_RETRIES = 2;
const TOUCH = matchMedia("(pointer: coarse)").matches;
const TIMER_TONES = ["text-green-400", "text-yellow-400", "text-orange-400", "text-red-400", "text-zinc-400"];

export class RoundView {
	/**
	 * @param {object} handlers
	 * @param {(pin: {x: number, y: number} | null) => void} handlers.onGuess
	 *   Called once per round, when the player submits or the timer runs out.
	 * @param {() => Promise<{hint: string}>} [handlers.onHint]
	 *   Fetches the next hint from the server. Hints are hidden without it.
	 * @param {(x: number, y: number) => void} [handlers.onPinMoved]
	 *   Each time the pin is placed or moved.
	 */
	constructor({ onGuess, onHint, onPinMoved }) {
		this.onGuess = onGuess;
		this.onPinMoved = onPinMoved || null;
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
				this.onPinMoved?.(x, y);
				Sounds.play("pin");
				this._setGuessEnabled(true);
				el("click-hint").innerHTML = TOUCH
					? "Pin placed. Tap the map to move it"
					: 'Pin placed. Press <kbd class="kbd">Space</kbd> or <kbd class="kbd">Enter</kbd> to submit, or click to move it';
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
			[["+", "="], "Zoom the map in", duringRound(() => this.map.zoomBy(1.3))],
			[["-"], "Zoom the map out", duringRound(() => this.map.zoomBy(1 / 1.3))],
		]);
		setupPhotoLens(el("round-photo"));
		setupResizeHandle();
	}

	/** Shows a round without starting it. Resolves once the screenshot is visible. `canGuess: false` is for spectators. */
	show(round, { canGuess = true } = {}) {
		this.stop();
		this.canGuess = canGuess;
		this.pin = null;
		this.map.clearPin();
		this.map.restoreView();
		this._setGuessEnabled(false);
		el("guess-btn").classList.toggle("hidden", !canGuess);
		el("click-hint").textContent = "Loading the screenshot...";
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

	go(round) {
		this.locked = !this.canGuess;
		this.map.setPinEnabled(this.canGuess);
		el("click-hint").textContent = this.canGuess
			? `${TOUCH ? "Tap" : "Click"} the map to place your pin`
			: "Spectating";
		const hintBtn = el("hint-btn");
		if (hintBtn) hintBtn.disabled = this.hintsShown >= this.hintsTotal;
		this._startTimer(round.time_limit, round.time_remaining);
	}

	start(round, options) {
		this.show(round, options);
		this.go(round);
	}

	/** Resolves once the screenshot shows or has failed for good. The round carries on either way. */
	_loadPhoto(url) {
		const photo = el("round-photo");
		const panel = el("photo-panel");
		/** A duel shows a round and then starts it; both calls share one load. */
		if (this._photo?.url === url) return this._photo.shown;
		const load = (this._photo = { url, shown: null });
		const current = () => this._photo === load;
		this._setPhotoError(null);
		panel.classList.add("photo-loading");

		load.shown = new Promise((resolve) => {
			const settle = () => {
				clearTimeout(timeout);
				if (current()) panel.classList.remove("photo-loading");
				resolve();
			};
			/** A slow image must not hold the round up. */
			const timeout = setTimeout(settle, 8000);
			const attempt = (tries) => {
				const failed = () => {
					if (!current()) return;
					if (tries < PHOTO_RETRIES)
						return setTimeout(() => current() && attempt(tries + 1), 700 * (tries + 1));
					settle();
					this._setPhotoError(() => {
						this._setPhotoError(null);
						panel.classList.add("photo-loading");
						attempt(0);
					});
				};
				photo.onload = () => {
					if (!current()) return;
					/** Loaded but with nothing in it: a file the browser could not draw. */
					if (!photo.naturalWidth) return failed();
					this._setPhotoError(null);
					settle();
				};
				photo.onerror = failed;
				/** A changed address makes the browser ask again, where repeating the same one may not. */
				photo.src = tries ? `${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}` : url;
			};
			attempt(0);
		});
		return load.shown;
	}

	_setPhotoError(onRetry) {
		const panel = el("photo-panel");
		panel.classList.toggle("photo-failed", !!onRetry);
		document.getElementById("photo-error")?.remove();
		if (!onRetry) return;
		const box = document.createElement("div");
		box.id = "photo-error";
		box.setAttribute("role", "alert");
		box.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">broken_image</span>
			<div class="font-semibold">The screenshot didn't load</div>
			<p class="text-zinc-400 text-sm">${this.timeLimit ? "The clock is still running." : "The round is still open."}</p>
			<button class="m-btn m-btn-tonal"><span class="material-symbols-outlined">refresh</span>Try again</button>`;
		box.querySelector("button").addEventListener("click", onRetry);
		panel.appendChild(box);
	}

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

	stop() {
		this.lock();
		clearInterval(this.timerId);
		this.timerId = null;
		el("timer-display").classList.remove("timer-urgent");
	}

	showAnswer(answer, guess = this.pin) {
		if (guess) this.map.showResult(answer.correct_x, answer.correct_y, guess.x, guess.y);
		else this.map.showResult(answer.correct_x, answer.correct_y);
	}

	/** Fits the answer and guesses above the result sheet. Call once the sheet has its content. */
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

		/** Work from a deadline so a throttled background tab cannot stretch the round. */
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

export function renderRoundResult(result, max = 5000) {
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

export function difficultyText(difficulty) {
	return difficulty ? `${difficulty[0].toUpperCase()}${difficulty.slice(1)} location` : "";
}

/* ---- Reactions: preset icons players can send each other (duels and team games) ---- */

const EMOTE_COOLDOWN_MS = 1500;
const EMOTE_SHOWN_MS = 3000;
const EMOTE_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "+"];
/** + is Shift and = on most keyboards; either one counts. */
const EMOTE_KEY_ALIASES = { "=": "+" };
let emoteList = [];

export function renderEmoteBar(list, canSend = true) {
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

export function bindEmoteBar(send) {
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
		/** The server allows one every so often; show that instead of letting clicks vanish. */
		const buttons = [...bar.querySelectorAll("[data-emote]")];
		for (const button of buttons) button.disabled = true;
		setTimeout(() => buttons.forEach((button) => (button.disabled = false)), EMOTE_COOLDOWN_MS);
	});
	document.addEventListener("click", (e) => bar.contains(e.target) || setOpen(false));

	/** E opens the picker and a number sends that reaction, so nobody has to leave the map for the mouse. */
	const usable = () => !bar.classList.contains("hidden") && bar.offsetParent !== null;
	const sendNumbered = (e) => {
		if (!usable() || !choices() || choices().hidden) return false;
		const key = EMOTE_KEY_ALIASES[e.key] ?? e.key;
		const choice = choices().querySelectorAll("[data-emote]")[EMOTE_KEYS.indexOf(key)];
		return choice ? choice.click() : false;
	};
	addKeybinds("Reactions", [
		[["E"], "Open or close the reaction picker", () => (usable() ? setOpen(choices().hidden) : false)],
		/** Listed as one row in the help; the digits themselves are bound just below. */
		[["1-9", "0", "-", "+"], "Send that reaction (while the picker is open)", () => false],
	]);
	/** Ahead of anything else on these keys (- and + zoom the map), and only while the picker is open. */
	for (const key of [...EMOTE_KEYS, ...Object.keys(EMOTE_KEY_ALIASES)])
		_pageKeys.set(key, [sendNumbered, ...(_pageKeys.get(key) || []).filter((handler) => handler !== sendNumbered)]);
}

export function showEmoteBubble(emote, { name, avatarUrl, color }) {
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
	while (feed.children.length > 4) feed.firstElementChild.remove();
	setTimeout(() => bubble.remove(), EMOTE_SHOWN_MS);
}

export function reportLocationUrl(locationId) {
	return `/settings?ticket=report_location&loc=${locationId}`;
}

const REPORT_REASONS = [
	"The pin is in the wrong place",
	"The screenshot is unclear or broken",
	"Player names or the interface are showing",
	"It is a copy of another location",
	"Something else",
];

/** Reports a location as a ticket without leaving the game. Logged-out players follow the link instead. */
export async function reportLocation(event, locationId) {
	event.preventDefault();
	const link = event.currentTarget;
	if (!(await fetchUser())) return (location.href = link.href);
	if (el("report-dialog")) return;

	const code = locId(locationId);
	const box = document.createElement("div");
	box.id = "report-dialog";
	box.className = "fixed inset-0 z-[70] flex items-center justify-center bg-black/70 modal-fade px-4";
	box.innerHTML = `<div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 max-w-sm w-full" role="dialog" aria-modal="true" aria-label="Report this location">
		<h2 class="font-bold mb-1">Report ${code}</h2>
		<p class="text-zinc-500 text-xs mb-3">What is wrong with it?</p>
		<div class="flex flex-col gap-1.5 mb-3">
			${REPORT_REASONS.map((reason, i) => `<label class="flex items-center gap-2 text-sm cursor-pointer"><input type="radio" name="report-reason" value="${i}" class="accent-blue-500" />${reason}</label>`).join("")}
		</div>
		<textarea id="report-note" rows="2" maxlength="500" placeholder="Anything to add? (optional)" class="m-field mb-3"></textarea>
		<div class="flex gap-2 justify-end">
			<button id="report-cancel" class="m-btn m-btn-text">Cancel</button>
			<button id="report-send" class="m-btn m-btn-filled" disabled>Send report</button>
		</div>
	</div>`;
	const close = () => box.remove();
	/** Keys pressed in the dialog must not also submit a guess or start the next round. */
	box.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.key === "Escape") close();
	});
	box.addEventListener("click", (e) => e.target === box && close());
	box.addEventListener("change", () => (box.querySelector("#report-send").disabled = false));
	box.querySelector("#report-cancel").addEventListener("click", close);
	box.querySelector("#report-send").addEventListener("click", async (e) => {
		const reason = REPORT_REASONS[Number(box.querySelector("input:checked")?.value)];
		if (!reason) return;
		e.currentTarget.disabled = true;
		const note = box.querySelector("#report-note").value.trim();
		try {
			await api("/api/support", {
				json: {
					category: "report_location",
					subject: `${code}: ${reason}`,
					message: `Location ID: ${code}\nProblem: ${reason}\n\n---\n\n${note || "Reported from the result screen."}`,
				},
			});
			close();
			showToast("Report sent. Thank you.", "success");
		} catch (err) {
			e.currentTarget.disabled = false;
			showToast(err.message || "Couldn't send the report.", "error");
		}
	});
	document.body.appendChild(box);
	box.querySelector("input").focus();
}

/** Makes a group of pill buttons act like a radio group. Returns a getter for the selected value. */
export function setupPills(selector, onChange) {
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

function setupResizeHandle() {
	const handle = el("resize-handle");
	const panel = el("photo-panel");
	if (!handle || !panel) return;
	const container = panel.parentElement;
	/** Matches the stylesheet's side-by-side layout: wide screens and short landscape ones. */
	const isDesktop = () => matchMedia("(min-width: 768px), (orientation: landscape) and (max-height: 500px)").matches;
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

/** Called from inline handlers in the markup. */
Object.assign(window, { reportLocation });
