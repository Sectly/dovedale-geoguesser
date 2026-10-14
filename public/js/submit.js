let currentUser = null,
	mapCanvas = null,
	pinWorld = null,
	suggestPinWorld = null,
	fePin = null;
let selectedFile = null,
	suggestFile = null,
	feFile = null,
	mode = "new";
let selectedLocId = null,
	selectedLocLabel = null,
	suggestType = "hint";
let allLocations = [],
	allLocPins = [],
	showingPins = false,
	_allLocPinsCache = [];

async function init() {
	currentUser = await fetchUser();
	if (!currentUser) {
		el("login-gate").classList.remove("hidden");
		el("form-panel").classList.add("hidden");
		return;
	}

	mapCanvas = new MapCanvas(el("map-canvas"), {
		onPinPlaced: (wx, wy) => {
			if (showingPins && mode === "suggest") {
				const hit = findNearestPin(wx, wy);
				if (hit) {
					selectLocation(hit.id, hit.label);
					return;
				}
			}
			if (mode === "new") {
				pinWorld = { x: wx, y: wy };
				updateStep3(true);
				el("map-hint").textContent = "Pin placed. Click to move";
				showFineControls("new-fine-slot");
				checkReady();
			} else if (mode === "suggest" && suggestType === "coordinates") {
				suggestPinWorld = { x: wx, y: wy };
				drawCorrectionLine(wx, wy);
				el("sug-pin-status").innerHTML =
					'<span class="material-symbols-outlined text-base text-zinc-300">check_circle</span><span class="text-zinc-300">Correction placed (green = original, red = yours)</span>';
				el("map-hint").textContent = "Green = original, red = your correction";
				showFineControls("sug-fine-slot");
				checkSuggestReady();
			} else if (mode === "suggest" && suggestType === "full_edit") {
				fePin = { x: wx, y: wy };
				drawCorrectionLine(wx, wy);
				el("fe-pin-status").innerHTML =
					'<span class="material-symbols-outlined text-base text-green-400">check_circle</span><span class="text-green-400">Position set</span>';
				checkSuggestReady();
			}
		},
	});
	const _origDraw = mapCanvas.draw.bind(mapCanvas);
	mapCanvas.draw = function () {
		_origDraw();
		if (!showingPins || !allLocPins.length) return;
		const ctx = mapCanvas.ctx;
		const t = ctx.getTransform();
		const vw = mapCanvas.viewWidth;
		const vh = mapCanvas.viewHeight;
		const R = 7;
		const PAD = R + 2;

		const visible = [];
		for (const loc of allLocPins) {
			const cp = mapCanvas.worldToCanvas(loc.world_x, loc.world_y);
			const sx = cp.x * t.a + cp.y * t.c + t.e;
			const sy = cp.x * t.b + cp.y * t.d + t.f;
			if (sx < -PAD || sx > vw + PAD || sy < -PAD || sy > vh + PAD) continue;
			visible.push({ id: loc.id, sx, sy });
		}
		if (!visible.length) return;

		ctx.save();
		ctx.resetTransform();

		ctx.fillStyle = "#f97316";
		ctx.beginPath();
		for (const { sx, sy } of visible) {
			ctx.moveTo(sx + R, sy);
			ctx.arc(sx, sy, R, 0, Math.PI * 2);
		}
		ctx.fill();

		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		for (const { sx, sy } of visible) {
			ctx.moveTo(sx + R, sy);
			ctx.arc(sx, sy, R, 0, Math.PI * 2);
		}
		ctx.stroke();

		if (t.a >= 1.5) {
			ctx.fillStyle = "#fff";
			ctx.font = "bold 10px Inter, sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			for (const { id, sx, sy } of visible) {
				ctx.fillText(String(id), sx, sy);
			}
		}

		ctx.restore();
	};

	el("label-input").addEventListener("input", checkReady);
	el("file-input").addEventListener("change", onFileChange);
	el("upload-area").addEventListener("dragover", (e) => {
		e.preventDefault();
		el("upload-area").classList.add("border-zinc-400");
	});
	el("upload-area").addEventListener("dragleave", () => el("upload-area").classList.remove("border-zinc-400"));
	el("upload-area").addEventListener("drop", (e) => {
		e.preventDefault();
		el("upload-area").classList.remove("border-zinc-400");
		const f = e.dataTransfer.files[0];
		if (f) {
			el("file-input").files = e.dataTransfer.files;
			onFileChange();
		}
	});
	el("clear-file").addEventListener("click", (e) => {
		e.preventDefault();
		clearFile();
	});
	el("submit-btn").addEventListener("click", submitLocation);
	el("submit-another-btn").addEventListener("click", resetNew);
	el("add-hint-btn").addEventListener("click", addHintField);
	el("mode-new").addEventListener("click", () => switchMode("new"));
	el("mode-suggest").addEventListener("click", () => switchMode("suggest"));
	el("suggest-back").addEventListener("click", () => {
		el("suggest-form").style.display = "none";
		el("suggest-pick").style.display = "flex";
		el("suggest-cur-img-wrap").style.display = "none";
		selectedLocId = null;
		suggestPinWorld = null;
		fePin = null;
		feFile = null;
		el("map-hint").textContent = showingPins
			? "Click a pin to select a location"
			: "Click the map to mark the location";
		mapCanvas.pin = null;
		mapCanvas.correctPin = null;
		mapCanvas.draw();
		redrawPins();
	});
	el("loc-grid").addEventListener("click", (e) => {
		const card = e.target.closest(".loc-card");
		if (card) selectLocation(Number(card.dataset.id), card.dataset.label || "");
	});
	el("suggest-cur-img").addEventListener("click", () => {
		el("suggest-lightbox").style.display = "flex";
	});
	el("suggest-cur-img-zoom").addEventListener("click", (e) => {
		e.stopPropagation();
		el("suggest-lightbox").style.display = "flex";
	});
	document
		.querySelectorAll(".sug-type-btn")
		.forEach((btn) => btn.addEventListener("click", () => switchSuggestType(btn.dataset.type)));
	el("sug-file-input").addEventListener("change", onSugFileChange);
	el("fe-file-input").addEventListener("change", onFeFileChange);
	el("fe-add-hint-btn").addEventListener("click", addFeHintField);
	el("suggest-submit-btn").addEventListener("click", submitSuggestion);
	el("suggest-search").addEventListener("input", filterLocations);
	el("sug-hint-text").addEventListener("input", checkSuggestReady);
	el("fe-label-input").addEventListener("input", checkSuggestReady);
	el("sug-removal-reason").addEventListener("input", checkSuggestReady);
	el("policy-agree-btn").addEventListener("click", onPolicyAgree);
	el("pin-toggle-btn").addEventListener("click", togglePinView);
	loadLocations();
}

/** When the policy was last agreed to on this device; 0 when never, or when storage is blocked. */
const _policyTs = (() => {
	try {
		return parseInt(localStorage.getItem("suggest_policy_agreed") || "0");
	} catch {
		return 0;
	}
})();
let _policyAgreed = !!_policyTs && Date.now() - _policyTs < 24 * 60 * 60 * 1000;

/** Draws a line from where the location is now to where the suggested pin puts it. */
function drawCorrectionLine(toX, toY) {
	const current = _allLocPinsCache.find((l) => l.id === selectedLocId);
	mapCanvas.guessLines = [];
	if (current) mapCanvas.addGuessLine(current.world_x, current.world_y, toX, toY, "#42A5F5");
}

function switchMode(m) {
	mode = m;
	el("mode-new").className =
		"flex-1 py-2.5 text-sm font-semibold transition border-b-2 " +
		(m === "new" ? "bg-zinc-800 text-white border-blue-500" : "text-zinc-400 hover:text-white border-transparent");
	el("mode-suggest").className =
		"flex-1 py-2.5 text-sm font-semibold transition border-b-2 " +
		(m === "suggest"
			? "bg-zinc-800 text-white border-blue-500"
			: "text-zinc-400 hover:text-white border-transparent");
	el("panel-new").style.display = m === "new" ? "flex" : "none";
	el("panel-suggest").style.display = m === "suggest" ? "flex" : "none";
	el("map-hint").textContent = "Click the map to mark the location";
	mapCanvas.clearPin();
	pinWorld = null;
	suggestPinWorld = null;
	fePin = null;
	feFile = null;
	el("fine-controls").classList.add("hidden");
	showingPins = false;
	el("pin-toggle-icon").textContent = "pin_drop";
	el("pin-toggle-btn").classList.remove("border-blue-500", "bg-blue-900/30");
	allLocPins = [];
	if (m === "suggest") showSuggestGateOrPick();
}

let _eligibility = null;

/** What is still needed before suggestions open, as two bars. */
function suggestProgressHtml(progress) {
	if (!progress) return "";
	const bar = (label, { have, need }, unit) => {
		const done = have >= need;
		return `<div>
			<div class="flex items-baseline justify-between text-xs mb-1">
				<span class="${done ? "text-green-400" : "text-zinc-300"}">${label}</span>
				<span class="text-zinc-500">${done ? "Done" : `${have} of ${need} ${unit}`}</span>
			</div>
			<div class="h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div class="h-full rounded-full ${done ? "bg-green-500" : "bg-blue-500"}" style="width:${Math.min(100, (have / need) * 100)}%"></div></div>
		</div>`;
	};
	return bar("Account age", progress.days, "days") + bar("Solo or daily games played", progress.games, "games");
}

/** Suggesting changes shows where every location is, so it is only open to established players. */
async function showSuggestGateOrPick() {
	for (const id of ["suggest-policy-gate", "suggest-pick", "suggest-form", "suggest-locked"])
		el(id).style.display = "none";
	try {
		_eligibility ??= await api("/api/suggestions/eligibility");
	} catch (err) {
		_eligibility = { eligible: false, reason: err.message };
	}
	if (mode !== "suggest") return;
	if (!_eligibility.eligible) {
		el("suggest-locked-reason").textContent = _eligibility.progress ? "" : _eligibility.reason;
		el("suggest-locked-progress").innerHTML = suggestProgressHtml(_eligibility.progress);
		el("suggest-locked").style.display = "flex";
		return;
	}
	/** The policy has to be accepted on the account; the 24-hour reminder is on top of that. */
	if (!_eligibility.agreed) _policyAgreed = false;
	if (_policyAgreed) {
		el("suggest-policy-gate").style.display = "none";
		el("suggest-form").style.display = "none";
		el("suggest-pick").style.display = "flex";
		prefetchLocPins();
	} else {
		el("suggest-policy-gate").style.display = "flex";
		el("suggest-pick").style.display = "none";
		el("suggest-form").style.display = "none";
	}
}

async function onPolicyAgree() {
	_policyAgreed = true;
	try {
		localStorage.setItem("suggest_policy_agreed", String(Date.now()));
	} catch {}
	try {
		await api("/api/suggestions/agree", { method: "POST" });
		if (_eligibility) _eligibility.agreed = true;
	} catch (err) {
		showToast(err.message, "error");
	}
	el("suggest-policy-gate").style.display = "none";
	el("suggest-pick").style.display = "flex";
	prefetchLocPins();
}

async function prefetchLocPins() {
	if (_allLocPinsCache.length) return;
	try {
		_allLocPinsCache = await api("/api/locations/with-coords");
	} catch {}
}

function updateStep(id, state) {
	const div = el(id);
	div.className = div.className.replace(/step-\w+/g, "") + " step-" + state;
}

function updateStep3(done) {
	const status = el("pin-status");
	if (done) {
		status.innerHTML =
			'<span class="material-symbols-outlined text-base text-green-400">check_circle</span><span class="text-green-400">Pin placed</span>';
		updateStep("step3", "done");
	} else {
		status.innerHTML =
			'<span class="material-symbols-outlined text-base">location_on</span>Click the map to place a pin';
		updateStep("step3", "active");
	}
}

function addHintField() {
	const list = el("hints-list");
	if (list.children.length >= 3) return;
	const idx = list.children.length;
	const wrap = document.createElement("div");
	wrap.className = "flex items-center gap-2";
	const inp = document.createElement("input");
	inp.type = "text";
	inp.maxLength = 150;
	inp.placeholder = "Hint " + (idx + 1);
	inp.className =
		"flex-1 bg-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600";
	const removeBtn = document.createElement("button");
	removeBtn.className = "text-zinc-500 hover:text-red-400 transition flex-shrink-0";
	removeBtn.innerHTML = '<span class="material-symbols-outlined text-base">close</span>';
	removeBtn.addEventListener("click", () => {
		wrap.remove();
		if (list.children.length < 3) el("add-hint-btn").style.display = "";
	});
	wrap.appendChild(inp);
	wrap.appendChild(removeBtn);
	list.appendChild(wrap);
	if (list.children.length >= 3) el("add-hint-btn").style.display = "none";
}

function getHints() {
	return Array.from(el("hints-list").querySelectorAll("input"))
		.map((i) => i.value.trim())
		.filter(Boolean);
}

function onFileChange() {
	const file = el("file-input").files[0];
	if (!file) return;
	if (file.size > 8 * 1024 * 1024) {
		showError("File too large (max 8MB).");
		return;
	}
	hideError();
	selectedFile = file;
	el("preview-img").src = URL.createObjectURL(file);
	el("preview-container").classList.remove("hidden");
	el("upload-icon").textContent = "photo";
	el("upload-label-text").textContent = file.name;
	updateStep("step1", "done");
	updateStep("step2", "active");
	updateStep("step3", pinWorld ? "done" : "active");
	checkReady();
}

function clearFile() {
	selectedFile = null;
	el("file-input").value = "";
	el("preview-container").classList.add("hidden");
	el("upload-icon").textContent = "upload";
	el("upload-label-text").textContent = "Click to upload or drag & drop";
	updateStep("step1", "idle");
	checkReady();
}

const LABEL_MIN = 5;
const LABEL_MAX = 128;

function getLabel() {
	return el("label-input").value.trim();
}

function isLabelValid() {
	const len = getLabel().length;
	return len >= LABEL_MIN && len <= LABEL_MAX;
}

function updateLabelHint() {
	const hint = el("label-hint");
	const len = getLabel().length;
	if (len === 0) {
		hint.className = "text-zinc-600 text-xs mt-1";
		hint.textContent = "Required · 5-128 characters. Describe where the photo was taken.";
	} else if (len < LABEL_MIN) {
		hint.className = "text-red-400 text-xs mt-1";
		hint.textContent = `Label is too short - ${LABEL_MIN - len} more character${LABEL_MIN - len === 1 ? "" : "s"} needed.`;
	} else {
		hint.className = "text-zinc-600 text-xs mt-1";
		hint.textContent = `${len}/${LABEL_MAX} characters`;
	}
}

function checkReady() {
	updateLabelHint();
	el("submit-btn").disabled = !(selectedFile && pinWorld && isLabelValid());
}
function showError(msg) {
	el("submit-error").textContent = msg;
	el("submit-error").classList.remove("hidden");
}
function hideError() {
	el("submit-error").classList.add("hidden");
}

async function submitLocation() {
	if (!selectedFile || !pinWorld) return;
	const label = getLabel();
	if (!isLabelValid()) {
		showError(`Label must be between ${LABEL_MIN} and ${LABEL_MAX} characters.`);
		el("label-input").focus();
		return;
	}
	el("submit-btn").disabled = true;
	el("submit-btn").textContent = "Submitting...";
	hideError();
	const fd = new FormData();
	fd.append("image", selectedFile);
	fd.append("world_x", String(pinWorld.x));
	fd.append("world_y", String(pinWorld.y));
	fd.append("label", label);
	const hints = getHints();
	fd.append("hints", JSON.stringify(hints));
	try {
		await api("/api/submissions", { body: fd });
		el("success-title").textContent = "Submitted";
		el("success-msg").textContent = "Submitted for review.";
		el("success-screen").classList.remove("hidden");
	} catch (err) {
		showError(err.message || "Submission failed. Please try again.");
		el("submit-btn").disabled = false;
		el("submit-btn").textContent = "Submit for review";
	}
}

function resetNew() {
	el("success-screen").classList.add("hidden");
	selectedFile = null;
	pinWorld = null;
	el("file-input").value = "";
	el("preview-container").classList.add("hidden");
	el("upload-icon").textContent = "upload";
	el("upload-label-text").textContent = "Click to upload or drag & drop";
	el("label-input").value = "";
	el("hints-list").innerHTML = "";
	el("add-hint-btn").style.display = "";
	el("submit-btn").textContent = "Submit for review";
	updateStep("step1", "idle");
	updateStep("step2", "idle");
	updateStep("step3", "idle");
	updateStep3(false);
	el("map-hint").textContent = "Click the map to mark the location";
	mapCanvas.clearPin();
	checkReady();
}

async function loadLocations() {
	try {
		allLocations = await api("/api/locations");
		renderLocGrid(allLocations);
	} catch {
		el("loc-grid").innerHTML = errorStateHtml("Couldn't load the locations.");
	}
}

function renderLocGrid(locs) {
	if (!locs.length) {
		el("loc-grid").innerHTML = '<div class="text-zinc-500 text-sm">No locations found.</div>';
		return;
	}
	el("loc-grid").innerHTML = locs
		.map((l) => {
			const labelHtml = l.label ? escHtml(l.label) : '<span class="text-zinc-500">Unlabelled</span>';
			return (
				'<div class="loc-card border border-zinc-800 rounded-xl overflow-hidden flex items-center gap-3 p-2' +
				(selectedLocId === l.id ? " selected" : "") +
				'" data-id="' +
				l.id +
				'" data-label="' +
				escHtml(l.label || "") +
				'">' +
				'<img loading="lazy" decoding="async" alt="" src="/uploads/' +
				escHtml(l.image_path) +
				'" class="w-16 h-10 object-cover rounded-lg flex-shrink-0 bg-zinc-800" />' +
				'<div class="min-w-0"><div class="text-sm font-medium truncate">' +
				labelHtml +
				'</div><div class="text-xs text-zinc-500">ID #' +
				l.id +
				"</div></div>" +
				"</div>"
			);
		})
		.join("");
}

function filterLocations() {
	const q = el("suggest-search").value.toLowerCase();
	renderLocGrid(allLocations.filter((l) => (l.label || "").toLowerCase().includes(q) || String(l.id).includes(q)));
}

function selectLocation(id, label) {
	selectedLocId = id;
	selectedLocLabel = label || "Location #" + id;
	el("suggest-for-label").textContent = selectedLocLabel;
	el("suggest-pick").style.display = "none";
	el("suggest-form").style.display = "flex";
	const locMeta = allLocations.find((l) => l.id === id);
	if (locMeta) {
		const src = "/uploads/" + escHtml(locMeta.image_path);
		el("suggest-cur-img").src = src;
		el("suggest-lightbox-img").src = src;
		el("suggest-cur-img-wrap").style.display = "block";
	} else {
		el("suggest-cur-img-wrap").style.display = "none";
	}
	switchSuggestType("hint");
	suggestPinWorld = null;
	showingPins = false;
	el("pin-toggle-btn").querySelector("span").textContent = "pin_drop";
	el("pin-toggle-btn").querySelector("span").className = "material-symbols-outlined text-base text-zinc-400";
	el("pin-toggle-btn").classList.remove("border-blue-500", "bg-blue-900/30");
	allLocPins = [];
	const locData = _allLocPinsCache.find((l) => l.id === id);
	if (locData) {
		mapCanvas.pin = null;
		mapCanvas.correctPin = { worldX: locData.world_x, worldY: locData.world_y };
		mapCanvas.draw();
		el("map-hint").textContent = "Green = current location. Click to place correction";
	} else {
		mapCanvas.clearPin();
		el("map-hint").textContent = "Click the map to mark the location";
	}
}

function switchSuggestType(type) {
	suggestType = type;
	document.querySelectorAll(".sug-type-btn").forEach((btn) => {
		const active = btn.dataset.type === type;
		btn.className =
			"sug-type-btn flex-1 py-1.5 rounded-lg text-xs font-semibold transition " +
			(active ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white");
	});
	el("sug-hint-form").style.display = type === "hint" ? "flex" : "none";
	el("sug-screenshot-form").style.display = type === "screenshot" ? "flex" : "none";
	el("sug-coordinates-form").style.display = type === "coordinates" ? "flex" : "none";
	el("sug-full-edit-form").style.display = type === "full_edit" ? "flex" : "none";
	el("sug-removal-form").style.display = type === "removal" ? "flex" : "none";
	if (type === "coordinates" || type === "full_edit") {
		const locData = _allLocPinsCache.find((l) => l.id === selectedLocId);
		if (locData) {
			mapCanvas.pin = null;
			mapCanvas.correctPin = { worldX: locData.world_x, worldY: locData.world_y };
			mapCanvas.draw();
			const existPin = type === "coordinates" ? suggestPinWorld : fePin;
			el("map-hint").textContent = existPin
				? "Correction placed. Click to move"
				: "Green = current location. Click to place correction";
		} else {
			el("map-hint").textContent = "Click the map to mark the corrected location";
		}
	} else {
		mapCanvas.correctPin = null;
		mapCanvas.pin = null;
		mapCanvas.draw();
		el("map-hint").textContent = "Click the map to mark the location";
	}
	if (suggestPinWorld && type === "coordinates") {
		mapCanvas.pin = { worldX: suggestPinWorld.x, worldY: suggestPinWorld.y };
		mapCanvas.draw();
		showFineControls("sug-fine-slot");
	} else {
		el("fine-controls").classList.add("hidden");
	}
	checkSuggestReady();
}

function onSugFileChange() {
	const file = el("sug-file-input").files[0];
	if (!file) return;
	if (file.size > 8 * 1024 * 1024) {
		el("suggest-error").textContent = "File too large.";
		el("suggest-error").classList.remove("hidden");
		return;
	}
	suggestFile = file;
	el("sug-preview-img").src = URL.createObjectURL(file);
	el("sug-preview-wrap").classList.remove("hidden");
	el("sug-img-icon").textContent = "photo";
	el("sug-img-label").textContent = file.name;
	checkSuggestReady();
}

function checkSuggestReady() {
	let ready = false;
	if (suggestType === "hint") ready = !!el("sug-hint-text").value.trim();
	if (suggestType === "screenshot") ready = !!suggestFile;
	if (suggestType === "coordinates") ready = !!suggestPinWorld;
	if (suggestType === "full_edit") {
		const hasChange =
			!!feFile ||
			!!fePin ||
			!!el("fe-label-input").value.trim() ||
			el("fe-hints-list").querySelectorAll("input").length > 0;
		ready = hasChange;
	}
	if (suggestType === "removal") ready = !!el("sug-removal-reason").value.trim();
	el("suggest-submit-btn").disabled = !ready;
}

async function submitSuggestion() {
	if (!selectedLocId) return;
	el("suggest-submit-btn").disabled = true;
	el("suggest-submit-btn").textContent = "Submitting...";
	el("suggest-error").classList.add("hidden");
	try {
		const url = "/api/locations/" + selectedLocId + "/suggest";
		if (suggestType === "screenshot") {
			if (!suggestFile) throw new Error("No screenshot selected.");
			const fd = new FormData();
			fd.append("image", suggestFile);
			const note = el("sug-screenshot-note").value.trim();
			if (note) fd.append("note", note);
			await api(url, { body: fd });
		} else if (suggestType === "hint") {
			const text = el("sug-hint-text").value.trim();
			if (!text) throw new Error("Hint text is required.");
			await api(url, { json: { type: "hint", text } });
		} else if (suggestType === "coordinates") {
			if (!suggestPinWorld) throw new Error("Please place a pin on the map.");
			const note = el("sug-coordinates-note").value.trim();
			await api(url, {
				json: { type: "coordinates", world_x: suggestPinWorld.x, world_y: suggestPinWorld.y, note },
			});
		} else if (suggestType === "full_edit") {
			const fd = new FormData();
			fd.append("type", "full_edit");
			if (feFile) fd.append("image", feFile);
			if (fePin) {
				fd.append("world_x", String(fePin.x));
				fd.append("world_y", String(fePin.y));
			}
			const feLabel = el("fe-label-input").value.trim();
			if (feLabel) fd.append("label", feLabel);
			const feHints = Array.from(el("fe-hints-list").querySelectorAll("input"))
				.map((i) => i.value.trim())
				.filter(Boolean);
			fd.append("hints", JSON.stringify(feHints));
			const feNote = el("fe-note").value.trim();
			if (feNote) fd.append("note", feNote);
			await api(url, { body: fd });
		} else if (suggestType === "removal") {
			const reason = el("sug-removal-reason").value.trim();
			if (!reason) throw new Error("Reason is required.");
			await api(url, { json: { type: "removal", reason } });
		}
		el("success-title").textContent = "Suggestion submitted";
		el("success-msg").textContent = "Suggestion submitted for review.";
		el("success-screen").classList.remove("hidden");
	} catch (err) {
		el("suggest-error").textContent = err.message || "Failed. Please try again.";
		el("suggest-error").classList.remove("hidden");
		el("suggest-submit-btn").disabled = false;
		el("suggest-submit-btn").textContent = "Submit suggestion";
	}
}

function onFeFileChange() {
	const file = el("fe-file-input").files[0];
	if (!file) return;
	if (file.size > 8 * 1024 * 1024) {
		el("suggest-error").textContent = "File too large.";
		el("suggest-error").classList.remove("hidden");
		return;
	}
	feFile = file;
	el("fe-preview-img").src = URL.createObjectURL(file);
	el("fe-preview-wrap").classList.remove("hidden");
	el("fe-img-icon").textContent = "photo";
	el("fe-img-label").textContent = file.name;
	checkSuggestReady();
}

function addFeHintField() {
	const list = el("fe-hints-list");
	if (list.children.length >= 3) return;
	const idx = list.children.length;
	const wrap = document.createElement("div");
	wrap.className = "flex items-center gap-2";
	const inp = document.createElement("input");
	inp.type = "text";
	inp.maxLength = 150;
	inp.placeholder = "Hint " + (idx + 1);
	inp.className =
		"flex-1 bg-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600";
	inp.addEventListener("input", checkSuggestReady);
	const removeBtn = document.createElement("button");
	removeBtn.className = "text-zinc-500 hover:text-red-400 transition flex-shrink-0";
	removeBtn.innerHTML = '<span class="material-symbols-outlined text-base">close</span>';
	removeBtn.addEventListener("click", () => {
		wrap.remove();
		if (list.children.length < 3) el("fe-add-hint-btn").style.display = "";
		checkSuggestReady();
	});
	wrap.appendChild(inp);
	wrap.appendChild(removeBtn);
	list.appendChild(wrap);
	if (list.children.length >= 3) el("fe-add-hint-btn").style.display = "none";
	checkSuggestReady();
}

function _setPinToggleIcon(name, color) {
	const span = el("pin-toggle-btn").querySelector("span");
	span.textContent = name;
	span.className = "material-symbols-outlined text-base " + color;
}

async function togglePinView() {
	if (showingPins) {
		showingPins = false;
		allLocPins = [];
		_setPinToggleIcon("pin_drop", "text-zinc-400");
		el("pin-toggle-btn").classList.remove("border-blue-500", "bg-blue-900/30");
		mapCanvas.draw();
		return;
	}
	_setPinToggleIcon("hourglass_empty", "text-zinc-400");
	try {
		if (!_allLocPinsCache.length) {
			_allLocPinsCache = await api("/api/locations/with-coords");
		}
		allLocPins = _allLocPinsCache;
		showingPins = true;
		_setPinToggleIcon("location_on", "text-orange-400");
		el("pin-toggle-btn").classList.add("border-blue-500", "bg-blue-900/30");
		el("map-hint").textContent = "Click a pin to select a location";
		mapCanvas.draw();
	} catch (err) {
		_setPinToggleIcon("pin_drop", "text-zinc-400");
		showToast(err.message, "error");
	}
}

function findNearestPin(wx, wy) {
	const THRESHOLD_PX = 22;
	const t = mapCanvas.ctx.getTransform();
	const clickC = mapCanvas.worldToCanvas(wx, wy);
	const clickSx = clickC.x * t.a + clickC.y * t.c + t.e;
	const clickSy = clickC.x * t.b + clickC.y * t.d + t.f;
	let best = null,
		bestDist = THRESHOLD_PX;
	for (const loc of allLocPins) {
		const cp = mapCanvas.worldToCanvas(loc.world_x, loc.world_y);
		const sx = cp.x * t.a + cp.y * t.c + t.e;
		const sy = cp.x * t.b + cp.y * t.d + t.f;
		const dist = Math.sqrt((sx - clickSx) ** 2 + (sy - clickSy) ** 2);
		if (dist < bestDist) {
			bestDist = dist;
			best = loc;
		}
	}
	return best;
}

function redrawPins() {
	if (mapCanvas) mapCanvas.draw();
}

el("panel-new").style.display = "flex";
el("panel-suggest").style.display = "none";

/** Fills the form back in when arriving from "Fix and send again" on a denied submission. */
function prefillResend() {
	const params = new URLSearchParams(location.search);
	if (!mapCanvas || !params.has("label")) return;
	el("label-input").value = params.get("label").slice(0, 128);
	for (const hint of params.getAll("hint").slice(0, 3)) {
		addHintField();
		const input = el("hints-list").lastElementChild?.querySelector("input");
		if (input) input.value = hint.slice(0, 150);
	}
	const x = parseFloat(params.get("x"));
	const y = parseFloat(params.get("y"));
	if (Number.isFinite(x) && Number.isFinite(y)) {
		pinWorld = { x, y };
		mapCanvas.setPin(x, y);
		mapCanvas.fitTo([{ x, y }]);
		updateStep3(true);
		showFineControls("new-fine-slot");
		el("map-hint").textContent = "Pin placed. Click to move";
	}
	checkReady();
	showToast("Choose a new screenshot, then send it again.");
	history.replaceState(null, "", location.pathname);
}

init().then(prefillResend);

/** One set of fine controls serves both forms: it is moved under whichever pin it is steering. */
function showFineControls(slotId) {
	const controls = el("fine-controls");
	el(slotId).after(controls);
	controls.classList.remove("hidden");
}

/** The pin the fine controls move: a new location's, or the correction in Suggest Change. */
function nudgeTarget() {
	if (mode === "new") return pinWorld;
	return mode === "suggest" && suggestType === "coordinates" ? suggestPinWorld : null;
}

function nudgePin(dx, dy) {
	const pin = nudgeTarget();
	if (!pin) return;
	const step = parseInt(el("fine-increment").value) || 10;
	pin.x = Math.max(-23818, Math.min(14911, pin.x + dx * step));
	pin.y = Math.max(-10426, Math.min(13693, pin.y + dy * step));
	mapCanvas.setPin(pin.x, pin.y);
	if (pin === suggestPinWorld) drawCorrectionLine(pin.x, pin.y);
}

document.querySelectorAll(".fine-btn").forEach((btn) => {
	btn.addEventListener("click", () => {
		const dir = btn.dataset.dir;
		if (dir === "up") nudgePin(0, -1);
		if (dir === "down") nudgePin(0, 1);
		if (dir === "left") nudgePin(-1, 0);
		if (dir === "right") nudgePin(1, 0);
	});
});

document.addEventListener("keydown", (e) => {
	if (!nudgeTarget()) return;
	const tag = document.activeElement?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	if (e.key === "ArrowUp") {
		e.preventDefault();
		nudgePin(0, -1);
	}
	if (e.key === "ArrowDown") {
		e.preventDefault();
		nudgePin(0, 1);
	}
	if (e.key === "ArrowLeft") {
		e.preventDefault();
		nudgePin(-1, 0);
	}
	if (e.key === "ArrowRight") {
		e.preventDefault();
		nudgePin(1, 0);
	}
});
