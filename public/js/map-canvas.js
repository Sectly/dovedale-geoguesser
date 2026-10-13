/** Each quality's width as a share of the full-size map (see src/tile-images.ts), smallest first. */
const MAP_QUALITY_SCALE = { tiny: 0.25, low: 0.45, medium: 0.75, high: 1 };
const MAP_QUALITIES = Object.keys(MAP_QUALITY_SCALE);

/** How much map a device gets. The full map decodes to nearly 1 GB, which crashes phones and Safari, so those get a small `base` map plus sharper `detail` tiles for what is on screen. */
function _mapProfile() {
	const ua = navigator.userAgent;
	/** An iPad asks for the desktop site and calls itself a Mac; only its touch screen gives it away. */
	const isMobile =
		/Mobi|Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
	const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg/i.test(ua);
	if (isMobile) return { base: "tiny", detail: "medium", maxDetailTiles: 3, maxPixelRatio: 2 };
	if (isSafari) return { base: "low", detail: "medium", maxDetailTiles: 4, maxPixelRatio: 2 };
	return { base: null, detail: null, maxDetailTiles: 0, maxPixelRatio: 3 };
}

class MapCanvas {
	constructor(canvas, { onPinPlaced } = {}) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d");
		this.onPinPlaced = onPinPlaced || null;
		this.viewWidth = 0;
		this.viewHeight = 0;
		this.currentScale = 1;
		this.isDragging = false;
		this.dragStart = null;
		this.mapImages = [];
		this.mapLoadId = 0;
		this.mapInitialized = false;
		this.pin = null;
		this.pinEnabled = true;
		this.correctPin = null;
		this.replayPins = [];
		this.replayDots = [];
		this._deferredPins = [];
		this.namePins = new Map();
		/** Lines drawn from a guess to the answer. */
		this.guessLines = [];
		/** Rings that mark a pin landing. */
		this.ripples = [];
		this.profile = _mapProfile();
		/** Sharper tiles for the part of the map on screen, by "quality:row:column". Only used with a `base`. */
		this.detailImages = new Map();
		this._detailTimer = null;
		this.quality = this.profile.base || "high";
		/** Blocked storage throws; the map must still be built. */
		try {
			if (!this.profile.base) this.quality = localStorage.getItem("mapQuality") || this.quality;
		} catch {}
		this._mapAR = MAP_CONFIG.totalWidth / MAP_CONFIG.totalHeight;
		this._sf = 0;
		this._sw = 0;
		this._sh = 0;
		this._ox = 0;
		this._oy = 0;
		this._rafId = null;

		this._setupTransforms();
		this._setupEvents();
		this._loadImages();
		const _parent = this.canvas.parentElement || this.canvas;
		if (typeof ResizeObserver !== "undefined") {
			new ResizeObserver(() => this._handleResize()).observe(_parent);
			/** Browser zoom and moving to another screen change the pixel ratio without a resize. */
			window.addEventListener("resize", () => this._handleResize());
		} else {
			window.addEventListener("resize", () => this._handleResize());
		}
		requestAnimationFrame(() => this._handleResize());
	}

	setPin(worldX, worldY) {
		this.pin = { worldX, worldY };
		this.draw();
	}

	setPinEnabled(enabled) {
		this.pinEnabled = enabled;
	}

	/** A labelled pin for one player's guess. With an avatar URL the pin shows their picture. */
	setNamePin(id, worldX, worldY, color, name, avatarUrl = "", { ripple = false } = {}) {
		const pin = { worldX, worldY, color, name, avatar: null };
		if (avatarUrl) {
			const img = new Image();
			img.onload = () => {
				pin.avatar = img;
				this.draw();
			};
			img.src = avatarUrl;
		}
		this.namePins.set(id, pin);
		if (ripple) this.addRipple(worldX, worldY, color);
		this.draw();
	}

	/** Sends a ring outward from a spot on the map, e.g. where a pin just landed. */
	addRipple(worldX, worldY, color, delay = 0) {
		if (MapCanvas.reducedMotion()) return;
		/** One ring per colour at a time: re-placing a pin quickly must not stack rings. */
		this.ripples = this.ripples.filter((r) => r.answer || r.color !== color);
		this.ripples.push({ worldX, worldY, color, startAt: performance.now() + delay });
		this._scheduleDraw();
	}

	clearNamePins() {
		this.namePins.clear();
		this.draw();
	}

	clearPin() {
		this.pin = null;
		this.correctPin = null;
		this.replayPins = [];
		this.replayDots = [];
		this.namePins.clear();
		this.guessLines = [];
		this.ripples = [];
		this.draw();
	}

	/** Draws a line growing from a guess to the answer. Returns when it will arrive. */
	addGuessLine(fromX, fromY, toX, toY, color = MapCanvas.GUESS_COLOR, delay = 0) {
		/** Reduced motion: already at full length. */
		const startAt = MapCanvas.reducedMotion()
			? performance.now() - MapCanvas.LINE_DURATION
			: performance.now() + delay;
		this.guessLines.push({ fromX, fromY, toX, toY, color, startAt });
		this._scheduleDraw();
		return startAt + MapCanvas.LINE_DURATION;
	}

	/** Shows the answer for a round. `roundNum` adds a numbered pair for the replay map instead. */
	showResult(correctX, correctY, guessX, guessY, roundNum) {
		const hasGuess = guessX !== undefined && guessX !== null && guessY !== undefined && guessY !== null;
		if (roundNum !== undefined) {
			const delay = MapCanvas.reducedMotion() ? 0 : this.replayPins.length * 250;
			const revealAt = hasGuess
				? this.addGuessLine(guessX, guessY, correctX, correctY, MapCanvas.GUESS_COLOR, delay)
				: performance.now() + delay;
			this.replayPins.push({
				correctX,
				correctY,
				guessX: hasGuess ? guessX : null,
				guessY: hasGuess ? guessY : null,
				roundNum,
				revealAt,
			});
		} else {
			if (hasGuess) this.pin = { worldX: guessX, worldY: guessY };
			const revealAt = hasGuess ? this.addGuessLine(guessX, guessY, correctX, correctY) : performance.now();
			this.correctPin = { worldX: correctX, worldY: correctY, revealAt };
			this._answerRipple(revealAt);
		}
		this.draw();
	}

	/** Adds one round to a multi-player replay: a numbered answer, and a dot and line per guess. */
	addReplayRound(roundNum, correctX, correctY, guesses) {
		const delay = MapCanvas.reducedMotion() ? 0 : this.replayPins.length * 700;
		let revealAt = performance.now() + delay;
		for (const g of guesses) {
			this.replayDots.push({ worldX: g.x, worldY: g.y, color: g.color, showAt: performance.now() + delay });
			revealAt = Math.max(revealAt, this.addGuessLine(g.x, g.y, correctX, correctY, g.color, delay));
		}
		this.replayPins.push({ correctX, correctY, guessX: null, guessY: null, roundNum, revealAt });
		this._scheduleDraw();
	}

	/** Holds back the answer pin until a line that is still travelling has reached it. */
	revealAnswerAt(time) {
		if (!this.correctPin || time <= (this.correctPin.revealAt || 0)) return;
		this.correctPin.revealAt = time;
		this._answerRipple(time);
	}

	_answerRipple(at) {
		if (MapCanvas.reducedMotion()) return;
		const { worldX, worldY } = this.correctPin;
		this.ripples = this.ripples.filter((r) => !r.answer);
		this.ripples.push({ worldX, worldY, color: MapCanvas.ANSWER_COLOR, startAt: at, answer: true });
		this._scheduleDraw();
	}

	/** Fits the given world positions in view. `restoreView` undoes it. */
	fitTo(points, { insetBottom = 0, padding = 56 } = {}) {
		this._handleResize();
		if (!points.length || this.viewWidth <= 0 || this.viewHeight <= 0) return;
		const t = this.ctx.getTransform();
		this._viewBeforeFit ??= { x: t.e, y: t.f, scale: t.a };

		const spots = points.map((p) => this.worldToCanvas(p.x, p.y));
		const xs = spots.map((s) => s.x);
		const ys = spots.map((s) => s.y);
		const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
		const roomX = Math.max(40, this.viewWidth - padding * 2);
		const roomY = Math.max(40, this.viewHeight - insetBottom - padding * 2);
		/** Never closer than 4x, so two guesses side by side do not fill the screen with a few tiles. */
		const scale = Math.min(4, Math.max(0.5, Math.min(roomX / (right - left || 1), roomY / (bottom - top || 1))));

		this.ctx.resetTransform();
		this.ctx.translate(
			this.viewWidth / 2 - ((left + right) / 2) * scale,
			Math.max(padding, (this.viewHeight - insetBottom) / 2) - ((top + bottom) / 2) * scale
		);
		this.ctx.scale(scale, scale);
		this._scheduleDraw();
	}

	/** Puts the map back where it was before `fitTo` moved it. */
	restoreView() {
		const before = this._viewBeforeFit;
		this._viewBeforeFit = null;
		if (!before) return;
		this.ctx.resetTransform();
		this.ctx.translate(before.x, before.y);
		this.ctx.scale(before.scale, before.scale);
		this._scheduleDraw();
	}

	setQuality(q) {
		this.quality = q;
		try {
			localStorage.setItem("mapQuality", q);
		} catch {}
		this._loadImages();
	}

	_updateMetrics() {
		const sf =
			this._mapAR > this.viewWidth / this.viewHeight
				? this.viewWidth / MAP_CONFIG.totalWidth
				: this.viewHeight / MAP_CONFIG.totalHeight;
		this._sf = sf;
		this._sw = MAP_CONFIG.totalWidth * sf;
		this._sh = MAP_CONFIG.totalHeight * sf;
		this._ox = (this.viewWidth - this._sw) / 2;
		this._oy = (this.viewHeight - this._sh) / 2;
	}

	/** Where tile `index` starts, in map pixels: the same rounding the map was cut with. */
	_tileEdge(index, count, total) {
		return Math.round((index * total) / count);
	}

	_pixelRatio() {
		return Math.min(window.devicePixelRatio || 1, this.profile.maxPixelRatio);
	}

	/** The tile quality this zoom needs, or null when the base map is sharp enough. */
	_detailQuality() {
		const { base, detail } = this.profile;
		if (!base) return null;
		const density = this._sf * this.currentScale * this._pixelRatio();
		const enough = MAP_QUALITIES.find((q) => MAP_QUALITY_SCALE[q] >= density) || "high";
		const wanted = MAP_QUALITIES[Math.min(MAP_QUALITIES.indexOf(enough), MAP_QUALITIES.indexOf(detail))];
		return MAP_QUALITIES.indexOf(wanted) > MAP_QUALITIES.indexOf(base) ? wanted : null;
	}

	/** The sharpest loaded image for a tile, no sharper than `wanted`; the base map when there is none. */
	_tileImage(r, c, wanted, now) {
		for (let i = MAP_QUALITIES.indexOf(wanted); i > MAP_QUALITIES.indexOf(this.profile.base); i--) {
			const entry = this.detailImages.get(`${MAP_QUALITIES[i]}:${r}:${c}`);
			if (!entry) continue;
			entry.usedAt = now;
			if (entry.ready) return entry.img;
		}
		return this.mapImages[r]?.[c];
	}

	/** Loads sharper tiles once the view has been still for a moment. */
	_queueDetail(quality, tiles) {
		clearTimeout(this._detailTimer);
		/** Zoomed back out to where the base map is enough: the sharper tiles are only holding memory. */
		if (!quality) {
			if (this.detailImages.size) this._detailTimer = setTimeout(() => this._dropStaleDetail(0), 1500);
			return;
		}
		const missing = tiles.filter(([r, c]) => !this.detailImages.has(`${quality}:${r}:${c}`));
		if (!missing.length) return;
		this._detailTimer = setTimeout(() => {
			for (const [r, c] of missing.slice(0, this.profile.maxDetailTiles)) {
				const entry = { img: new Image(), ready: false, usedAt: performance.now() };
				entry.img.decoding = "async";
				entry.img.onload = () => {
					entry.ready = true;
					this._scheduleDraw();
				};
				/** Kept as a failed entry, so the same tile is not asked for on every frame. */
				entry.img.onerror = () => (entry.failed = true);
				entry.img.src = tileUrl(r, c, quality);
				this.detailImages.set(`${quality}:${r}:${c}`, entry);
			}
			this._dropStaleDetail();
		}, 180);
	}

	/** Drops the sharper tiles used longest ago. Emptying `src` makes WebKit free the decoded image. */
	_dropStaleDetail(keep = this.profile.maxDetailTiles) {
		const oldestFirst = [...this.detailImages].sort((a, b) => a[1].usedAt - b[1].usedAt);
		for (const [key, entry] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - keep))) {
			entry.img.onload = entry.img.onerror = null;
			entry.img.src = "";
			this.detailImages.delete(key);
		}
	}

	_scheduleDraw() {
		if (this._rafId) return;
		this._rafId = requestAnimationFrame(() => {
			this._rafId = null;
			this.draw();
		});
	}

	worldToCanvas(wx, wy) {
		const relX = (wx - WORLD_BOUNDS.TOP_LEFT.x) / WORLD_WIDTH;
		const relY = (wy - WORLD_BOUNDS.TOP_LEFT.y) / WORLD_HEIGHT;
		return { x: this._ox + relX * this._sw, y: this._oy + relY * this._sh };
	}

	canvasToWorld(cx, cy) {
		return {
			x: WORLD_BOUNDS.TOP_LEFT.x + ((cx - this._ox) / this._sw) * WORLD_WIDTH,
			y: WORLD_BOUNDS.TOP_LEFT.y + ((cy - this._oy) / this._sh) * WORLD_HEIGHT,
		};
	}

	draw() {
		if (this.canvas.width <= 0 || this.canvas.height <= 0) return;
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.restore();

		ctx.imageSmoothingEnabled = false;
		/** Tiles differ in size, so each goes at its true edges or the map drifts under the coordinates. */
		const overlap = Math.max(0.5, 2 / this.currentScale);
		/** Only the tiles on screen are drawn: drawing one is what makes the browser decode it. */
		const topLeft = ctx.transformedPoint(0, 0);
		const bottomRight = ctx.transformedPoint(this.viewWidth, this.viewHeight);
		const wanted = this._detailQuality();
		const frameAt = performance.now();
		const onScreen = [];
		const tiles = [];
		for (let r = 0; r < MAP_CONFIG.rows; r++) {
			for (let c = 0; c < MAP_CONFIG.columns; c++) {
				const x = this._ox + this._tileEdge(c, MAP_CONFIG.columns, MAP_CONFIG.totalWidth) * this._sf;
				const y = this._oy + this._tileEdge(r, MAP_CONFIG.rows, MAP_CONFIG.totalHeight) * this._sf;
				const right = this._ox + this._tileEdge(c + 1, MAP_CONFIG.columns, MAP_CONFIG.totalWidth) * this._sf;
				const bottom = this._oy + this._tileEdge(r + 1, MAP_CONFIG.rows, MAP_CONFIG.totalHeight) * this._sf;
				if (right < topLeft.x || x > bottomRight.x || bottom < topLeft.y || y > bottomRight.y) continue;
				onScreen.push([r, c]);
				const img = wanted ? this._tileImage(r, c, wanted, frameAt) : this.mapImages[r]?.[c];
				if (img?.complete && img.naturalWidth) tiles.push({ r, c, img, x, y, w: right - x, h: bottom - y });
			}
		}
		if (this.profile.base) this._queueDetail(wanted, onScreen);
		const eachTile = (fn) => {
			for (const { r, c, img, x, y, w, h } of tiles)
				fn(img, x, y, w, h, c < MAP_CONFIG.columns - 1, r < MAP_CONFIG.rows - 1);
		};
		/** An oversized pass fills the hairline gaps, then an exact pass on top so nothing else is stretched. */
		eachTile((img, x, y, w, h, moreRight, moreBelow) =>
			ctx.drawImage(img, x, y, w + (moreRight ? overlap : 0), h + (moreBelow ? overlap : 0))
		);
		eachTile((img, x, y, w, h) => ctx.drawImage(img, x, y, w, h));
		ctx.imageSmoothingEnabled = true;

		const now = performance.now();
		/** How long ago something was revealed; with reduced motion, long enough that nothing is mid-entrance. */
		const sinceReveal = (at) => (MapCanvas.reducedMotion() && now >= (at || 0) ? Infinity : now - (at || 0));
		let animating = false;
		for (const line of this.guessLines) {
			if (this._drawGuessLine(line, now)) animating = true;
		}

		if (this.pin) {
			this._drawPin(this.pin.worldX, this.pin.worldY, MapCanvas.GUESS_COLOR, null);
		}

		/** Rings scheduled for later (waiting on a line) have a negative age and are kept. */
		this.ripples = this.ripples.filter((r) => now - r.startAt < MapCanvas.RIPPLE_DURATION);
		for (const ripple of this.ripples) this._drawRipple(ripple, now);
		if (this.ripples.length) animating = true;

		for (const rp of this.replayPins) {
			if (rp.guessX !== null) this._drawPin(rp.guessX, rp.guessY, MapCanvas.GUESS_COLOR, String(rp.roundNum));
		}
		for (const dot of this.replayDots) {
			if (now >= dot.showAt) this._drawDot(dot.worldX, dot.worldY, dot.color);
			else animating = true;
		}
		const deferred = [];
		for (const rp of this.replayPins) {
			const since = sinceReveal(rp.revealAt);
			if (since >= 0)
				deferred.push(() => this._drawAnswerPin(rp.correctX, rp.correctY, String(rp.roundNum), since));
			/** Keep drawing until the marker has finished fading in, or the last one never fully appears. */
			if (since < 300) animating = true;
		}
		if (this.correctPin) {
			const since = sinceReveal(this.correctPin.revealAt);
			if (since >= 0)
				deferred.push(() => this._drawAnswerPin(this.correctPin.worldX, this.correctPin.worldY, null, since));
			else animating = true;
			if (since >= 0 && since < 300) animating = true;
		}
		this._deferredPins = deferred;

		for (const pin of this.namePins.values()) this._drawNamePin(pin);
		/** The answer goes on last so nothing covers it. */
		for (const drawAnswer of this._deferredPins) drawAnswer();
		if (animating) this._scheduleDraw();
	}

	/** Where a world position currently is on screen, after panning and zooming. */
	_screenPos(worldX, worldY) {
		const cp = this.worldToCanvas(worldX, worldY);
		const t = this.ctx.getTransform();
		return {
			x: cp.x * t.a + cp.y * t.c + t.e,
			y: cp.x * t.b + cp.y * t.d + t.f,
		};
	}

	_drawRipple(ripple, now) {
		const t = (now - ripple.startAt) / MapCanvas.RIPPLE_DURATION;
		if (t <= 0) return;
		const { x, y } = this._screenPos(ripple.worldX, ripple.worldY);
		const ctx = this.ctx;
		ctx.save();
		const scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = scale;
		ctx.globalAlpha = (1 - t) * 0.4;
		ctx.beginPath();
		ctx.arc(x, y, 12 + 16 * (1 - Math.pow(1 - t, 2)), 0, Math.PI * 2);
		ctx.strokeStyle = ripple.color;
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.restore();
	}

	/** The correct location: a "place" marker with its tip on the spot. It scales in as it is revealed. */
	_drawAnswerPin(worldX, worldY, label, sinceReveal = 1000) {
		const { x, y } = this._screenPos(worldX, worldY);
		const t = Math.min(1, Math.max(0, sinceReveal / 250));
		const size = 10.5 * (0.6 + 0.4 * (1 - Math.pow(1 - t, 3)));
		const cy = y - size * 1.9;
		const ctx = this.ctx;

		ctx.save();
		const scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = scale;
		ctx.globalAlpha = t;

		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.bezierCurveTo(x - size * 0.35, y - size * 0.7, x - size, cy + size * 0.75, x - size, cy);
		ctx.arc(x, cy, size, Math.PI, 0);
		ctx.bezierCurveTo(x + size, cy + size * 0.75, x + size * 0.35, y - size * 0.7, x, y);
		ctx.closePath();
		ctx.shadowColor = "rgba(0,0,0,0.45)";
		ctx.shadowBlur = 6;
		ctx.shadowOffsetY = 2;
		ctx.fillStyle = MapCanvas.ANSWER_COLOR;
		ctx.fill();
		ctx.shadowColor = "transparent";

		if (label) {
			ctx.font = `600 ${Math.round(size * 0.95)}px Inter, sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "#fff";
			ctx.fillText(label, x, cy + 0.5);
		} else {
			ctx.beginPath();
			ctx.arc(x, cy, size * 0.38, 0, Math.PI * 2);
			ctx.fillStyle = "#fff";
			ctx.fill();
		}
		ctx.restore();
	}

	/** Draws one guess line at its current length. Returns true while it is still growing. */
	_drawGuessLine(line, now) {
		const t = Math.min(1, Math.max(0, (now - line.startAt) / MapCanvas.LINE_DURATION));
		if (t <= 0) return true;
		const eased = 1 - Math.pow(1 - t, 3);
		const from = this._screenPos(line.fromX, line.fromY);
		const to = this._screenPos(line.toX, line.toY);
		const headX = from.x + (to.x - from.x) * eased;
		const headY = from.y + (to.y - from.y) * eased;
		const ctx = this.ctx;

		ctx.save();
		const scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = scale;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(from.x, from.y);
		ctx.lineTo(headX, headY);
		ctx.lineWidth = 3;
		ctx.strokeStyle = line.color;
		ctx.globalAlpha = 0.9;
		ctx.shadowColor = "rgba(0,0,0,0.35)";
		ctx.shadowBlur = 3;
		ctx.shadowOffsetY = 1;
		ctx.stroke();
		if (t < 1) {
			ctx.beginPath();
			ctx.arc(headX, headY, 4, 0, Math.PI * 2);
			ctx.fillStyle = line.color;
			ctx.globalAlpha = 1;
			ctx.fill();
		}
		ctx.restore();
		return t < 1;
	}

	/** A small marker for a guess in a multi-player replay. */
	_drawDot(worldX, worldY, color) {
		const ctx = this.ctx;
		const { x, y } = this._screenPos(worldX, worldY);
		ctx.save();
		const scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = scale;
		ctx.beginPath();
		ctx.arc(x, y, 6, 0, Math.PI * 2);
		ctx.fillStyle = "#fff";
		ctx.fill();
		ctx.beginPath();
		ctx.arc(x, y, 4.5, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.fill();
		ctx.restore();
	}

	/** A guess pin in the player's colour. */
	_drawPin(worldX, worldY, color, label) {
		const ctx = this.ctx;
		const { x: sx, y: sy } = this._screenPos(worldX, worldY);
		const r = 9;

		ctx.save();
		const _scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = _scale;

		ctx.beginPath();
		ctx.arc(sx, sy, r + 2, 0, Math.PI * 2);
		ctx.shadowColor = "rgba(0,0,0,0.45)";
		ctx.shadowBlur = 5;
		ctx.shadowOffsetY = 2;
		ctx.fillStyle = "#fff";
		ctx.fill();
		ctx.shadowColor = "transparent";
		ctx.beginPath();
		ctx.arc(sx, sy, r, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.fill();

		if (label) {
			ctx.font = "600 10px Inter, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "#fff";
			ctx.fillText(label, sx, sy + 0.5);
		}
		ctx.restore();
	}

	_drawNamePin({ worldX, worldY, color, name, avatar }) {
		const ctx = this.ctx;
		const { x: sx, y: sy } = this._screenPos(worldX, worldY);
		const r = avatar ? 15 : 10;

		ctx.save();
		const _scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = _scale;

		ctx.beginPath();
		ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.shadowColor = "rgba(0,0,0,0.5)";
		ctx.shadowBlur = 6;
		ctx.fill();
		ctx.shadowBlur = 0;

		if (avatar) {
			ctx.save();
			ctx.beginPath();
			ctx.arc(sx, sy, r, 0, Math.PI * 2);
			ctx.clip();
			ctx.drawImage(avatar, sx - r, sy - r, r * 2, r * 2);
			ctx.restore();
		} else {
			ctx.font = "bold 11px Inter, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "#fff";
			ctx.fillText((name || "?").charAt(0).toUpperCase(), sx, sy + 0.5);
		}
		ctx.beginPath();
		ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 1.5;
		ctx.stroke();

		const label = name.length > 12 ? name.slice(0, 9) + "..." : name;
		ctx.font = `bold 11px Inter, sans-serif`;
		const tw = ctx.measureText(label).width;
		const pad = 5;
		const tagH = 18;
		const tagY = sy - r - tagH - 7;

		ctx.fillStyle = "rgba(0,0,0,0.75)";
		ctx.beginPath();
		ctx.roundRect(sx - tw / 2 - pad, tagY, tw + pad * 2, tagH, 4);
		ctx.fill();

		ctx.fillStyle = "#fff";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(label, sx, tagY + tagH / 2);

		ctx.restore();
	}

	_tileUrl(row, col) {
		return tileUrl(row, col, this.quality);
	}

	_loadImages() {
		const loadId = ++this.mapLoadId;
		this.mapImages = [];
		this._dropStaleDetail(0);
		for (let r = 0; r < MAP_CONFIG.rows; r++) {
			this.mapImages[r] = [];
			for (let c = 0; c < MAP_CONFIG.columns; c++) {
				const img = new Image();
				img.decoding = "async";
				let quality = this.quality;
				img.src = this._tileUrl(r, c);
				img.onload = () => {
					if (loadId !== this.mapLoadId) return;
					this.mapImages[r][c] = img;
					if (!this.mapInitialized) {
						this.mapInitialized = true;
						this._initCenter();
					} else {
						this.draw();
					}
				};
				/** A variant that is missing falls back to the next size up, not straight to the full-size tile. */
				img.onerror = () => {
					const next = MAP_QUALITIES[MAP_QUALITIES.indexOf(quality) + 1];
					if (!next || loadId !== this.mapLoadId) return;
					quality = next;
					img.src = tileUrl(r, c, quality);
				};
			}
		}
	}

	_initCenter() {
		if (this.viewWidth <= 0 || this.viewHeight <= 0) return;
		const centerWorld = {
			x: (WORLD_BOUNDS.TOP_LEFT.x + WORLD_BOUNDS.BOTTOM_RIGHT.x) / 2,
			y: (WORLD_BOUNDS.TOP_LEFT.y + WORLD_BOUNDS.BOTTOM_RIGHT.y) / 2,
		};
		const cp = this.worldToCanvas(centerWorld.x, centerWorld.y);
		this.ctx.translate(this.viewWidth / 2 - cp.x, this.viewHeight / 2 - cp.y);
		this.draw();
	}

	_resize(w, h) {
		if (w <= 0 || h <= 0) return;
		const dpr = this._pixelRatio();
		const pw = Math.round(w * dpr);
		const ph = Math.round(h * dpr);
		const newVw = pw / dpr;
		const newVh = ph / dpr;

		if (pw === this.canvas.width && ph === this.canvas.height) {
			this.viewWidth = newVw;
			this.viewHeight = newVh;
			this._updateMetrics();
			this.canvas.style.width = `${newVw}px`;
			this.canvas.style.height = `${newVh}px`;
			this.draw();
			return;
		}

		let worldCenter = null;
		const savedScale = this.currentScale;
		const hadValidDimensions = this.viewWidth > 0 && this.viewHeight > 0;
		if (this.mapInitialized && hadValidDimensions) {
			const center = this.ctx.transformedPoint(this.viewWidth / 2, this.viewHeight / 2);
			worldCenter = this.canvasToWorld(center.x, center.y);
		}

		this.viewWidth = newVw;
		this.viewHeight = newVh;
		this._updateMetrics();
		this.canvas.width = pw;
		this.canvas.height = ph;
		this.canvas.style.width = `${newVw}px`;
		this.canvas.style.height = `${newVh}px`;
		this.ctx.setDevicePixelRatio?.(dpr);

		if (worldCenter !== null) {
			this.ctx.resetTransform();
			const cp = this.worldToCanvas(worldCenter.x, worldCenter.y);
			this.ctx.translate(newVw / 2 - cp.x, newVh / 2 - cp.y);
			if (savedScale !== 1) this._zoomAt(newVw / 2, newVh / 2, savedScale);
		} else if (this.mapInitialized) {
			this.ctx.resetTransform();
			this._initCenter();
			return;
		}

		this.draw();
	}

	/** Fits the canvas to its container. Reads layout size, which animations and transforms do not affect. */
	_handleResize() {
		const parent = this.canvas.parentElement;
		const dpr = this._pixelRatio();
		const sameSize =
			Math.abs(parent.clientWidth - this.viewWidth) < 1 && Math.abs(parent.clientHeight - this.viewHeight) < 1;
		if (sameSize && this._dpr === dpr) return;
		this._dpr = dpr;
		this._resize(parent.clientWidth, parent.clientHeight);
	}

	_setupTransforms() {
		let transform = new DOMMatrix();
		let dpr = 1;
		const ctx = this.ctx;
		const savedStack = [];
		const original = { save: ctx.save.bind(ctx), restore: ctx.restore.bind(ctx) };
		const apply = () => {
			const native = ctx.setTransform.bind(ctx);
			native(
				dpr * transform.a,
				dpr * transform.b,
				dpr * transform.c,
				dpr * transform.d,
				dpr * transform.e,
				dpr * transform.f
			);
		};
		ctx.getTransform = () => transform;
		ctx.save = () => {
			savedStack.push(
				new DOMMatrix([transform.a, transform.b, transform.c, transform.d, transform.e, transform.f])
			);
			original.save();
		};
		ctx.restore = () => {
			if (savedStack.length > 0) transform = savedStack.pop();
			original.restore();
		};
		ctx.scale = (sx, sy) => {
			transform = transform.scale(sx, sy);
			this.currentScale *= sx;
			apply();
		};
		ctx.translate = (dx, dy) => {
			transform = transform.translate(dx, dy);
			apply();
		};
		ctx.resetTransform = () => {
			transform = new DOMMatrix();
			this.currentScale = 1;
			apply();
		};
		ctx.setDevicePixelRatio = (d) => {
			dpr = d;
			apply();
		};
		ctx.transformedPoint = (x, y) => new DOMPoint(x, y).matrixTransform(transform.inverse());
	}

	_zoomAt(sx, sy, factor) {
		const MIN_SCALE = 0.5;
		const MAX_SCALE = 80;
		const newScale = this.currentScale * factor;
		if (newScale < MIN_SCALE || newScale > MAX_SCALE) return;
		const pt = this.ctx.transformedPoint(sx, sy);
		this.ctx.translate(pt.x, pt.y);
		this.ctx.scale(factor, factor);
		this.ctx.translate(-pt.x, -pt.y);
		this._scheduleDraw();
	}

	/**
	 * A pointer position in canvas units, measured fresh so it stays right while the page scrolls, zooms or animates.
	 */
	_canvasCoords(e) {
		this._handleResize();
		const r = this.canvas.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return { x: 0, y: 0 };
		return {
			x: ((e.clientX - r.left) / r.width) * this.viewWidth,
			y: ((e.clientY - r.top) / r.height) * this.viewHeight,
		};
	}

	/** Drops the guess pin on the map under a pointer position, if that is on the map. */
	_placePinAt(pos) {
		if (!this.pinEnabled || !this.onPinPlaced) return;
		const pt = this.ctx.transformedPoint(pos.x, pos.y);
		const world = this.canvasToWorld(pt.x, pt.y);
		if (
			world.x < WORLD_BOUNDS.TOP_LEFT.x ||
			world.x > WORLD_BOUNDS.BOTTOM_RIGHT.x ||
			world.y < WORLD_BOUNDS.TOP_LEFT.y ||
			world.y > WORLD_BOUNDS.BOTTOM_RIGHT.y
		)
			return;
		this.pin = { worldX: world.x, worldY: world.y };
		this.addRipple(world.x, world.y, MapCanvas.GUESS_COLOR);
		this.draw();
		this.onPinPlaced(world.x, world.y);
	}

	_setupEvents() {
		const canvas = this.canvas;

		/** A press that ends where it began places the pin, however long it took; one that moves is a pan. */
		const moved = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
		let pressedAt = null;

		canvas.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			const pos = this._canvasCoords(e);
			this.dragStart = this.ctx.transformedPoint(pos.x, pos.y);
			pressedAt = pos;
			this.isDragging = true;
		});

		canvas.addEventListener("mousemove", (e) => {
			if (!this.isDragging) return;
			const pos = this._canvasCoords(e);
			/** Hold still until it is clearly a drag, so a click never nudges the map. */
			if (pressedAt && moved(pos, pressedAt) <= MapCanvas.CLICK_SLOP) return;
			pressedAt = null;
			const cur = this.ctx.transformedPoint(pos.x, pos.y);
			this.ctx.translate(cur.x - this.dragStart.x, cur.y - this.dragStart.y);
			this._scheduleDraw();
		});

		canvas.addEventListener("mouseup", (e) => {
			if (e.button !== 0) return;
			const pos = this._canvasCoords(e);
			if (this.isDragging && pressedAt && moved(pos, pressedAt) <= MapCanvas.CLICK_SLOP) this._placePinAt(pos);
			this.isDragging = false;
			this.dragStart = null;
			pressedAt = null;
		});

		canvas.addEventListener("mouseleave", () => {
			this.isDragging = false;
			pressedAt = null;
		});

		canvas.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
				const pos = this._canvasCoords(e);
				this._zoomAt(pos.x, pos.y, factor);
			},
			{ passive: false }
		);

		let lastDist = 0;
		/** Where a one-finger touch began, while it could still turn out to be a tap. */
		let tapAt = null;
		/** The last tap, so a second one right after it in the same spot zooms in. */
		let lastTap = null;

		canvas.addEventListener(
			"touchstart",
			(e) => {
				e.preventDefault();
				if (e.touches.length === 1) {
					const pos = this._canvasCoords(e.touches[0]);
					this.dragStart = this.ctx.transformedPoint(pos.x, pos.y);
					tapAt = pos;
					this.isDragging = true;
				} else {
					/** A second finger makes it a pinch, never a tap. */
					tapAt = null;
					this.isDragging = false;
					lastDist = Math.hypot(
						e.touches[0].clientX - e.touches[1].clientX,
						e.touches[0].clientY - e.touches[1].clientY
					);
				}
			},
			{ passive: false }
		);

		canvas.addEventListener(
			"touchmove",
			(e) => {
				e.preventDefault();
				if (e.touches.length === 1 && this.isDragging) {
					const pos = this._canvasCoords(e.touches[0]);
					if (tapAt && moved(pos, tapAt) <= MapCanvas.TAP_SLOP) return;
					tapAt = null;
					const cur = this.ctx.transformedPoint(pos.x, pos.y);
					this.ctx.translate(cur.x - this.dragStart.x, cur.y - this.dragStart.y);
					this._scheduleDraw();
				} else if (e.touches.length === 2 && lastDist > 0) {
					const dist = Math.hypot(
						e.touches[0].clientX - e.touches[1].clientX,
						e.touches[0].clientY - e.touches[1].clientY
					);
					const mid = this._canvasCoords({
						clientX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
						clientY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
					});
					this._zoomAt(mid.x, mid.y, dist / lastDist);
					lastDist = dist;
				}
			},
			{ passive: false }
		);

		canvas.addEventListener("touchend", (e) => {
			if (tapAt && e.touches.length === 0 && e.changedTouches.length === 1) {
				const pos = this._canvasCoords(e.changedTouches[0]);
				if (moved(pos, tapAt) <= MapCanvas.TAP_SLOP) {
					const now = performance.now();
					const double =
						lastTap &&
						now - lastTap.at < MapCanvas.DOUBLE_TAP_MS &&
						moved(pos, lastTap) <= 3 * MapCanvas.TAP_SLOP;
					lastTap = double ? null : { ...pos, at: now };
					/** The first tap has already put the pin there; the second only zooms. */
					if (double) this._zoomAt(pos.x, pos.y, 1.8);
					else this._placePinAt(pos);
				}
			}
			tapAt = null;
			this.isDragging = false;
		});
		canvas.addEventListener("touchcancel", () => {
			tapAt = null;
			this.isDragging = false;
		});

		document
			.getElementById("zoom-in")
			?.addEventListener("click", () => this._zoomAt(this.viewWidth / 2, this.viewHeight / 2, 1.3));
		document
			.getElementById("zoom-out")
			?.addEventListener("click", () => this._zoomAt(this.viewWidth / 2, this.viewHeight / 2, 1 / 1.3));
		const qualitySel = document.getElementById("map-quality");
		/** With a base map the quality follows the zoom by itself, so there is nothing to choose. */
		if (qualitySel && this.profile.base) qualitySel.hidden = true;
		else if (qualitySel) {
			qualitySel.value = this.quality;
			qualitySel.addEventListener("change", () => {
				this.setQuality(qualitySel.value);
				/** Hand the keyboard back to the game, so Space still submits a guess. */
				qualitySel.blur();
			});
		}
	}
}

/** Material Red 400 for a guess, Green 500 for the answer. */
MapCanvas.GUESS_COLOR = "#EF5350";
MapCanvas.ANSWER_COLOR = "#4CAF50";
/** How long a guess line takes to reach the answer, in milliseconds. */
MapCanvas.LINE_DURATION = 1100;
MapCanvas.RIPPLE_DURATION = 600;
/** Asked each time, so a change to the system setting applies to the next result without a reload. */
MapCanvas.reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** How far (in CSS pixels) a press may wander and still count as a click or a tap. */
MapCanvas.CLICK_SLOP = 4;
MapCanvas.TAP_SLOP = 10;
/** Two taps within this many milliseconds are a double tap. */
MapCanvas.DOUBLE_TAP_MS = 300;
