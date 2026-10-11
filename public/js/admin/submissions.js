/** Staff panel: reviewing submitted locations. */

let expandedSubId = null;
let subMapCanvas = null;

async function loadSubmissions() {
	try {
		const r = await fetch("/api/admin/submissions");
		if (!r.ok) throw new Error();
		renderSubmissions(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load submissions.</div>';
	}
}

function renderSubmissions(items) {
	_lastSubmissions = items;
	if (!items.length) {
		el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
		return;
	}
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Pending Submissions (${items.length})</h2>
        ${panelSearchInput("Search submission ID, label, username or coordinates...")}
        <div class="flex flex-col gap-3" id="submissions-list">
            ${items.map(renderSubmissionRow).join("")}
            <div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No submissions match your search.</div>
        </div>`;
	bindPanelSearch("#submissions-list [data-search]");
}

function renderSubmissionRow(s) {
	const isExpanded = expandedSubId === s.id;
	const expandedHtml = isExpanded
		? `
        <div class="border-t border-zinc-800 px-4 pt-4 pb-2">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch" style="min-height:320px">
                <img loading="lazy" src="/uploads/${escHtml(s.image_path)}" alt="Submission" class="w-full rounded-xl object-cover" style="max-height:400px" />
                <div class="flex flex-col gap-2">
                    <div class="text-xs text-zinc-500 space-y-1">
                        <div>Coordinates: <span class="text-zinc-300 font-mono">${s.world_x?.toFixed(1)}, ${s.world_y?.toFixed(1)}</span></div>
                        <div>Submitted: <span class="text-zinc-300">${new Date(s.created_at * 1000).toLocaleString()}</span></div>
                        <div>By: <a href="/u/${encodeURIComponent(s.username || "")}" class="text-blue-400 hover:underline">@${escHtml(s.username || "Unknown")}</a></div>
                    </div>
                    <div class="text-xs text-zinc-500">Map location</div>
                    <div class="flex-1" style="min-height:200px">
                        <canvas id="sub-map-canvas" class="w-full h-full rounded-xl"></canvas>
                    </div>
                </div>
            </div>
        </div>`
		: "";
	const searchText = [
		s.id,
		`SUB-${String(s.id).padStart(4, "0")}`,
		s.label,
		s.username,
		s.display_name,
		s.submitted_by,
		s.world_x,
		s.world_y,
		s.image_path,
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl overflow-hidden" id="sub-${s.id}" data-search="${escHtml(searchText)}">
        <button onclick="toggleSubmission(${s.id}, ${s.world_x}, ${s.world_y})" class="w-full flex items-center gap-3 p-4 text-left hover:bg-zinc-800/50 transition">
            <img loading="lazy" src="/uploads/${escHtml(s.image_path)}" alt="" class="w-14 h-10 rounded-lg object-cover flex-shrink-0" />
            <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold truncate">${s.label ? escHtml(s.label) : '<span class="text-zinc-500 font-normal">No label</span>'}</div>
                <div class="text-xs text-zinc-500 mt-0.5">@${escHtml(s.username || "Unknown")} · ${new Date(s.created_at * 1000).toLocaleDateString()}</div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="text-xs font-mono text-zinc-600">SUB-${String(s.id).padStart(4, "0")}</span>
                <span class="material-symbols-outlined text-zinc-500 text-base transition-transform ${isExpanded ? "rotate-180" : ""}">expand_more</span>
            </div>
        </button>
        ${expandedHtml}
        ${
			isExpanded
				? `<div class="px-4 pb-4 space-y-2">
            <div>
                <label class="text-xs text-zinc-500 block mb-1">Label <span class="text-red-400/80">(required, 5-128 chars)</span></label>
                <input id="sub-label-${s.id}" type="text" value="${escHtml(s.label || "")}" placeholder="e.g. Near Dovedale Central" maxlength="128"
                    class="w-full bg-zinc-800 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
            </div>
            <div class="flex gap-2">
                <button onclick="approveSubmission(${s.id})" class="flex-1 bg-green-700 hover:bg-green-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Approve</button>
                <button onclick="openDenyModal(${s.id})" class="flex-1 bg-red-800 hover:bg-red-700 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Deny</button>
            </div>
        </div>`
				: ""
		}
    </div>`;
}

function toggleSubmission(id, worldX, worldY) {
	expandedSubId = expandedSubId === id ? null : id;
	const items = Array.from(document.querySelectorAll('[id^="sub-"]'))
		.map((n) => n.id.replace("sub-", ""))
		.map(Number);
	const allSubs = _lastSubmissions || [];
	const list = document.getElementById("submissions-list");
	if (list) list.innerHTML = allSubs.map(renderSubmissionRow).join("");
	if (expandedSubId !== null && worldX !== undefined) {
		requestAnimationFrame(() => {
			const canvas = document.getElementById("sub-map-canvas");
			if (canvas) {
				if (subMapCanvas) {
					try {
						subMapCanvas.destroy?.();
					} catch {}
				}
				subMapCanvas = new MapCanvas(canvas, {});
				subMapCanvas.setPin(worldX, worldY);
				subMapCanvas._centerOnPin?.() ?? subMapCanvas.centerOn?.(worldX, worldY);
			}
		});
	}
}

let _lastSubmissions = [];

async function approveSubmission(id) {
	const label = (document.getElementById(`sub-label-${id}`)?.value ?? "").trim();
	if (label.length < LABEL_MIN_LENGTH || label.length > LABEL_MAX_LENGTH) {
		showToast(`Label must be ${LABEL_MIN_LENGTH}-${LABEL_MAX_LENGTH} characters.`, "error");
		document.getElementById(`sub-label-${id}`)?.focus();
		return;
	}
	try {
		const r = await fetch(`/api/admin/submissions/${id}/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ label }),
		});
		if (!r.ok) throw new Error(await r.text());
		_lastSubmissions = _lastSubmissions.filter((s) => s.id !== id);
		if (expandedSubId === id) expandedSubId = null;
		if (!_lastSubmissions.length) {
			el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
			return;
		}
		const list = document.getElementById("submissions-list");
		if (list) list.innerHTML = _lastSubmissions.map(renderSubmissionRow).join("");
		else loadSubmissions();
		refreshAttention();
	} catch (err) {
		showToast(err.message || "Failed to approve.", "error");
	}
}

function openDenyModal(id) {
	denyTargetId = id;
	denyCallback = null;
	el("deny-modal-title").textContent = "Deny Submission";
	el("deny-reason").value = "";
	el("deny-reason").dispatchEvent(new Event("input"));
	el("deny-modal").classList.remove("hidden");
}

async function denySubmission(id, reason) {
	try {
		const r = await fetch(`/api/admin/submissions/${id}/deny`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
		if (!r.ok) throw new Error(await r.text());
		_lastSubmissions = _lastSubmissions.filter((s) => s.id !== id);
		if (expandedSubId === id) expandedSubId = null;
		if (!_lastSubmissions.length) {
			el("tab-content").innerHTML = '<div class="text-zinc-500">No pending submissions.</div>';
			return;
		}
		const list = document.getElementById("submissions-list");
		if (list) list.innerHTML = _lastSubmissions.map(renderSubmissionRow).join("");
		else loadSubmissions();
		refreshAttention();
	} catch (err) {
		showToast(err.message || "Failed to deny.", "error");
	}
}
