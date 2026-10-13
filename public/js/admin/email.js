/** Staff panel: the Email tab. The mail server, switching email on and off, and how it is going. */

const EMAIL_STATE_LABELS = {
	hourly: "Every hour",
	daily: "Once a day",
	weekly: "Once a week",
	monthly: "Once a month",
	off: "Confirmed, switched off",
	waiting: "Waiting to be confirmed",
};

/** Draws the tab. The mail server's details stay off the page until `reveal` asks for them. */
async function loadEmail(reveal = false) {
	let info;
	try {
		info = await api(`/api/admin/system/email${reveal ? "?reveal=1" : ""}`);
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load the email settings.", "loadEmail()");
		return;
	}
	const { stats, audience } = info;
	const live = info.configured && info.enabled;
	const subscribers = ["hourly", "daily", "weekly", "monthly"].reduce((sum, key) => sum + (audience[key] ?? 0), 0);
	const stat = (label, value, sub = "") =>
		`<div class="bg-zinc-800/60 rounded-xl px-3.5 py-2.5"><div class="text-xs text-zinc-500">${label}</div><div class="font-semibold mt-0.5">${value}</div>${sub ? `<div class="text-xs text-zinc-500 mt-0.5">${sub}</div>` : ""}</div>`;
	const status = !info.smtp_ready
		? ['<span class="m-tag">Not set up</span>', "Email is off. Players do not see the setting."]
		: info.enabled
			? [
					'<span class="m-tag success">On</span>',
					"Players can add an address in Settings and choose how often to get a summary.",
				]
			: [
					'<span class="m-tag warn">Off</span>',
					"Nothing is sent, and the setting is hidden from players. Addresses already saved are kept.",
				];
	/** Why the switch cannot be used, when it cannot. */
	const blocked = !info.smtp_ready
		? "Save a mail server below first. Email cannot be switched on without one."
		: !info.site_url
			? "SITE_URL is not set on the server. Email cannot be switched on without it, because the links inside would lead nowhere."
			: "";
	const saved = Object.values(audience).reduce((sum, n) => sum + n, 0);

	el("tab-content").innerHTML = `
		<h2 class="font-bold text-lg mb-1">Email</h2>
		<p class="text-zinc-500 text-xs mb-4">Players can ask for one email with their unread notifications: hourly, daily, weekly or monthly. Never one email per notification.</p>

		${systemCard(
			"Status",
			"mark_email_read",
			`<div class="flex items-center gap-3">
				<div class="flex-1 min-w-0 text-sm text-zinc-400">${status[1]}</div>
				<button onclick="setEmailEnabled(${!info.enabled})" class="m-btn ${info.enabled ? "m-btn-tonal" : "m-btn-filled"} m-btn-sm flex-shrink-0" ${blocked && !info.enabled ? "disabled" : ""}><span class="material-symbols-outlined">power_settings_new</span>${info.enabled ? "Switch email off" : "Switch email on"}</button>
			</div>
			${blocked ? `<p class="text-xs text-amber-300 mt-2 flex items-start gap-1.5"><span class="material-symbols-outlined text-sm leading-4">warning</span>${blocked}</p>` : ""}
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
				${stat("Sent today", stats.today.toLocaleString(), `of ${info.daily_max.toLocaleString()} allowed a day`)}
				${stat("Sent in all", stats.total.toLocaleString())}
				${stat("Last sent", stats.last_sent_at ? `${shortAgo(stats.last_sent_at)} ago` : "Never")}
				${stat("Getting summaries", subscribers.toLocaleString(), `${(audience.waiting ?? 0).toLocaleString()} waiting to confirm`)}
			</div>
			${
				stats.last_error
					? `<div class="mt-3 bg-red-950/40 border border-red-900/50 rounded-xl px-3.5 py-2.5 text-xs">
						<div class="text-red-300 font-semibold">Last problem, ${shortAgo(stats.last_error_at)} ago</div>
						<div class="text-zinc-400 break-words mt-0.5">${escHtml(stats.last_error)}</div>
					</div>`
					: ""
			}`,
			status[0]
		)}

		${systemCard(
			"Mail server",
			"dns",
			info.saved && !info.revealed
				? `<div class="flex items-center gap-3">
					<div class="flex-1 min-w-0 text-sm text-zinc-400">A mail server is saved. Its details are hidden.</div>
					<button onclick="loadEmail(true)" class="m-btn m-btn-tonal m-btn-sm flex-shrink-0"><span class="material-symbols-outlined">visibility</span>Show details</button>
				</div>`
				: `<p class="text-xs text-zinc-500 mb-3">Any SMTP server works. For Purelymail: smtp.purelymail.com, port 465, and the full mailbox address as the username. Use a mailbox nobody reads: every email says replies are not read and points to tickets instead.</p>
				<div class="grid sm:grid-cols-2 gap-3">
					<div><label class="m-label" for="smtp-host">Host</label><input id="smtp-host" class="m-field" maxlength="200" placeholder="smtp.purelymail.com" value="${escHtml(info.host ?? "")}" /></div>
					<div><label class="m-label" for="smtp-port">Port</label><select id="smtp-port" class="m-field">
						${[
							[465, "465 (TLS)"],
							[587, "587 (STARTTLS)"],
							[2525, "2525"],
							[25, "25"],
						]
							.map(
								([port, label]) =>
									`<option value="${port}" ${info.port === port ? "selected" : ""}>${label}</option>`
							)
							.join("")}
					</select></div>
					<div><label class="m-label" for="smtp-user">Username</label><input id="smtp-user" class="m-field" maxlength="200" autocomplete="off" placeholder="noreply@dovedalegeoguesser.com" value="${escHtml(info.user ?? "")}" /></div>
					<div><label class="m-label" for="smtp-pass">Password <span class="text-zinc-600 font-normal">${info.has_password ? "Saved, and never shown. Leave blank to keep it." : ""}</span></label><input id="smtp-pass" type="password" class="m-field" maxlength="500" autocomplete="new-password" placeholder="${info.has_password ? "Unchanged" : "Mailbox or app password"}" /></div>
					<div class="sm:col-span-2"><label class="m-label" for="smtp-from">From</label><input id="smtp-from" class="m-field" maxlength="200" placeholder="Dovedale GeoGuesser &lt;noreply@dovedalegeoguesser.com&gt;" value="${escHtml(info.from ?? "")}" /></div>
				</div>
				<div class="flex gap-2 flex-wrap justify-end mt-3">
					${info.saved ? '<button onclick="clearEmailSettings()" class="m-btn m-btn-text m-btn-sm danger mr-auto">Remove mail server</button><button onclick="loadEmail()" class="m-btn m-btn-text m-btn-sm">Hide</button>' : ""}
					<button onclick="saveEmailSettings()" class="m-btn m-btn-filled m-btn-sm">Save</button>
				</div>`
		)}

		${systemCard(
			"Try it",
			"send",
			`<div class="flex gap-2 flex-wrap items-end">
				<div class="flex-1 min-w-[12rem]"><label class="m-label" for="smtp-test-to">Send a test email to</label><input id="smtp-test-to" type="email" class="m-field" maxlength="254" placeholder="you@example.com" /></div>
				<button id="smtp-test-btn" onclick="sendTestEmail()" class="m-btn m-btn-tonal m-btn-sm" ${info.smtp_ready ? "" : "disabled"}>Send test</button>
				<button onclick="runEmailNow()" class="m-btn m-btn-text m-btn-sm" ${live ? "" : "disabled"} title="Summaries normally go out every 15 minutes to whoever is due">Send due summaries now</button>
			</div>`
		)}

		${systemCard(
			"Who gets what",
			"groups",
			Object.keys(EMAIL_STATE_LABELS).some((key) => audience[key])
				? Object.entries(EMAIL_STATE_LABELS)
						.filter(([key]) => audience[key])
						.map(
							([key, label]) =>
								`<div class="flex items-baseline gap-2 py-1.5 border-b border-zinc-800 last:border-0 text-sm"><span class="flex-1 text-zinc-300">${label}</span><span class="font-mono">${audience[key].toLocaleString()}</span></div>`
						)
						.join("")
				: '<p class="text-sm text-zinc-500">Nobody has added an email address yet.</p>',
			saved
				? '<button onclick="clearAllEmails()" class="m-btn m-btn-text m-btn-sm danger"><span class="material-symbols-outlined">delete_sweep</span>Delete all addresses</button>'
				: ""
		)}`;
}

/** Unlinks every player's email and deletes the addresses. */
async function clearAllEmails() {
	const ok = await showConfirm(
		"Delete every player's email address?",
		"All saved addresses are deleted and the summaries stop for everyone. This cannot be undone: players would have to add and confirm their address again.",
		{ confirmLabel: "Delete all" }
	);
	if (!ok) return;
	emailAction(
		() => api("/api/admin/system/email/clear", { json: { confirm: true } }),
		({ removed }) => `${removed.toLocaleString()} address${removed === 1 ? "" : "es"} deleted.`
	);
}

/** Runs an email action from the tab, says how it went, and redraws. */
async function emailAction(request, done) {
	try {
		const result = await request();
		showToast(typeof done === "function" ? done(result) : done, "success");
		loadEmail();
	} catch (err) {
		showToast(err.message, "error");
	}
}

const setEmailEnabled = (enabled) =>
	emailAction(
		() => api("/api/admin/system/features", { json: { feature: "email_digests", enabled } }),
		enabled ? "Email switched on." : "Email switched off."
	);

const saveEmailSettings = () =>
	emailAction(
		() =>
			api("/api/admin/system/email/settings", {
				json: {
					host: el("smtp-host").value.trim(),
					port: Number(el("smtp-port").value),
					user: el("smtp-user").value.trim(),
					pass: el("smtp-pass").value,
					from: el("smtp-from").value.trim(),
				},
			}),
		"Mail server saved. Send a test to check it."
	);

async function clearEmailSettings() {
	if (
		!(await showConfirm(
			"Remove the mail server?",
			"Email is switched off and cannot be switched back on until another one is saved. Addresses players have added are kept.",
			{ confirmLabel: "Remove" }
		))
	)
		return;
	emailAction(() => api("/api/admin/system/email/settings", { method: "DELETE" }), "Mail server removed.");
}

async function sendTestEmail() {
	const button = el("smtp-test-btn");
	button.disabled = true;
	await emailAction(
		() => api("/api/admin/system/email/test", { json: { to: el("smtp-test-to").value.trim() } }),
		"Test sent. Check the inbox."
	);
}

const runEmailNow = () =>
	emailAction(
		() => api("/api/admin/system/email/run", { method: "POST" }),
		({ sent }) => (sent ? `${sent} summar${sent === 1 ? "y" : "ies"} sent.` : "Nobody is due a summary right now.")
	);
