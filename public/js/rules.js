/** The numbered rules staff can cite. Must match the linked pages (a test checks). */
const RULES = [
	{ code: "F1", title: "Cheating", page: "/fairplay" },
	{ code: "F2", title: "Exploiting bugs", page: "/fairplay" },
	{ code: "F3", title: "Score manipulation", page: "/fairplay" },
	{ code: "F4", title: "Boosting and collusion", page: "/fairplay" },
	{ code: "F5", title: "Spoiling", page: "/fairplay" },
	{ code: "F6", title: "Misusing Suggest Change", page: "/fairplay" },
	{ code: "F7", title: "Harassment and abuse", page: "/fairplay" },
	{ code: "F8", title: "Inappropriate content", page: "/fairplay" },
	{ code: "F9", title: "Disrupting duels", page: "/fairplay" },
	{ code: "F10", title: "False reports and ticket misuse", page: "/fairplay" },
	{ code: "F11", title: "Multiple accounts", page: "/fairplay" },
	{ code: "F12", title: "Personal information", page: "/fairplay" },
	{ code: "A1", title: "Ban evasion", page: "/tos" },
	{ code: "A2", title: "Other people's accounts", page: "/tos" },
	{ code: "A3", title: "Attacking the Service", page: "/tos" },
	{ code: "A4", title: "Impersonation", page: "/tos" },
	{ code: "A5", title: "Illegal use", page: "/tos" },
	{ code: "U1", title: "Wrong game", page: "/guidelines" },
	{ code: "U2", title: "Player names visible", page: "/guidelines" },
	{ code: "U3", title: "Chat or interface visible", page: "/guidelines" },
	{ code: "U4", title: "Duplicate", page: "/guidelines" },
	{ code: "U5", title: "Wrong pin", page: "/guidelines" },
	{ code: "U6", title: "Poor quality", page: "/guidelines" },
	{ code: "U7", title: "Not identifiable", page: "/guidelines" },
	{ code: "U8", title: "Filters or edits", page: "/guidelines" },
	{ code: "U9", title: "Inappropriate content", page: "/guidelines" },
	{ code: "U10", title: "Misleading label or hints", page: "/guidelines" },
	{ code: "U11", title: "Spam", page: "/guidelines" },
	{ code: "U12", title: "Not yours to share", page: "/guidelines" },
	{ code: "U13", title: "AI-generated or AI-altered", page: "/guidelines" },
	{ code: "U14", title: "Out of date", page: "/guidelines" },
];

const RULE_GROUPS = { F: "Fair play", A: "Account", U: "Uploads" };

/** Turns rule numbers in already-escaped text (e.g. "[F1]") into links to the rule. */
function linkRuleCodes(escapedText) {
	return escapedText.replace(/\b([FAU]\d{1,2})\b/g, (match) => {
		const rule = RULES.find((r) => r.code === match);
		return rule
			? `<a href="${rule.page}#${rule.code}" target="_blank" rel="noopener" class="rule-code" title="${rule.title}">${rule.code}</a>`
			: match;
	});
}

/** Buttons for citing rules, grouped by the letters given (e.g. "FA" or "U"). */
function ruleChipsHtml(groups) {
	return [...groups]
		.map(
			(letter) => `<div class="flex gap-1 flex-wrap items-center mb-1.5">
			<span class="text-[11px] text-zinc-500 w-16 flex-shrink-0">${RULE_GROUPS[letter]}</span>
			${RULES.filter((r) => r.code.startsWith(letter))
				.map(
					(r) =>
						`<button type="button" data-rule="${r.code}" title="${r.title}" class="px-1.5 py-0.5 rounded-md text-[11px] font-mono font-bold bg-zinc-800 text-blue-300 hover:bg-zinc-700 transition">${r.code}</button>`
				)
				.join("")}
		</div>`
		)
		.join("");
}

/** Wires rule buttons to a text box: clicking one adds or removes "[F1 Cheating]". */
function bindRuleChips(container, textarea) {
	const sync = () => {
		for (const chip of container.querySelectorAll("[data-rule]")) {
			const cited = textarea.value.includes(`[${chip.dataset.rule} `);
			chip.classList.toggle("bg-blue-600", cited);
			chip.classList.toggle("text-white", cited);
			chip.classList.toggle("bg-zinc-800", !cited);
			chip.classList.toggle("text-blue-300", !cited);
		}
	};
	container.onclick = (e) => {
		const chip = e.target.closest("[data-rule]");
		if (!chip) return;
		const rule = RULES.find((r) => r.code === chip.dataset.rule);
		const tag = `[${rule.code} ${rule.title}]`;
		textarea.value = textarea.value.includes(tag)
			? textarea.value.replace(tag, "").replace(/^\s+/, "")
			: `${tag} ${textarea.value}`;
		textarea.dispatchEvent(new Event("input"));
		textarea.focus();
		sync();
	};
	textarea.addEventListener("input", sync);
	sync();
}
