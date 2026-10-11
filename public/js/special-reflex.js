/** Signal Reflex: a reaction-time mini-game. Runs entirely in the browser; the best average is kept on this device. */

const REFLEX_GOES = 5;
const REFLEX_BEST_KEY = "reflex_best_ms";

const signal = el("signal");
let state = "idle"; // idle | waiting | go | done
let times = [];
let clearedAt = 0;
let waitTimer = null;

function setState(next, status) {
	state = next;
	signal.dataset.state = next;
	el("reflex-status").textContent = status;
}

function showTimes() {
	el("reflex-times").innerHTML = times.map((ms) => `<span class="m-tag">${ms} ms</span>`).join("");
}

function showBest() {
	let best = null;
	try {
		best = Number(localStorage.getItem(REFLEX_BEST_KEY)) || null;
	} catch {}
	el("reflex-best").textContent = best ? `Your best average on this device: ${best} ms` : "";
}

function arm() {
	setState("waiting", times.length ? `Go ${times.length + 1} of ${REFLEX_GOES}: wait for green` : "Wait for green");
	waitTimer = setTimeout(
		() => {
			clearedAt = performance.now();
			setState("go", "Now!");
			Sounds.play("start");
		},
		1200 + Math.random() * 2800
	);
}

function finish() {
	const average = Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length);
	let best = null;
	try {
		best = Number(localStorage.getItem(REFLEX_BEST_KEY)) || null;
		if (!best || average < best) localStorage.setItem(REFLEX_BEST_KEY, String(average));
	} catch {}
	const record = !best || average < best;
	setState("done", `Average ${average} ms${record ? ", a new best" : ""}. Press to play again`);
	Sounds.play(record ? "win" : "good");
	if (record) celebrate();
	showBest();
}

function press() {
	if (state === "idle" || state === "done") {
		times = [];
		showTimes();
		return arm();
	}
	if (state === "waiting") {
		// Jumped the signal: that go starts over.
		clearTimeout(waitTimer);
		Sounds.play("poor");
		setState("idle", "Too early! Press to try that one again");
		state = "early";
		return;
	}
	if (state === "early") return arm();
	if (state === "go") {
		times.push(Math.round(performance.now() - clearedAt));
		showTimes();
		Sounds.play("pin");
		if (times.length >= REFLEX_GOES) return finish();
		arm();
	}
}

/** pointerdown rather than click: a click only fires on release, which would add to every time. */
signal.addEventListener("pointerdown", (e) => {
	e.preventDefault();
	press();
});
addKeybinds("Signal Reflex", [[["Space", "Enter"], "Start, or react to the signal", press]]);
showBest();
