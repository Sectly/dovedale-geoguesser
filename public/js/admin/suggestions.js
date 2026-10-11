/** Staff panel: reviewing suggested changes to locations. */

async function loadSuggestions() {
	try {
		const r = await fetch("/api/admin/suggestions");
		if (!r.ok) throw new Error();
		renderSuggestions(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load suggestions.</div>';
	}
}

function renderSuggestions(items) {
	if (!items.length) {
		el("tab-content").innerHTML = '<div class="text-zinc-500">No pending suggestions.</div>';
		return;
	}
	const typeLabel = {
		hint: "Hint",
		screenshot: "Screenshot",
		coordinates: "Coordinates",
		full_edit: "Full edit",
		removal: "Removal",
	};
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Pending Suggestions (${items.length})</h2>
        ${panelSearchInput("Search suggestion ID, location, user, type or details…")}
        <div class="flex flex-col gap-4" id="suggestions-list">
            ${items
				.map((s) => {
					let content = {};
					try {
						content = JSON.parse(s.content || "{}");
					} catch {}
					const typeTag = `<span class="text-xs bg-zinc-700 px-2 py-0.5 rounded-full">${typeLabel[s.type] || s.type}</span>`;
					const forLabel = `<span class="text-xs text-zinc-500">For: <span class="text-zinc-300">${escHtml(s.location_label || `#${s.location_id}`)}</span></span>`;
					let body = "";
					if (s.type === "hint") {
						body = `<div class="bg-yellow-900/30 border border-yellow-700/30 text-yellow-200 text-sm px-3 py-2 rounded-lg mt-2">"${escHtml(content.text || "")}"</div>`;
					} else if (s.type === "screenshot") {
						body = `<div class="flex gap-2 mt-2">
                        <div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Current</div><img loading="lazy" src="/uploads/${escHtml(s.location_image)}" class="submission-img rounded-lg" /></div>
                        <div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Suggested</div><img loading="lazy" src="/uploads/${escHtml(s.image_path)}" class="submission-img rounded-lg" /></div>
                    </div>${content.note ? `<div class="text-xs text-zinc-400 mt-1">"${escHtml(content.note)}"</div>` : ""}`;
					} else if (s.type === "removal") {
						body = `<div class="bg-red-900/20 border border-red-800/40 text-red-200 text-sm px-3 py-2 rounded-lg mt-2">
						Wants this location removed: "${escHtml(content.reason || "")}"
						<div class="text-xs text-red-200/60 mt-1">Approving deactivates the location; it can be reactivated from Locations.</div>
					</div>`;
					} else if (s.type === "full_edit") {
						const changes = [
							content.label
								? `<div><span class="text-zinc-500">Label:</span> ${escHtml(s.location_label || "(none)")} to <span class="text-zinc-100">${escHtml(content.label)}</span></div>`
								: "",
							content.world_x !== null && content.world_x !== undefined
								? `<div><span class="text-zinc-500">Pin:</span> (${Math.round(s.location_x)}, ${Math.round(s.location_y)}) to <span class="text-zinc-100">(${Math.round(content.world_x)}, ${Math.round(content.world_y)})</span></div>`
								: "",
							content.hints?.length
								? `<div><span class="text-zinc-500">Hints replaced with:</span> ${content.hints.map((h) => `"${escHtml(h)}"`).join(", ")}</div>`
								: "",
							content.note ? `<div class="text-zinc-400">"${escHtml(content.note)}"</div>` : "",
						].join("");
						body = `${
							s.image_path
								? `<div class="flex gap-2 mt-2">
							<div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Current</div><img loading="lazy" src="/uploads/${escHtml(s.location_image)}" class="submission-img rounded-lg" /></div>
							<div class="flex-1"><div class="text-xs text-zinc-500 mb-1">Suggested</div><img loading="lazy" src="/uploads/${escHtml(s.image_path)}" class="submission-img rounded-lg" /></div>
						</div>`
								: ""
						}<div class="text-xs text-zinc-300 mt-2 bg-zinc-800 rounded-lg px-3 py-2 flex flex-col gap-1">${changes || "No readable changes."}</div>`;
					} else if (s.type === "coordinates") {
						body = `<div class="text-xs text-zinc-400 mt-2 bg-zinc-800 rounded-lg px-3 py-2">
                        New coords: (${Math.round(content.world_x ?? 0)}, ${Math.round(content.world_y ?? 0)})
                        ${content.note ? `<br>"${escHtml(content.note)}"` : ""}
                    </div>`;
					}
					const searchText = [
						s.id,
						`SUG-${String(s.id).padStart(4, "0")}`,
						s.location_id,
						`LOC-${String(s.location_id).padStart(4, "0")}`,
						s.location_label,
						s.user_id,
						s.display_name,
						s.username,
						s.type,
						JSON.stringify(content),
						s.image_path,
					].join(" ");
					return `
                <div class="bg-zinc-900 rounded-2xl p-4" id="sug-${s.id}" data-search="${escHtml(searchText)}">
                    <div class="flex items-center gap-2 mb-1">
                        ${typeTag} ${forLabel}
                        <span class="ml-auto text-xs text-zinc-600">${new Date(s.created_at * 1000).toLocaleDateString()}</span>
                    </div>
                    <div class="text-sm text-zinc-400 mb-1">By: <span class="text-zinc-200">${escHtml(s.display_name || s.username)}</span> <span class="text-zinc-600">· SUG-${String(s.id).padStart(4, "0")} · LOC-${String(s.location_id).padStart(4, "0")}</span></div>
                    ${body}
                    <div class="flex gap-2 mt-3">
                        <button onclick="approveSuggestion(${s.id})" class="flex-1 bg-green-700 hover:bg-green-600 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Approve</button>
                        <button onclick="denySuggestion(${s.id})" class="flex-1 bg-red-800 hover:bg-red-700 transition px-3 py-1.5 rounded-lg text-sm font-semibold">Deny</button>
                    </div>
                </div>`;
				})
				.join("")}
            <div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No suggestions match your search.</div>
        </div>`;
	bindPanelSearch("#suggestions-list [data-search]");
}

async function approveSuggestion(id) {
	try {
		const r = await fetch(`/api/admin/suggestions/${id}/approve`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		el(`sug-${id}`)?.remove();
		refreshAttention();
		if (!el("tab-content").querySelector('[id^="sug-"]')) loadSuggestions();
	} catch (err) {
		showToast(err.message || "Failed to approve.", "error");
	}
}

function denySuggestion(id) {
	denyTargetId = null;
	denyCallback = async (reason) => {
		try {
			const r = await fetch(`/api/admin/suggestions/${id}/deny`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason }),
			});
			if (!r.ok) throw new Error(await r.text());
			el(`sug-${id}`)?.remove();
			refreshAttention();
			if (!el("tab-content").querySelector('[id^="sug-"]')) loadSuggestions();
		} catch (err) {
			showToast(err.message || "Failed to deny.", "error");
		}
	};
	el("deny-modal-title").textContent = "Deny Suggestion";
	el("deny-reason").value = "";
	el("deny-reason").dispatchEvent(new Event("input"));
	el("deny-modal").classList.remove("hidden");
}
