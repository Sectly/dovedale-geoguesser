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
		this.dragStartTime = 0;
		this.mapImages = [];
		this.mapLoadId = 0;
		this.mapInitialized = false;
		this.pin = null;
		this.pinEnabled = true;
		this.correctPin = null;
		this.replayPins = [];
		this.quality = localStorage.getItem("mapQuality") || "high";

		this._setupTransforms();
		this._setupEvents();
		this._loadImages();
		const _parent = this.canvas.parentElement || this.canvas;
		if (typeof ResizeObserver !== "undefined") {
			new ResizeObserver(() => this._handleResize()).observe(_parent);
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

	clearPin() {
		this.pin = null;
		this.correctPin = null;
		this.replayPins = [];
		this.draw();
	}

	showResult(correctX, correctY, guessX, guessY, roundNum) {
		if (roundNum !== undefined) {
			this.replayPins.push({ correctX, correctY, guessX: guessX ?? null, guessY: guessY ?? null, roundNum });
		} else {
			this.correctPin = { worldX: correctX, worldY: correctY };
			if (guessX !== undefined && guessY !== undefined) {
				this.pin = { worldX: guessX, worldY: guessY };
			}
		}
		this.draw();
	}

	setQuality(q) {
		this.quality = q;
		localStorage.setItem("mapQuality", q);
		this._loadImages();
	}

	worldToCanvas(wx, wy) {
		const relX = (wx - WORLD_BOUNDS.TOP_LEFT.x) / WORLD_WIDTH;
		const relY = (wy - WORLD_BOUNDS.TOP_LEFT.y) / WORLD_HEIGHT;
		const mapAR = MAP_CONFIG.totalWidth / MAP_CONFIG.totalHeight;
		const viewAR = this.viewWidth / this.viewHeight;
		const sf = mapAR > viewAR ? this.viewWidth / MAP_CONFIG.totalWidth : this.viewHeight / MAP_CONFIG.totalHeight;
		const sw = MAP_CONFIG.totalWidth * sf;
		const sh = MAP_CONFIG.totalHeight * sf;
		const ox = (this.viewWidth - sw) / 2;
		const oy = (this.viewHeight - sh) / 2;
		return { x: ox + relX * sw, y: oy + relY * sh };
	}

	canvasToWorld(cx, cy) {
		const mapAR = MAP_CONFIG.totalWidth / MAP_CONFIG.totalHeight;
		const viewAR = this.viewWidth / this.viewHeight;
		const sf = mapAR > viewAR ? this.viewWidth / MAP_CONFIG.totalWidth : this.viewHeight / MAP_CONFIG.totalHeight;
		const sw = MAP_CONFIG.totalWidth * sf;
		const sh = MAP_CONFIG.totalHeight * sf;
		const ox = (this.viewWidth - sw) / 2;
		const oy = (this.viewHeight - sh) / 2;
		return {
			x: WORLD_BOUNDS.TOP_LEFT.x + ((cx - ox) / sw) * WORLD_WIDTH,
			y: WORLD_BOUNDS.TOP_LEFT.y + ((cy - oy) / sh) * WORLD_HEIGHT,
		};
	}

	draw() {
		if (this.canvas.width <= 0 || this.canvas.height <= 0) return;
		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		ctx.restore();

		const mapAR = MAP_CONFIG.totalWidth / MAP_CONFIG.totalHeight;
		const viewAR = this.viewWidth / this.viewHeight;
		const sf = mapAR > viewAR ? this.viewWidth / MAP_CONFIG.totalWidth : this.viewHeight / MAP_CONFIG.totalHeight;
		const sw = MAP_CONFIG.totalWidth * sf;
		const sh = MAP_CONFIG.totalHeight * sf;
		const ox = (this.viewWidth - sw) / 2;
		const oy = (this.viewHeight - sh) / 2;
		const cw = sw / MAP_CONFIG.columns;
		const ch = sh / MAP_CONFIG.rows;

		ctx.imageSmoothingEnabled = false;
		for (let r = 0; r < MAP_CONFIG.rows; r++) {
			for (let c = 0; c < MAP_CONFIG.columns; c++) {
				const img = this.mapImages[r]?.[c];
				if (img?.complete && img.naturalWidth > 0) {
					const overlap = Math.max(0.5, 2 / this.currentScale);
					ctx.drawImage(
						img,
						0,
						0,
						img.width,
						img.height,
						ox + c * cw,
						oy + r * ch,
						cw + (c < MAP_CONFIG.columns - 1 ? overlap : 0),
						ch + (r < MAP_CONFIG.rows - 1 ? overlap : 0)
					);
				}
			}
		}
		ctx.imageSmoothingEnabled = true;

		if (this.pin) {
			this._drawPin(this.pin.worldX, this.pin.worldY, "#EF4444", null);
		}

		if (this.correctPin) {
			this._drawPin(this.correctPin.worldX, this.correctPin.worldY, "#22C55E", null);
		}

		for (const rp of this.replayPins) {
			this._drawPin(rp.correctX, rp.correctY, "#22C55E", String(rp.roundNum));
			if (rp.guessX !== null) {
				this._drawPin(rp.guessX, rp.guessY, "#EF4444", String(rp.roundNum));
			}
		}
	}

	_screenPos(worldX, worldY) {
		const cp = this.worldToCanvas(worldX, worldY);
		const t = this.ctx.getTransform();
		return {
			x: cp.x * t.a + cp.y * t.c + t.e,
			y: cp.x * t.b + cp.y * t.d + t.f,
		};
	}

	_drawPin(worldX, worldY, color, label) {
		const ctx = this.ctx;
		const cp = this.worldToCanvas(worldX, worldY);
		const t = ctx.getTransform();
		const sx = cp.x * t.a + cp.y * t.c + t.e;
		const sy = cp.x * t.b + cp.y * t.d + t.f;
		const r = 12;

		ctx.save();
		const _scale = this.currentScale;
		ctx.resetTransform();
		this.currentScale = _scale;

		ctx.beginPath();
		ctx.arc(sx, sy, r, 0, Math.PI * 2);
		ctx.fillStyle = color;
		ctx.fill();
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 2;
		ctx.stroke();

		if (label) {
			ctx.font = `bold 11px Inter, sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "#fff";
			ctx.fillText(label, sx, sy);
		}

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

	_handleResize() {
		const r = this.canvas.parentElement.getBoundingClientRect();
		if (Math.abs(r.width - this.viewWidth) < 1 && Math.abs(r.height - this.viewHeight) < 1) return;
		this._resize(r.width, r.height);
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
		this.draw();
	}

	_canvasCoords(e) {
		const r = this.canvas.getBoundingClientRect();
		if (Math.abs(r.width - this.viewWidth) > 1 || Math.abs(r.height - this.viewHeight) > 1) {
			this._resize(r.width, r.height);
		}
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	_setupEvents() {
		const canvas = this.canvas;

		canvas.addEventListener("mousedown", (e) => {
			const pos = this._canvasCoords(e);
			this.dragStart = this.ctx.transformedPoint(pos.x, pos.y);
			this.dragStartTime = Date.now();
			this.isDragging = true;
		});

		canvas.addEventListener("mousemove", (e) => {
			if (!this.isDragging) return;
			const pos = this._canvasCoords(e);
			const cur = this.ctx.transformedPoint(pos.x, pos.y);
			this.ctx.translate(cur.x - this.dragStart.x, cur.y - this.dragStart.y);
			this.draw();
		});

		canvas.addEventListener("mouseup", (e) => {
			const duration = Date.now() - this.dragStartTime;
			if (this.pinEnabled && duration < 200 && this.onPinPlaced) {
				const pos = this._canvasCoords(e);
				const pt = this.ctx.transformedPoint(pos.x, pos.y);
				const world = this.canvasToWorld(pt.x, pt.y);
				if (
					world.x >= WORLD_BOUNDS.TOP_LEFT.x &&
					world.x <= WORLD_BOUNDS.BOTTOM_RIGHT.x &&
					world.y >= WORLD_BOUNDS.TOP_LEFT.y &&
					world.y <= WORLD_BOUNDS.BOTTOM_RIGHT.y
				) {
					this.pin = { worldX: world.x, worldY: world.y };
					this.draw();
					this.onPinPlaced(world.x, world.y);
				}
			}
			this.isDragging = false;
			this.dragStart = null;
		});

		canvas.addEventListener("mouseleave", () => {
			this.isDragging = false;
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
		let touchStartTime = 0;
		let touchStartPos = null;

		canvas.addEventListener(
			"touchstart",
			(e) => {
				e.preventDefault();
				touchStartTime = Date.now();
				if (e.touches.length === 1) {
					const pos = this._canvasCoords(e.touches[0]);
					this.dragStart = this.ctx.transformedPoint(pos.x, pos.y);
					touchStartPos = pos;
					this.isDragging = true;
				} else if (e.touches.length === 2) {
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
					const cur = this.ctx.transformedPoint(pos.x, pos.y);
					this.ctx.translate(cur.x - this.dragStart.x, cur.y - this.dragStart.y);
					this.draw();
				} else if (e.touches.length === 2) {
					const dist = Math.hypot(
						e.touches[0].clientX - e.touches[1].clientX,
						e.touches[0].clientY - e.touches[1].clientY
					);
					const r = this.canvas.getBoundingClientRect();
					const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
					const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
					this._zoomAt(cx, cy, dist / lastDist);
					lastDist = dist;
				}
			},
			{ passive: false }
		);

		canvas.addEventListener("touchend", (e) => {
			if (
				this.pinEnabled &&
				e.touches.length === 0 &&
				Date.now() - touchStartTime < 200 &&
				e.changedTouches.length === 1 &&
				this.onPinPlaced
			) {
				const pos = this._canvasCoords(e.changedTouches[0]);
				const pt = this.ctx.transformedPoint(pos.x, pos.y);
				const world = this.canvasToWorld(pt.x, pt.y);
				if (
					world.x >= WORLD_BOUNDS.TOP_LEFT.x &&
					world.x <= WORLD_BOUNDS.BOTTOM_RIGHT.x &&
					world.y >= WORLD_BOUNDS.TOP_LEFT.y &&
					world.y <= WORLD_BOUNDS.BOTTOM_RIGHT.y
				) {
					this.pin = { worldX: world.x, worldY: world.y };
					this.draw();
					this.onPinPlaced(world.x, world.y);
				}
			}
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
			qualitySel.addEventListener("change", () => this.setQuality(qualitySel.value));
		}
	}
}
