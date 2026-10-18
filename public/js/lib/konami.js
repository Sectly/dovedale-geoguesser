import { Sounds } from "../sounds.js";
import { celebrate } from "./effects.js";
import { showToast } from "./toast.js";

/** Up, up, down, down, left, right, left, right, B, A (or swipes, then two taps): colours flip, icons spin, confetti. */

const CODE = [
	"arrowup",
	"arrowup",
	"arrowdown",
	"arrowdown",
	"arrowleft",
	"arrowright",
	"arrowleft",
	"arrowright",
	"b",
	"a",
];
const FLIPPED_MS = 6000;
/** Said in turn each time the code is entered on this page. */
const LINES = ["Konami code", "Again?", "Still going", "You know the code"];
/** Shorter than this is a tap, not a swipe, in CSS pixels. */
const SWIPE_PX = 40;

let at = 0;
let times = 0;
let timer = null;

function step(key) {
	at = key === CODE[at] ? at + 1 : key === CODE[0] ? 1 : 0;
	if (at < CODE.length) return;
	at = 0;
	activate();
}

function activate() {
	const root = document.documentElement;
	Sounds.play("win");
	showToast(LINES[Math.min(times++, LINES.length - 1)], "success");
	celebrate({ count: 90, duration: 2200 });
	root.classList.remove("konami-spin");
	void root.offsetWidth;
	root.classList.add("konami", "konami-spin");
	clearTimeout(timer);
	timer = setTimeout(() => root.classList.remove("konami", "konami-spin"), FLIPPED_MS);
}

document.addEventListener("keydown", (e) => {
	if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) return;
	step(e.key.toLowerCase());
});

let touchStart = null;
document.addEventListener(
	"touchstart",
	(e) => {
		touchStart = e.touches.length === 1 && !e.target.closest?.("canvas") ? e.touches[0] : null;
	},
	{ passive: true }
);
document.addEventListener(
	"touchend",
	(e) => {
		const start = touchStart;
		touchStart = null;
		const end = e.changedTouches[0];
		if (!start || !end) return;
		const dx = end.clientX - start.clientX;
		const dy = end.clientY - start.clientY;
		if (Math.hypot(dx, dy) < SWIPE_PX)
			return step(at === CODE.length - 2 ? "b" : at === CODE.length - 1 ? "a" : "");
		step(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "arrowright" : "arrowleft") : dy > 0 ? "arrowdown" : "arrowup");
	},
	{ passive: true }
);
