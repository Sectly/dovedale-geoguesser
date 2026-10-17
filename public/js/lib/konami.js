import { Sounds } from "../sounds.js";

/** Up, up, down, down, left, right, left, right, B, A: the page's colours flip for a few seconds. */

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
const FLIPPED_MS = 5000;

let at = 0;
let timer = null;

document.addEventListener("keydown", (e) => {
	if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "")) return;
	const key = e.key.toLowerCase();
	at = key === CODE[at] ? at + 1 : key === CODE[0] ? 1 : 0;
	if (at < CODE.length) return;
	at = 0;
	Sounds.play("great");
	document.documentElement.classList.add("konami");
	clearTimeout(timer);
	timer = setTimeout(() => document.documentElement.classList.remove("konami"), FLIPPED_MS);
});
