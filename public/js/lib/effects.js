import { prefersReducedMotion } from "./dom.js";

export function celebrate({ duration = 2600, count = 110 } = {}) {
	if (prefersReducedMotion()) return;
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:150";
	document.body.appendChild(canvas);
	/** Capped: at a phone's 3x a full-screen canvas is nine times the pixels to fill every frame. */
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = innerWidth * dpr;
	canvas.height = innerHeight * dpr;
	const ctx = canvas.getContext("2d");
	ctx.scale(dpr, dpr);
	const colors = ["#42A5F5", "#66BB6A", "#FFCA28", "#EF5350", "#AB47BC", "#fff"];
	const pieces = Array.from({ length: count }, (_, i) => ({
		x: i % 2 ? innerWidth * 0.12 : innerWidth * 0.88,
		y: innerHeight * 0.75,
		vx: (i % 2 ? 1 : -1) * (2 + Math.random() * 7),
		vy: -(9 + Math.random() * 9),
		size: 5 + Math.random() * 5,
		spin: Math.random() * Math.PI,
		spinSpeed: (Math.random() - 0.5) * 0.4,
		color: colors[i % colors.length],
	}));
	const start = performance.now();
	const frame = (now) => {
		const age = now - start;
		ctx.clearRect(0, 0, innerWidth, innerHeight);
		ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - duration * 0.6) / (duration * 0.4));
		for (const p of pieces) {
			p.vy += 0.32;
			p.vx *= 0.99;
			p.x += p.vx;
			p.y += p.vy;
			p.spin += p.spinSpeed;
			ctx.save();
			ctx.translate(p.x, p.y);
			ctx.rotate(p.spin);
			ctx.fillStyle = p.color;
			ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
			ctx.restore();
		}
		if (age < duration) requestAnimationFrame(frame);
		else canvas.remove();
	};
	requestAnimationFrame(frame);
}

/** A ripple from where a button was pressed, in its own layer so it survives the button being rewritten. */
document.addEventListener("pointerdown", (e) => {
	if (e.button > 0 || prefersReducedMotion()) return;
	/** Buttons, plus links that are styled as buttons (pills, round icon links, cards). */
	const target = e.target.closest?.('button:not(:disabled), a.md-card, a[class*="rounded"]');
	if (!target) return;
	const rect = target.getBoundingClientRect();
	if (!rect.width || !rect.height) return;

	const layer = document.createElement("span");
	layer.className = "ripple-layer";
	layer.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border-radius:${getComputedStyle(target).borderRadius}`;
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
	const ripple = document.createElement("span");
	ripple.className = "ripple";
	ripple.style.cssText = `width:${radius * 2}px;height:${radius * 2}px;left:${x - radius}px;top:${y - radius}px`;
	layer.appendChild(ripple);
	document.body.appendChild(layer);
	const follow = () => {
		if (!layer.isConnected) return;
		const now = target.getBoundingClientRect();
		layer.style.left = `${now.left}px`;
		layer.style.top = `${now.top}px`;
		requestAnimationFrame(follow);
	};
	requestAnimationFrame(follow);
	ripple.addEventListener("animationend", () => layer.remove());
	/** A safety net in case the animation never runs (e.g. the tab is hidden). */
	setTimeout(() => layer.remove(), 1000);
});

export function setupPhotoLens(img) {
	if (!img) return;
	const lens = document.createElement("div");
	lens.className = "photo-lens";
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
		/** The image is letterboxed inside its box; only magnify the picture itself. */
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
