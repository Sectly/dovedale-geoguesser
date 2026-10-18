import { el } from "./lib/dom.js";

/** Screenshot effects for seasonal specials. Never on the leaderboards. */
export const PhotoEffects = (() => {
	/** How much of the snow may be wiped away, as a share of the picture. */
	const SNOW_BUDGET = 0.3;
	const SNOW_BRUSH = 34;
	const TORCH_RADIUS = 120;

	let cleanup = null;
	let begin = null;

	function overlay(tag) {
		const node = document.createElement(tag);
		node.className = "photo-effect";
		el("photo-panel").appendChild(node);
		return node;
	}

	function track(move) {
		const panel = el("photo-panel");
		const onMove = (e) => {
			const rect = panel.getBoundingClientRect();
			move(e.clientX - rect.left, e.clientY - rect.top, rect);
		};
		panel.addEventListener("pointermove", onMove);
		panel.addEventListener("pointerdown", onMove);
		return () => {
			panel.removeEventListener("pointermove", onMove);
			panel.removeEventListener("pointerdown", onMove);
		};
	}

	/** Night Shift: everything is dark except a circle of light around the pointer. */
	function torch() {
		const dark = overlay("div");
		const light = (x, y) =>
			(dark.style.background = `radial-gradient(circle ${TORCH_RADIUS}px at ${x}px ${y}px, transparent 0, transparent 55%, rgba(0, 0, 0, 0.985) 100%)`);
		const rect = el("photo-panel").getBoundingClientRect();
		light(rect.width / 2, rect.height / 2);
		const untrack = track(light);
		return () => {
			untrack();
			dark.remove();
		};
	}

	/** Snowed In: the picture is under snow that the pointer wipes off, until the allowance runs out. */
	function snow() {
		const canvas = overlay("canvas");
		const rect = el("photo-panel").getBoundingClientRect();
		canvas.width = Math.max(1, Math.round(rect.width));
		canvas.height = Math.max(1, Math.round(rect.height));
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#e8eef5";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		for (let i = 0; i < 260; i++) {
			ctx.fillStyle = i % 2 ? "rgba(255, 255, 255, 0.9)" : "rgba(190, 205, 222, 0.55)";
			ctx.beginPath();
			ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height, 2 + Math.random() * 9, 0, Math.PI * 2);
			ctx.fill();
		}

		const meter = overlay("div");
		meter.className = "photo-effect-meter";
		const budget = canvas.width * canvas.height * SNOW_BUDGET;
		let used = 0;
		let last = null;
		const showMeter = () => {
			const left = Math.max(0, Math.round((1 - used / budget) * 100));
			meter.textContent = left ? `Snow you can still clear: ${left}%` : "That's all the snow you can clear";
		};
		showMeter();

		ctx.globalCompositeOperation = "destination-out";
		ctx.lineCap = "round";
		ctx.lineWidth = SNOW_BRUSH * 2;
		const untrack = track((x, y, box) => {
			const point = { x: (x / box.width) * canvas.width, y: (y / box.height) * canvas.height };
			if (used >= budget) return;
			const from = last ?? point;
			ctx.beginPath();
			ctx.moveTo(from.x, from.y);
			ctx.lineTo(point.x + 0.01, point.y);
			ctx.stroke();
			used += last ? Math.hypot(point.x - from.x, point.y - from.y) * SNOW_BRUSH * 2 : Math.PI * SNOW_BRUSH ** 2;
			last = point;
			showMeter();
		});
		const lift = () => (last = null);
		el("photo-panel").addEventListener("pointerleave", lift);
		return () => {
			untrack();
			el("photo-panel").removeEventListener("pointerleave", lift);
			canvas.remove();
			meter.remove();
		};
	}

	/** Flash: the picture is covered, shown for a moment once the round starts, then covered for good. */
	function flash(seconds = 2) {
		const cover = overlay("div");
		cover.classList.add("photo-effect-cover");
		cover.textContent = "Get ready";
		let timer = null;
		return {
			begin() {
				cover.classList.add("lifted");
				timer = setTimeout(() => {
					cover.textContent = "Where was that?";
					cover.classList.remove("lifted");
				}, seconds * 1000);
			},
			cleanup() {
				clearTimeout(timer);
				cover.remove();
			},
		};
	}

	const EFFECTS = { torch, snow, flash };
	/** Effects worked with the pointer, where the magnifier would cover what is being uncovered. */
	const NO_LENS = ["torch", "snow"];

	return {
		apply(name, option) {
			this.clear();
			if (!EFFECTS[name]) return;
			el("photo-panel").classList.toggle("no-lens", NO_LENS.includes(name));
			const effect = EFFECTS[name](option);
			cleanup = typeof effect === "function" ? effect : effect.cleanup;
			begin = effect.begin ?? null;
		},
		begin() {
			begin?.();
		},
		clear() {
			cleanup?.();
			el("photo-panel")?.classList.remove("no-lens");
			cleanup = null;
			begin = null;
		},
	};
})();
