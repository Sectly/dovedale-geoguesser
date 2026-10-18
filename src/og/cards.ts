const SURFACE = "#121214";
const CARD = "#1e1e22";
const OUTLINE = "#2c2c31";
const PRIMARY = "#2563eb";
const ON_SURFACE = "#f4f4f5";
const MUTED = "#a1a1aa";
const FAINT = "#71717a";
const FONT = 'font-family="Inter,Roboto,Arial,sans-serif"';

export function escapeXml(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function brand(x: number, y: number): string {
	return `<circle cx="${x + 22}" cy="${y}" r="22" fill="${PRIMARY}"/>
  <circle cx="${x + 22}" cy="${y}" r="13" fill="none" stroke="#fff" stroke-width="3"/>
  <path d="M${x + 29} ${y - 7} L${x + 25} ${y + 3} L${x + 15} ${y + 7} L${x + 19} ${y - 3} Z" fill="#fff"/>
  <text x="${x + 60}" y="${y + 9}" ${FONT} font-size="26" font-weight="600" fill="${ON_SURFACE}">Dovedale GeoGuesser</text>`;
}

function frame(content: string): string {
	return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${SURFACE}"/>
  ${content}
</svg>`;
}

function chip(x: number, y: number, width: number, label: string, color = MUTED): string {
	return `<rect x="${x}" y="${y}" width="${width}" height="52" rx="26" fill="${CARD}" stroke="${OUTLINE}" stroke-width="2"/>
  <text x="${x + width / 2}" y="${y + 34}" ${FONT} font-size="24" font-weight="500" fill="${color}" text-anchor="middle">${escapeXml(label)}</text>`;
}

export function genericCard(title: string, subtitle: string): string {
	return frame(`${brand(80, 96)}
  <text x="80" y="330" ${FONT} font-size="84" font-weight="700" fill="${ON_SURFACE}">${escapeXml(clip(title, 24))}</text>
  <text x="80" y="398" ${FONT} font-size="32" fill="${MUTED}">${escapeXml(clip(subtitle, 64))}</text>
  <rect x="80" y="474" width="210" height="64" rx="32" fill="${PRIMARY}"/>
  <text x="185" y="516" ${FONT} font-size="26" font-weight="600" fill="#fff" text-anchor="middle">Play now</text>
  <text x="1120" y="518" ${FONT} font-size="24" fill="${FAINT}" text-anchor="end">dovedalegeoguesser.com</text>`);
}

export function profileCard(
	displayName: string,
	username: string,
	memberSince: string,
	stats: { label: string; value: string }[],
	avatarDataUri: string
): string {
	const name = displayName || username;
	const avatar = avatarDataUri
		? `<defs><clipPath id="av"><circle cx="150" cy="300" r="70"/></clipPath></defs>
  <image href="${avatarDataUri}" x="80" y="230" width="140" height="140" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
		: `<circle cx="150" cy="300" r="70" fill="${PRIMARY}"/>
  <text x="150" y="322" ${FONT} font-size="60" font-weight="600" fill="#fff" text-anchor="middle">${escapeXml(name.slice(0, 1).toUpperCase())}</text>`;

	const tiles = stats
		.map((s, i) => {
			const x = 620 + (i % 2) * 260;
			const y = 190 + Math.floor(i / 2) * 170;
			return `<rect x="${x}" y="${y}" width="240" height="150" rx="24" fill="${CARD}" stroke="${OUTLINE}" stroke-width="2"/>
  <text x="${x + 28}" y="${y + 74}" ${FONT} font-size="48" font-weight="700" fill="${ON_SURFACE}">${escapeXml(s.value)}</text>
  <text x="${x + 28}" y="${y + 114}" ${FONT} font-size="22" fill="${MUTED}">${escapeXml(s.label)}</text>`;
		})
		.join("\n  ");

	return frame(`${brand(80, 96)}
  ${avatar}
  <text x="250" y="296" ${FONT} font-size="48" font-weight="700" fill="${ON_SURFACE}">${escapeXml(clip(name, 13))}</text>
  <text x="250" y="338" ${FONT} font-size="26" fill="${MUTED}">@${escapeXml(clip(username, 22))}</text>
  <text x="80" y="446" ${FONT} font-size="24" fill="${FAINT}">Member since ${escapeXml(memberSince)}</text>
  ${tiles}`);
}

export function duelCard(
	code: string,
	hostName: string,
	rounds: number,
	playerCount: number,
	status: string,
	isSpectate: boolean
): string {
	const live = status === "in_progress";
	return frame(`${brand(80, 96)}
  <text x="80" y="290" ${FONT} font-size="76" font-weight="700" fill="${ON_SURFACE}">${isSpectate ? "Watch this duel" : "Duel invite"}</text>
  <text x="80" y="350" ${FONT} font-size="32" fill="${MUTED}">Hosted by ${escapeXml(clip(hostName, 24))}</text>
  ${chip(80, 400, 170, `${rounds} rounds`)}
  ${chip(266, 400, 190, `${playerCount}/2 players`)}
  ${chip(472, 400, 250, live ? "In progress" : "Waiting to start", live ? "#4caf50" : MUTED)}
  <rect x="820" y="210" width="300" height="230" rx="28" fill="${CARD}" stroke="${OUTLINE}" stroke-width="2"/>
  <text x="970" y="278" ${FONT} font-size="24" fill="${MUTED}" text-anchor="middle">Room code</text>
  <text x="970" y="366" font-family="monospace" font-size="64" font-weight="700" fill="${ON_SURFACE}" text-anchor="middle" letter-spacing="6">${escapeXml(code)}</text>
  <text x="80" y="540" ${FONT} font-size="24" fill="${FAINT}">dovedalegeoguesser.com</text>`);
}

const GOLD = "#facc15";

function trophy(cx: number, cy: number, color: string): string {
	return `<g transform="translate(${cx - 90} ${cy - 100})" fill="${color}">
    <path d="M40 10 h100 v60 a50 50 0 0 1 -100 0 z"/>
    <path d="M40 22 h-22 a26 26 0 0 0 26 44 v-12 a14 14 0 0 1 -14 -20 h10 z"/>
    <path d="M140 22 h22 a26 26 0 0 1 -26 44 v-12 a14 14 0 0 0 14 -20 h-10 z"/>
    <rect x="80" y="118" width="20" height="34"/>
    <rect x="52" y="150" width="76" height="22" rx="6"/>
  </g>`;
}

export type TournamentCardInfo = {
	title: string;
	status: string;
	players: number;
	/** e.g. "Starts 18 Oct, 20:00 UTC", "Semi-finals", or null. */
	detail: string | null;
	/** Live: who is playing or up next. */
	match: string | null;
	champion: { name: string; avatar: string } | null;
	invite: boolean;
};

export function tournamentCard(t: TournamentCardInfo): string {
	const kicker = t.invite
		? "You're invited to play"
		: t.status === "live"
			? "Tournament · Live now"
			: t.status === "finished"
				? "Tournament results"
				: t.status === "cancelled"
					? "Tournament · Cancelled"
					: "Tournament";
	const state =
		t.status === "live"
			? ["Live now", "#4caf50"]
			: t.status === "open"
				? ["Check-in open", "#93c5fd"]
				: t.status === "finished"
					? ["Finished", MUTED]
					: t.status === "cancelled"
						? ["Cancelled", MUTED]
						: ["Coming up", MUTED];
	const playersLabel = `${t.players} player${t.players === 1 ? "" : "s"}`;
	const lines = [t.detail, t.match].filter((line): line is string => !!line);
	/** Two lines of detail push the labels down a little. */
	const chipY = lines.length > 1 ? 446 : 430;
	const chips = [
		chip(80, chipY, 70 + state[0].length * 13, state[0], state[1]),
		chip(100 + state[0].length * 13 + 70, chipY, 70 + playersLabel.length * 13, playersLabel),
	].join("\n  ");

	let right = trophy(970, 300, t.status === "cancelled" ? OUTLINE : GOLD);
	if (t.champion) {
		const initial = escapeXml(t.champion.name.slice(0, 1).toUpperCase());
		const face = t.champion.avatar
			? `<defs><clipPath id="champ"><circle cx="970" cy="300" r="96"/></clipPath></defs>
  <image href="${t.champion.avatar}" x="874" y="204" width="192" height="192" clip-path="url(#champ)" preserveAspectRatio="xMidYMid slice"/>`
			: `<circle cx="970" cy="300" r="96" fill="${PRIMARY}"/>
  <text x="970" y="330" ${FONT} font-size="84" font-weight="700" fill="#fff" text-anchor="middle">${initial}</text>`;
		right = `<circle cx="970" cy="300" r="104" fill="${GOLD}"/>
  ${face}
  <text x="970" y="452" ${FONT} font-size="24" fill="${MUTED}" text-anchor="middle">Champion</text>
  <text x="970" y="496" ${FONT} font-size="36" font-weight="700" fill="${ON_SURFACE}" text-anchor="middle">${escapeXml(clip(t.champion.name, 16))}</text>`;
	}

	return frame(`${brand(80, 96)}
  <text x="80" y="226" ${FONT} font-size="28" font-weight="600" fill="${t.invite ? "#93c5fd" : MUTED}">${escapeXml(kicker)}</text>
  <text x="80" y="306" ${FONT} font-size="68" font-weight="700" fill="${ON_SURFACE}">${escapeXml(clip(t.title, 20))}</text>
  ${lines.map((line, i) => `<text x="80" y="${360 + i * 40}" ${FONT} font-size="30" fill="${MUTED}">${escapeXml(clip(line, 40))}</text>`).join("\n  ")}
  ${chips}
  ${right}
  <text x="80" y="560" ${FONT} font-size="24" fill="${FAINT}">dovedalegeoguesser.com</text>`);
}
