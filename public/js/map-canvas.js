import { MAP_CONFIG, WORLD_BOUNDS, WORLD_HEIGHT, WORLD_WIDTH, tileUrl } from "./map-config.js";
import { avatarSrc } from "./lib/dom.js";

const whenIdle = (fn) =>
	"requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 50);

/** Each quality's width as a share of the full-size map (see src/tile-images.ts), smallest first. */
const MAP_QUALITY_SCALE = { tiny: 0.25, low: 0.45, medium: 0.75, high: 1 };
const MAP_QUALITIES = Object.keys(MAP_QUALITY_SCALE);
/** Rows of the original image in each square of the sharper sizes; keep in step with src/tile-images.ts. */
const SQUARE_ROWS = 1024;
/** The picker's sizes: how sharp zoomed-in squares may get. */
const MAP_QUALITY_CHOICES = ["high", "medium", "low"];
const MAP_FORMATS = { avif: "AVIF (recommended)", webp: "WebP (older devices)", png: "PNG (fast connections)" };

const avifSupported = new Promise((resolve) => {
	const img = new Image();
	img.onload = () => resolve(img.width === 1);
	img.onerror = () => resolve(false);
	img.src =
		"data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAAB0AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAlbWRhdBIACgc4AAaQENBpMhAZQmMEwAA0AACQQM6Xt10S";
});

/** Decodes once, off the main thread; drawing an <img> re-decodes it mid-frame and stalls panning. */
async function decodedTile(img) {
	if (typeof createImageBitmap !== "function") return img;
	try {
		const full = await createImageBitmap(img);
		const { width, height } = full;
		const strips = [];
		for (let top = 0; top < height; top += STRIP_HEIGHT) {
			/** One row more than the strip, from the next one, so seams are covered by real pixels, not stretching. */
			const rows = Math.min(STRIP_HEIGHT + 1, height - top);
			strips.push({ top, rows, bitmap: await createImageBitmap(full, 0, top, width, rows) });
		}
		full.close();
		img.onload = img.onerror = null;
		img.src = "";
		return { width, height, strips };
	} catch {
		return img;
	}
}

/** Tiles are 12,000px tall, past many graphics cards' 8,192 limit; strips draw fast and only when on screen. */
const STRIP_HEIGHT = 2048;

const tileReady = (tile) =>
	!!tile && (tile instanceof HTMLImageElement ? tile.complete && tile.naturalWidth > 0 : tile.strips.length > 0);

const releaseTile = (tile) => {
	if (tile instanceof HTMLImageElement) tile.src = "";
	else for (const strip of tile?.strips ?? []) strip.bitmap.close();
};

/** A small `base` map for every device, plus sharper `detail` tiles for what is on screen: the full map decodes to nearly 1 GB. */
function _mapProfile() {
	const ua = navigator.userAgent;
	/** An iPad asks for the desktop site and calls itself a Mac; only its touch screen gives it away. */
	const isMobile =
		/Mobi|Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
	const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg/i.test(ua);
	if (isMobile) return { base: "tiny", detail: "medium", maxSquares: 16, maxPixelRatio: 2 };
	if (isSafari) return { base: "tiny", detail: "medium", maxSquares: 24, maxPixelRatio: 2 };
	/** Decoding and uploading every full-size tile at once froze desktops for half a second. */
	return { base: "tiny", detail: "high", maxSquares: 40, maxPixelRatio: 3 };
}

export class MapCanvas {
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
		this.guessLines = [];
		this.ripples = [];
		this.profile = _mapProfile();
		/** Sharper tiles for the part of the map on screen, by "quality:row:column". Only used with a `base`. */
		this.detailImages = new Map();
		this._warmQueue = [];
		this._warming = false;
		this._detailTimer = null;
		this.quality = this.profile.base;
		/** AVIF is smallest, but its decoder needs several cores; with two or fewer, WebP loads sooner. */
		this.format = (navigator.hardwareConcurrency || 4) > 2 ? "avif" : "webp";
		/** Blocked storage throws; the map must still be built. */
		try {
			const quality = localStorage.getItem("mapQuality");
			if (MAP_QUALITY_CHOICES.includes(quality)) this.profile.detail = quality;
			if (localStorage.getItem("mapFormat") in MAP_FORMATS) this.format = localStorage.getItem("mapFormat");
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
		avifSupported.then((ok) => {
			if (!ok && this.format === "avif") this.format = "webp";
			this._loadImages();
		});
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

	/** `status`: "placing" draws the pin faded, "locked" adds a tick. */
	setNamePin(id, worldX, worldY, color, name, avatarUrl = "", { ripple = false, status = null } = {}) {
		const pin = { worldX, worldY, color, name, avatar: null, avatarUrl, status };
		/** Keeps the picture of a pin that moves often. */
		const old = this.namePins.get(id);
		if (old?.avatar && old.avatarUrl === avatarUrl) pin.avatar = old.avatar;
		else if (avatarUrl) {
			const img = new Image();
			img.onload = () => {
				pin.avatar = img;
				this.draw();
			};
			img.src = avatarSrc(avatarUrl, 32);
		}
		this.namePins.set(id, pin);
		if (ripple) this.addRipple(worldX, worldY, color);
		this.draw();
	}

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
		try {
			localStorage.setItem("mapQuality", q);
		} catch {}
		this.profile.detail = q;
		this._dropStaleDetail(0);
		this._scheduleDraw();
	}

	setFormat(format) {
		this.format = format;
		try {
			localStorage.setItem("mapFormat", format);
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
		const density = this._sf * this.currentScale * this._pixelRatio();
		const enough = MAP_QUALITIES.find((q) => MAP_QUALITY_SCALE[q] >= density) || "high";
		const wanted = MAP_QUALITIES[Math.min(MAP_QUALITIES.indexOf(enough), MAP_QUALITIES.indexOf(detail))];
		return MAP_QUALITIES.indexOf(wanted) > MAP_QUALITIES.indexOf(base) ? wanted : null;
	}

	/** The sharpest loaded square, no sharper than `wanted`, or null to leave the base map showing. */
	_squareImage(r, c, k, wanted, now) {
		for (let i = MAP_QUALITIES.indexOf(wanted); i > MAP_QUALITIES.indexOf(this.profile.base); i--) {
			const entry = this.detailImages.get(`${MAP_QUALITIES[i]}:${r}:${c}:${k}`);
			if (!entry) continue;
			entry.usedAt = now;
			if (tileReady(entry.tile)) return entry.tile.strips ? entry.tile.strips[0].bitmap : entry.tile;
		}
		return null;
	}

	_queueDetail(quality, squares) {
		clearTimeout(this._detailTimer);
		/** Zoomed back out to where the base map is enough: the sharper tiles are only holding memory. */
		if (!quality) {
			if (this.detailImages.size) this._detailTimer = setTimeout(() => this._dropStaleDetail(0), 1500);
			return;
		}
		const keyOf = ([r, c, k]) => `${quality}:${r}:${c}:${k}`;
		const missing = squares.filter((square) => !this.detailImages.has(keyOf(square)));
		if (!missing.length) return;
		this._detailTimer = setTimeout(() => {
			for (const square of missing.slice(0, this.profile.maxSquares)) {
				const [r, c, k] = square;
				const key = keyOf(square);
				const entry = { img: new Image(), tile: null, usedAt: performance.now() };
				const formats = [this.format, ...["webp", "png"].filter((f) => f !== this.format)];
				entry.img.decoding = "async";
				entry.img.onload = async () => {
					const tile = await decodedTile(entry.img);
					if (this.detailImages.get(key) !== entry) return releaseTile(tile);
					entry.tile = tile;
					this._warmTile(tile);
					this._scheduleDraw();
				};
				/** A failed square tries the other formats, then stays failed so it is not asked for every frame. */
				entry.img.onerror = () => {
					formats.shift();
					if (!formats.length) return void (entry.failed = true);
					entry.img.src = tileUrl(r, c, quality, formats[0], k);
				};
				entry.img.src = tileUrl(r, c, quality, formats[0], k);
				this.detailImages.set(key, entry);
			}
			this._dropStaleDetail();
		}, 180);
	}

	/** Drops the sharper tiles used longest ago. Emptying `src` makes WebKit free the decoded image. */
	_dropStaleDetail(keep = this.profile.maxSquares) {
		const oldestFirst = [...this.detailImages].sort((a, b) => a[1].usedAt - b[1].usedAt);
		for (const [key, entry] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - keep))) {
			entry.img.onload = entry.img.onerror = null;
			entry.img.src = "";
			releaseTile(entry.tile);
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
				const mapHeight =
					this._tileEdge(r + 1, MAP_CONFIG.rows, MAP_CONFIG.totalHeight) -
					this._tileEdge(r, MAP_CONFIG.rows, MAP_CONFIG.totalHeight);
				onScreen.push({ r, c, x, y, w: right - x, mapHeight });
				const img = this.mapImages[r]?.[c];
				if (tileReady(img)) tiles.push({ r, c, img, x, y, w: right - x, h: bottom - y });
			}
		}

		const drawTile = (tile, x, y, w, h, padRight, padBelow) => {
			if (!tile.strips) return ctx.drawImage(tile, x, y, w + padRight, h + padBelow);
			const scale = h / tile.height;
			for (const strip of tile.strips) {
				const top = y + strip.top * scale;
				const height = strip.rows * scale;
				if (top > bottomRight.y || top + height < topLeft.y) continue;
				const last = strip.top + strip.rows >= tile.height;
				ctx.drawImage(strip.bitmap, x, top, w + padRight, height + (last ? padBelow : 0));
			}
		};
		/** An oversized pass fills the hairline gaps, then an exact pass on top so nothing else is stretched. */
		for (const { r, c, img, x, y, w, h } of tiles) {
			const right = c < MAP_CONFIG.columns - 1 ? overlap : 0;
			drawTile(img, x, y, w, h, right, r < MAP_CONFIG.rows - 1 ? overlap : 0);
		}
		for (const { img, x, y, w, h } of tiles) drawTile(img, x, y, w, h, 0, 0);
		/** Sharper squares over the base, at their exact original rows and column edges, as pins use; the base covers seams. */
		const squares = [];
		if (wanted) {
			for (const { r, c, x, y, w, mapHeight } of onScreen) {
				const first = Math.max(0, Math.floor((topLeft.y - y) / (SQUARE_ROWS * this._sf)));
				const last = Math.min(
					Math.ceil(mapHeight / SQUARE_ROWS) - 1,
					Math.floor((bottomRight.y - y) / (SQUARE_ROWS * this._sf))
				);
				for (let k = first; k <= last; k++) {
					squares.push([r, c, k]);
					const square = this._squareImage(r, c, k, wanted, frameAt);
					if (!square) continue;
					const topRow = k * SQUARE_ROWS;
					const rows = Math.min(SQUARE_ROWS, mapHeight - topRow);
					const take = rows + (topRow + rows < mapHeight ? 1 : 0);
					ctx.drawImage(square, x, y + topRow * this._sf, w, take * this._sf);
				}
			}
		}
		this._queueDetail(wanted, squares);
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

	_drawNamePin({ worldX, worldY, color, name, avatar, status }) {
		const ctx = this.ctx;
		const { x: sx, y: sy } = this._screenPos(worldX, worldY);
		const r = avatar ? 15 : 10;
		const placing = status === "placing";

		ctx.save();
		const _scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = _scale;
		if (placing) ctx.globalAlpha = 0.6;

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
		if (placing) ctx.setLineDash([3, 3]);
		ctx.stroke();
		ctx.setLineDash([]);

		const label = name.length > 12 ? name.slice(0, 9) + "..." : name;
		ctx.font = `bold 11px Inter, sans-serif`;
		const tw = ctx.measureText(label).width;
		const pad = 5;
		const mark = status ? 14 : 0;
		const tagH = 18;
		const tagY = sy - r - tagH - 7;
		const left = sx - (tw + mark) / 2 - pad;

		ctx.fillStyle = "rgba(0,0,0,0.75)";
		ctx.beginPath();
		ctx.roundRect(left, tagY, tw + mark + pad * 2, tagH, 4);
		ctx.fill();

		if (status) {
			const cx = left + pad + 5;
			const cy = tagY + tagH / 2;
			ctx.beginPath();
			ctx.arc(cx, cy, 5, 0, Math.PI * 2);
			if (placing) {
				ctx.strokeStyle = "#a1a1aa";
				ctx.lineWidth = 1.5;
				ctx.stroke();
			} else {
				ctx.fillStyle = "#4CAF50";
				ctx.fill();
				ctx.beginPath();
				ctx.moveTo(cx - 2.5, cy);
				ctx.lineTo(cx - 0.5, cy + 2);
				ctx.lineTo(cx + 2.5, cy - 2);
				ctx.strokeStyle = "#fff";
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}
		}

		ctx.fillStyle = "#fff";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(label, sx + mark / 2, tagY + tagH / 2);

		ctx.restore();
	}

	_loadImages() {
		const loadId = ++this.mapLoadId;
		for (const row of this.mapImages) for (const tile of row ?? []) releaseTile(tile);
		this.mapImages = [];
		this._warmQueue = [];
		this._dropStaleDetail(0);
		for (let r = 0; r < MAP_CONFIG.rows; r++) {
			this.mapImages[r] = [];
			for (let c = 0; c < MAP_CONFIG.columns; c++) this._loadTile(r, c, this.quality, loadId);
		}
	}

	_loadTile(r, c, wanted, loadId) {
		const img = new Image();
		img.decoding = "async";
		let quality = wanted;
		let format = this.format;
		img.onload = async () => {
			if (loadId !== this.mapLoadId) return;
			const tile = await decodedTile(img);
			if (loadId !== this.mapLoadId) return releaseTile(tile);
			this.mapImages[r][c] = tile;
			this._warmTile(tile);
			if (!this.mapInitialized) {
				this.mapInitialized = true;
				this._initCenter();
			} else {
				this._scheduleDraw();
			}
		};
		/** A failed tile tries the other formats, then the next size up. */
		const tried = new Set([format]);
		img.onerror = () => {
			if (loadId !== this.mapLoadId) return;
			const other = ["webp", "png"].find((f) => !tried.has(f));
			if (other) format = other;
			else {
				quality = MAP_QUALITIES[MAP_QUALITIES.indexOf(quality) + 1];
				if (!quality) return;
				format = "webp";
				tried.clear();
			}
			tried.add(format);
			img.src = tileUrl(r, c, quality, format);
		};
		img.src = tileUrl(r, c, quality, format);
	}

	/** Uploads strips to the graphics card while idle, so the first sight of one does not stall a frame. */
	_warmTile(tile) {
		if (!tile?.strips) return;
		this._warmQueue.push(...tile.strips);
		if (this._warming) return;
		this._warming = true;
		const next = () => {
			const strip = this._warmQueue.shift();
			if (!strip) {
				this._warming = false;
				return this._scheduleDraw();
			}
			/** Drawn into one corner pixel, almost transparent; the next frame paints over it. */
			if (strip.bitmap.width) {
				this.ctx.save();
				this.ctx.setTransform(1, 0, 0, 1, 0, 0);
				this.ctx.globalAlpha = 0.01;
				this.ctx.drawImage(strip.bitmap, 0, 0, 1, 1);
				this.ctx.restore();
			}
			whenIdle(next);
		};
		whenIdle(next);
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
		/** Zoom is saved with the transform, since overlays reset it between save and restore. */
		ctx.save = () => {
			savedStack.push({
				transform: new DOMMatrix([
					transform.a,
					transform.b,
					transform.c,
					transform.d,
					transform.e,
					transform.f,
				]),
				scale: this.currentScale,
			});
			original.save();
		};
		ctx.restore = () => {
			const saved = savedStack.pop();
			if (saved) {
				transform = saved.transform;
				this.currentScale = saved.scale;
			}
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

	/** Zooms on the middle of the view. */
	zoomBy(factor) {
		this._busy();
		this._zoomAt(this.viewWidth / 2, this.viewHeight / 2, factor);
	}

	/** Hides the zoom buttons while the map is moved some other way. */
	_busy() {
		const zoom = this.canvas.id === "map-canvas" && document.getElementById("map-zoom");
		if (!zoom) return;
		zoom.classList.add("map-busy");
		clearTimeout(this._busyTimer);
		this._busyTimer = setTimeout(() => zoom.classList.remove("map-busy"), MapCanvas.BUSY_FADE_MS);
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
			this._busy();
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
				this._busy();
				this._zoomAt(pos.x, pos.y, factor);
			},
			{ passive: false }
		);

		let lastDist = 0;
		let tapAt = null;
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
					this._busy();
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
					this._busy();
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
					if (double) {
						this._busy();
						this._zoomAt(pos.x, pos.y, 1.8);
					} else this._placePinAt(pos);
				}
			}
			tapAt = null;
			this.isDragging = false;
		});
		canvas.addEventListener("touchcancel", () => {
			tapAt = null;
			this.isDragging = false;
		});

		/** Replay and review maps on the same page leave the zoom buttons and pickers alone. */
		if (this.canvas.id !== "map-canvas") return;
		document
			.getElementById("zoom-in")
			?.addEventListener("click", () => this._zoomAt(this.viewWidth / 2, this.viewHeight / 2, 1.3));
		document
			.getElementById("zoom-out")
			?.addEventListener("click", () => this._zoomAt(this.viewWidth / 2, this.viewHeight / 2, 1 / 1.3));
		const qualitySel = document.getElementById("map-quality");
		if (!qualitySel) return;
		const formatSel = document.createElement("select");
		formatSel.id = "map-format";
		formatSel.title = "Map image format";
		formatSel.className = qualitySel.className;
		formatSel.innerHTML = Object.entries(MAP_FORMATS)
			.map(([value, label]) => `<option value="${value}">${label}</option>`)
			.join("");
		formatSel.value = this.format;
		qualitySel.after(formatSel);
		avifSupported.then((ok) => {
			if (!ok) formatSel.querySelector('[value="avif"]')?.remove();
			formatSel.value = this.format;
		});
		formatSel.addEventListener("change", () => {
			this.setFormat(formatSel.value);
			formatSel.blur();
		});
		qualitySel.value = this.profile.detail;
		qualitySel.addEventListener("change", () => {
			this.setQuality(qualitySel.value);
			/** Hand the keyboard back to the game, so Space still submits a guess. */
			qualitySel.blur();
		});
	}
}

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
MapCanvas.DOUBLE_TAP_MS = 300;
/** How long the zoom buttons stay hidden after the map stops moving. */
MapCanvas.BUSY_FADE_MS = 700;
