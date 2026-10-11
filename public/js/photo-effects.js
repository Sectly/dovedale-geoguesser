/**
 * Screenshot effects for seasonal specials. Each one covers the photo panel with an
 * overlay that the pointer cuts through, so the player has to explore the picture.
 * They are only for fun: scores from these modes never reach the leaderboards.
 */
const PhotoEffects = (() => {
	/** How much of the snow may be wiped away, as a share of the picture. */
	const SNOW_BUDGET = 0.3;
	const SNOW_BRUSH = 34;
	const TORCH_RADIUS = 120;

	let cleanup = null;

	function overlay(tag) {
		const node = document.createElement(tag);
		node.className = "photo-effect";
		el("photo-panel").appendChild(node);
		return node;
	}

	/** Calls `move(x, y)` in panel coordinates as the mouse or a finger moves over the photo. */
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
		// A little texture, so it reads as snow and not as a blank panel.
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
			// The canvas keeps its first size, so scale the pointer if the panel has been resized.
			const point = { x: (x / box.width) * canvas.width, y: (y / box.height) * canvas.height };
			if (used >= budget) return;
			const from = last ?? point;
			ctx.beginPath();
			ctx.moveTo(from.x, from.y);
			ctx.lineTo(point.x + 0.01, point.y);
			ctx.stroke();
			// Roughly the fresh area swept: a full brush for the first touch, a strip after that.
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

	const EFFECTS = { torch, snow };

	return {
		/** Starts an effect for a new round, replacing any that is still up. Unknown names do nothing. */
		apply(name) {
			this.clear();
			if (EFFECTS[name]) cleanup = EFFECTS[name]();
		},
		/** Takes the effect off so the whole picture shows. */
		clear() {
			cleanup?.();
			cleanup = null;
		},
	};
})();
