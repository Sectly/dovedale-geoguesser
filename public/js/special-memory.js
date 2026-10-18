import "./lib/site.js";
import { Sounds } from "./sounds.js";
import { el, escHtml } from "./lib/dom.js";
import { api } from "./lib/api.js";
import { celebrate } from "./lib/effects.js";

const MEMORY_PAIRS = 8;
const MEMORY_BEST_KEY = "memory_best_turns";

let memoryCards = [];
let faceUp = [];
let turns = 0;
let matched = 0;
/** True while a wrong pair is on show, so a third card cannot be turned. */
let busy = false;

function shuffled(items) {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function showBestGame() {
	let best = null;
	try {
		best = Number(localStorage.getItem(MEMORY_BEST_KEY)) || null;
	} catch {}
	el("memory-best").textContent = best ? `Best on this device: ${best} turns` : "";
	return best;
}

async function newMemoryGame() {
	const grid = el("memory-grid");
	grid.innerHTML = Array.from(
		{ length: MEMORY_PAIRS * 2 },
		() => '<div class="skeleton" style="aspect-ratio: 4 / 3; border-radius: 0.875rem"></div>'
	).join("");
	el("memory-status").textContent = "";
	[faceUp, turns, matched, busy] = [[], 0, 0, false];
	el("memory-turns").textContent = "0";

	let images;
	try {
		images = (await api(`/api/specials/memory/cards?pairs=${MEMORY_PAIRS}`)).images;
	} catch (err) {
		grid.innerHTML = "";
		el("memory-status").textContent = err.message;
		return;
	}
	if (images.length < 2) {
		grid.innerHTML = "";
		el("memory-status").textContent = "There aren't enough locations in the game yet.";
		return;
	}
	memoryCards = shuffled(
		images.flatMap((image, pair) => [
			{ image, pair },
			{ image, pair },
		])
	);
	grid.innerHTML = memoryCards
		.map(
			(
				card,
				index
			) => `<button class="memory-card" data-index="${index}" data-state="down" aria-label="Card ${index + 1}, face down">
				<img src="${escHtml(card.image)}" alt="" decoding="async" draggable="false" />
				<span class="material-symbols-outlined">train</span>
			</button>`
		)
		.join("");
}

function setCard(index, state) {
	const node = el("memory-grid").children[index];
	node.dataset.state = state;
	node.setAttribute(
		"aria-label",
		`Card ${index + 1}, ${state === "down" ? "face down" : state === "matched" ? "matched" : "face up"}`
	);
}

function turnCard(index) {
	const node = el("memory-grid").children[index];
	if (busy || !node || node.dataset.state !== "down") return;
	setCard(index, "up");
	faceUp.push(index);
	Sounds.play("pin");
	if (faceUp.length < 2) return;

	turns++;
	el("memory-turns").textContent = turns;
	const [first, second] = faceUp;
	faceUp = [];
	if (memoryCards[first].pair === memoryCards[second].pair) {
		setCard(first, "matched");
		setCard(second, "matched");
		Sounds.play("good");
		if (++matched === memoryCards.length / 2) finishMemoryGame();
		return;
	}
	busy = true;
	setTimeout(() => {
		setCard(first, "down");
		setCard(second, "down");
		busy = false;
	}, 900);
}

function finishMemoryGame() {
	const best = showBestGame();
	const record = !best || turns < best;
	if (record) {
		try {
			localStorage.setItem(MEMORY_BEST_KEY, String(turns));
		} catch {}
	}
	el("memory-status").textContent = `Done in ${turns} turns${record ? ", a new best" : ""}`;
	showBestGame();
	Sounds.play(record ? "win" : "great");
	if (record) celebrate();
}

el("memory-grid").addEventListener("click", (e) => {
	const card = e.target.closest(".memory-card");
	if (card) turnCard(Number(card.dataset.index));
});
el("memory-new").addEventListener("click", newMemoryGame);
showBestGame();
newMemoryGame();
