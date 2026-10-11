function _defaultMapQuality() {
	const ua = navigator.userAgent;
	const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
	const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua);
	return isMobile || isSafari ? "medium" : "high";
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
		// Lines drawn from a guess to the answer, each animating out from the guess.
		this.guessLines = [];
		// Expanding rings that mark a pin landing.
		this.ripples = [];
		this.quality = localStorage.getItem("mapQuality") || _defaultMapQuality();
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
			// Browser zoom and moving to another screen change the pixel ratio without a resize.
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
		// One ring per colour at a time: re-placing a pin quickly must not stack rings.
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

	/**
	 * Draws a line that grows from a guess to the correct spot. Every result view
	 * uses this, so guesses look the same in solo, daily, duels and replays.
	 * Returns the time at which the line will have arrived.
	 */
	addGuessLine(fromX, fromY, toX, toY, color = MapCanvas.GUESS_COLOR, delay = 0) {
		const startAt = performance.now() + delay;
		this.guessLines.push({ fromX, fromY, toX, toY, color, startAt });
		this._scheduleDraw();
		return startAt + MapCanvas.LINE_DURATION;
	}

	/**
	 * Shows the answer for a round. With a guess, the line travels to the answer
	 * first and the answer pin appears as it lands. Passing `roundNum` adds a
	 * numbered pair instead, for the end-of-game replay map.
	 */
	showResult(correctX, correctY, guessX, guessY, roundNum) {
		const hasGuess = guessX !== undefined && guessX !== null && guessY !== undefined && guessY !== null;
		if (roundNum !== undefined) {
			const delay = this.replayPins.length * 250;
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

	/**
	 * Adds one round to a replay with any number of players: the answer marker,
	 * numbered, and a small dot and line for each player's guess in their colour.
	 * Rounds play back one after another.
	 */
	addReplayRound(roundNum, correctX, correctY, guesses) {
		const delay = this.replayPins.length * 700;
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
		const { worldX, worldY } = this.correctPin;
		this.ripples = this.ripples.filter((r) => !r.answer);
		this.ripples.push({ worldX, worldY, color: MapCanvas.ANSWER_COLOR, startAt: at, answer: true });
		this._scheduleDraw();
	}

	/**
	 * Moves and zooms the map so every given world position is in view, clear of whatever
	 * covers the bottom `insetBottom` pixels (a result sheet). The view it replaces is kept
	 * for `restoreView`.
	 */
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
		// Never closer than 4x, so two guesses side by side do not fill the screen with a few tiles.
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
		localStorage.setItem("mapQuality", q);
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
		// Tiles differ in size, so each goes at its true edges or the map drifts under the coordinates.
		const overlap = Math.max(0.5, 2 / this.currentScale);
		const eachTile = (fn) => {
			for (let r = 0; r < MAP_CONFIG.rows; r++) {
				for (let c = 0; c < MAP_CONFIG.columns; c++) {
					const img = this.mapImages[r]?.[c];
					if (!img?.complete || !img.naturalWidth) continue;
					const x = this._ox + this._tileEdge(c, MAP_CONFIG.columns, MAP_CONFIG.totalWidth) * this._sf;
					const y = this._oy + this._tileEdge(r, MAP_CONFIG.rows, MAP_CONFIG.totalHeight) * this._sf;
					const right =
						this._ox + this._tileEdge(c + 1, MAP_CONFIG.columns, MAP_CONFIG.totalWidth) * this._sf;
					const bottom = this._oy + this._tileEdge(r + 1, MAP_CONFIG.rows, MAP_CONFIG.totalHeight) * this._sf;
					fn(img, x, y, right - x, bottom - y, c < MAP_CONFIG.columns - 1, r < MAP_CONFIG.rows - 1);
				}
			}
		};
		// An oversized pass fills the hairline gaps, then an exact pass on top so nothing else is stretched.
		eachTile((img, x, y, w, h, moreRight, moreBelow) =>
			ctx.drawImage(img, x, y, w + (moreRight ? overlap : 0), h + (moreBelow ? overlap : 0))
		);
		eachTile((img, x, y, w, h) => ctx.drawImage(img, x, y, w, h));
		ctx.imageSmoothingEnabled = true;

		const now = performance.now();
		let animating = false;
		for (const line of this.guessLines) {
			if (this._drawGuessLine(line, now)) animating = true;
		}

		if (this.pin) {
			this._drawPin(this.pin.worldX, this.pin.worldY, MapCanvas.GUESS_COLOR, null);
		}

		// Rings scheduled for later (waiting on a line) have a negative age and are kept.
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
			const since = now - (rp.revealAt || 0);
			if (since >= 0)
				deferred.push(() => this._drawAnswerPin(rp.correctX, rp.correctY, String(rp.roundNum), since));
			// Keep drawing until the marker has finished fading in, or the last one never fully appears.
			if (since < 300) animating = true;
		}
		if (this.correctPin) {
			const since = now - (this.correctPin.revealAt || 0);
			if (since >= 0)
				deferred.push(() => this._drawAnswerPin(this.correctPin.worldX, this.correctPin.worldY, null, since));
			else animating = true;
			if (since >= 0 && since < 300) animating = true;
		}
		this._deferredPins = deferred;

		for (const pin of this.namePins.values()) this._drawNamePin(pin);
		// The answer goes on last so nothing covers it.
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

	/**
	 * The correct location, drawn as the Material "place" marker: a flat teardrop
	 * with a round cut-out, its tip exactly on the spot, lifted off the map by a
	 * soft shadow. It scales in as it is revealed.
	 */
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

	/**
	 * Draws one guess line at its current length: a single solid stroke in the
	 * guess's colour, with a small dot leading it while it travels. Returns true
	 * while it is still growing.
	 */
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

	/** A guess: a flat disc in the player's colour with a white ring and a soft shadow. */
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
		for (let r = 0; r < MAP_CONFIG.rows; r++) {
			this.mapImages[r] = [];
			for (let c = 0; c < MAP_CONFIG.columns; c++) {
				const img = new Image();
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
				img.onerror = () => {
					if (this.quality !== "high") {
						img.src = tileUrl(r, c, "high");
					}
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
		const dpr = window.devicePixelRatio || 1;
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

	/**
	 * Fits the canvas to its container. The size is read from layout (clientWidth), which
	 * CSS transforms and animations on the page do not touch, so the canvas is never sized
	 * to a box that is mid-animation.
	 */
	_handleResize() {
		const parent = this.canvas.parentElement;
		const dpr = window.devicePixelRatio || 1;
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
	 * A pointer position in canvas units. The canvas's on-screen box is measured fresh every
	 * time and the position scaled into it, so the answer is right whatever the page is doing:
	 * scrolled, browser-zoomed, mid-resize, or inside something being scaled by an animation.
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

		// A press that ends where it began places the pin, however long it took; one that moves is a pan.
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
			// Hold still until it is clearly a drag, so a click never nudges the map.
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
		// Where a one-finger touch began, while it could still turn out to be a tap.
		let tapAt = null;

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
					// A second finger makes it a pinch, never a tap.
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
				if (moved(pos, tapAt) <= MapCanvas.TAP_SLOP) this._placePinAt(pos);
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
		if (qualitySel) {
			qualitySel.value = this.quality;
			qualitySel.addEventListener("change", () => {
				this.setQuality(qualitySel.value);
				// Hand the keyboard back to the game, so Space still submits a guess.
				qualitySel.blur();
			});
		}
	}
}

// Material palette: Red 400 for a guess, Green 500 for the answer.
MapCanvas.GUESS_COLOR = "#EF5350";
MapCanvas.ANSWER_COLOR = "#4CAF50";
/** How long a guess line takes to reach the answer, in milliseconds. */
MapCanvas.LINE_DURATION = 1100;
MapCanvas.RIPPLE_DURATION = 600;
/** How far (in CSS pixels) a press may wander and still count as a click or a tap. */
MapCanvas.CLICK_SLOP = 4;
MapCanvas.TAP_SLOP = 10;
