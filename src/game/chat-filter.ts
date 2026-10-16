import { lookup } from "dns/promises";
import { isIP } from "net";
import { db, type User } from "../db";
import { auditLog } from "../lib/audit";
import { fail } from "../lib/http";
import { logInfo } from "../lib/logs";

/** What chat messages may contain, and the word lists. */

export type FilterAction = "refuse" | "mask" | "hold";
export type MatchType = "word" | "contains";

export const FILTER_ACTIONS: FilterAction[] = ["refuse", "mask", "hold"];

export const CHAT_LIMITS = {
	message: 200,
	emotes: 5,
	word: 40,
	/** Per web list. */
	listBytes: 2 * 1024 * 1024,
	listEntries: 50_000,
	listTimeoutMs: 10_000,
	listRedirects: 3,
	lists: 20,
};

export const LIST_REFRESH_MS = 24 * 60 * 60 * 1000;

/* ---- Cleaning ---- */

/** Control, zero-width, direction and combining characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{M}]/gu;
/** Latin letters, digits and everyday punctuation. Emoji are refused. */
const ALLOWED =
	/^[\p{Script=Latin}\p{Nd} !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u2018\u2019\u201C\u201D\u2026\u2013\u2014\u00B7\u00BF\u00A1\u20AC\u00A3\u00B0]*$/u;

/** NFKC, invisible characters removed, whitespace collapsed. */
export function cleanText(raw: string): string {
	return raw.normalize("NFKC").replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
}

export const hasOnlyPlainText = (text: string) => ALLOWED.test(text);

/* ---- Emotes ---- */

/** `:code:` to duel reaction icon. */
export const CHAT_EMOTES: Record<string, string> = {
	wave: "waving_hand",
	thumbsup: "thumb_up",
	handshake: "handshake",
	party: "celebration",
	fire: "local_fire_department",
	heart: "favorite",
	happy: "sentiment_very_satisfied",
	sad: "sentiment_dissatisfied",
	think: "psychology_alt",
	bolt: "bolt",
	rocket: "rocket_launch",
	skull: "skull",
};

export const emoteCount = (text: string) => [...text.matchAll(/:([a-z]+):/g)].filter((m) => m[1] in CHAT_EMOTES).length;

/* ---- Links ---- */

const CC_TLDS =
	"ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";
const G_TLDS =
	"com net org info biz xyz top site online store app dev live link click club shop blog page wiki fun lol icu vip win bet game games tech space website cloud email art design news pro name mobi asia tel travel ink one world today life zone media agency studio digital network systems solutions services company group social chat fyi rocks cool ninja guru party pics porn sex xxx adult cam tube video sexy dating date love cash money loan bid trade review download stream ltd inc llc gov edu mil int codes run red blue pink black gold work works gift host press";
const TLDS = new Set(`${CC_TLDS} ${G_TLDS}`.split(" "));

/** A dot, or a written-out one: "dot", (dot), [.], d0t. */
const DOT = String.raw`(?:\.|\s*[([{]\s*(?:\.|dot|d0t)\s*[)\]}]\s*|\s+(?:dot|d0t)\s+)`;
const DOMAIN = new RegExp(String.raw`(?:^|[^a-z0-9])[a-z0-9][a-z0-9-]*${DOT}([a-z]{2,24})(?![a-z])`, "g");

/** Spaced-out letters joined: "g o o g l e" becomes "google". */
const joinSpacedLetters = (text: string) =>
	text.replace(/(?:^|(?<= ))(?:[\p{L}\p{N}.] ){2,}[\p{L}\p{N}.](?= |$)/gu, (run) => run.replace(/ /g, ""));

/** URLs, domains, IPs, emails, invites and @everyone. */
export function hasLink(text: string): boolean {
	const lower = text.toLowerCase();
	for (const candidate of [lower, joinSpacedLetters(lower)]) {
		if (/https?:|:\/\/|\bwww\s*\./.test(candidate)) return true;
		if (/\b\d{1,3}(?:\s*\.\s*\d{1,3}){3}\b/.test(candidate)) return true;
		if (/discord(?:app)?\s*(?:\.|dot)?\s*(?:gg|io|me|com\s*\/\s*invite)\b/.test(candidate)) return true;
		if (/@(?:everyone|here)\b/.test(candidate)) return true;
		for (const m of candidate.matchAll(DOMAIN)) if (TLDS.has(m[1])) return true;
	}
	return false;
}

/* ---- Words ---- */

const LEET: Record<string, string> = {
	"4": "a",
	"@": "a",
	"3": "e",
	"1": "i",
	"!": "i",
	"0": "o",
	$: "s",
	"5": "s",
	"7": "t",
};

/** One word as the filter sees it: lower case, no accents, number swaps undone. */
export function flatten(word: string): string {
	return word
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[4@3!10$57]/g, (c) => LEET[c] ?? c)
		.replace(/[^a-z0-9 ]/g, "");
}

/** Repeats made one, for stretched spellings like "baaad". */
const squeeze = (flat: string) => flat.replace(/(.)\1+/g, "$1");
/** Only a word with three of a letter in a row is read squeezed, so "as" never matches "ass". */
const stretched = (flat: string) => /(.)\1\1/.test(flat);

export const flattenPhrase = (text: string) => text.split(/\s+/).map(flatten).filter(Boolean).join(" ");

const WORD = /[\p{L}\p{N}@$!]+/gu;

type Entry = { action: FilterAction; source: string; word: string };
type Index = {
	words: Map<string, Entry>;
	/** Squeezed keys, for stretched spellings. */
	squeezed: Map<string, Entry>;
	contains: (Entry & { flat: string })[];
	allow: Set<string>;
	/** Longest phrase, in words. */
	longest: number;
};

let index: Index | null = null;
export const resetFilterIndex = () => {
	index = null;
};

const STRICTER: Record<FilterAction, number> = { mask: 0, hold: 1, refuse: 2 };

function addWord(built: Index, flat: string, entry: Entry) {
	for (const [map, key] of [
		[built.words, flat],
		[built.squeezed, squeeze(flat)],
	] as const) {
		const had = map.get(key);
		if (!had || STRICTER[entry.action] > STRICTER[had.action]) map.set(key, entry);
	}
}

/** Entries from web lists this short once flattened ("s&m" becomes "sm") would catch ordinary text. */
const LIST_MIN_LETTERS = 3;

function buildIndex(): Index {
	const built: Index = { words: new Map(), squeezed: new Map(), contains: [], allow: new Set(), longest: 1 };
	const own = db
		.query<{ word: string; kind: string; match: MatchType; action: FilterAction }, []>(
			"SELECT word, kind, match, action FROM chat_filter_words"
		)
		.all();
	for (const w of own) {
		const flat = flattenPhrase(w.word);
		if (!flat) continue;
		if (w.kind === "allow") built.allow.add(flat);
		else if (w.match === "contains")
			built.contains.push({ flat, action: w.action, source: "Our list", word: w.word });
		else addWord(built, flat, { action: w.action, source: "Our list", word: w.word });
	}
	const lists = db
		.query<{ id: number; url: string; action: FilterAction; words: string }, []>(
			"SELECT id, url, action, words FROM chat_filter_lists WHERE enabled = 1 AND words IS NOT NULL"
		)
		.all();
	for (const list of lists) {
		const source = listName(list.url);
		for (const word of list.words.split("\n")) {
			const flat = flattenPhrase(word);
			if (flat.replace(/ /g, "").length >= LIST_MIN_LETTERS)
				addWord(built, flat, { action: list.action, source, word });
		}
	}
	for (const flat of built.words.keys()) built.longest = Math.max(built.longest, flat.split(" ").length);
	built.longest = Math.min(built.longest, 4);
	return built;
}

export type WordHit = Entry & { index: number | null };

/** `index` is the word's place when it can be masked alone. */
export function findWords(text: string): WordHit[] {
	index ??= buildIndex();
	const { words, squeezed, contains, allow, longest } = index;
	const lookup = (flat: string) => words.get(flat) ?? (stretched(flat) ? squeezed.get(squeeze(flat)) : undefined);
	const holds = (flat: string, part: string) =>
		flat.includes(part) || (stretched(flat) && squeeze(flat).includes(squeeze(part)));
	const raw = [...text.matchAll(WORD)].map((m) => m[0]);
	const flat = raw.map(flatten);
	const hits: WordHit[] = [];
	const seen = new Set<string>();
	const hit = (entry: Entry, at: number | null) => {
		const key = `${entry.word}:${at}`;
		if (!seen.has(key)) (hits.push({ ...entry, index: at }), seen.add(key));
	};
	for (let i = 0; i < flat.length; i++) {
		for (let n = 2; n <= longest && i + n <= flat.length; n++) {
			const words = flat.slice(i, i + n).join(" ");
			const phrase = allow.has(words) ? undefined : lookup(words);
			if (phrase) hit(phrase, null);
		}
		if (allow.has(flat[i])) continue;
		const single = lookup(flat[i]);
		if (single) hit(single, i);
		for (const c of contains) if (holds(flat[i], c.flat)) hit(c, i);
	}
	/** Spaced-out letters, read again as one word. */
	const joined = joinSpacedLetters(text).match(WORD) ?? [];
	for (const word of joined) {
		const f = flatten(word);
		if (allow.has(f) || flat.includes(f)) continue;
		const single = lookup(f);
		if (single) hit(single, null);
		for (const c of contains) if (holds(f, c.flat)) hit(c, null);
	}
	return hits;
}

export function maskWords(text: string, places: Set<number>): string {
	let i = 0;
	return text.replace(WORD, (word) => (places.has(i++) ? "*".repeat(word.length) : word));
}

export type Verdict =
	{ ok: true; body: string; held: boolean; hits: WordHit[] } | { ok: false; reason: string; hits: WordHit[] };

/** `places`: location names that can't be mentioned now. A hit spanning words can't be masked, so it is refused. */
export function checkMessage(raw: string, places: string[] = []): Verdict {
	const text = cleanText(raw);
	const no = (reason: string, hits: WordHit[] = []): Verdict => ({ ok: false, reason, hits });
	if (!text) return no("Type a message.");
	if (text.length > CHAT_LIMITS.message) return no(`Keep it under ${CHAT_LIMITS.message} characters.`);
	if (!hasOnlyPlainText(text)) return no("Only letters, numbers, punctuation and the chat emotes can be used.");
	if (emoteCount(text) > CHAT_LIMITS.emotes) return no(`Up to ${CHAT_LIMITS.emotes} emotes a message.`);
	if (hasLink(text)) return no("Links aren't allowed in chat.");
	const letters = text.replace(/:[a-z]+:/g, "").replace(/[^\p{L}]/gu, "");
	if (letters.length >= 8 && letters.replace(/[^\p{Lu}]/gu, "").length / letters.length > 0.7)
		return no("Too many capital letters.");
	if (/(.)\1{5,}/u.test(text)) return no("Too many of the same character in a row.");
	if (places.length) {
		const said = ` ${flattenPhrase(text.replace(/[^\p{L}\p{N}\s]/gu, " "))} `;
		if (places.some((p) => p && said.includes(` ${p} `)))
			return no("Places can't be named while a round is being played.");
	}
	const hits = findWords(text);
	if (hits.some((h) => h.action === "refuse" || (h.action === "mask" && h.index === null)))
		return no("That message has a word that isn't allowed.", hits);
	const masked = new Set(hits.filter((h) => h.action === "mask").map((h) => h.index as number));
	return {
		ok: true,
		body: masked.size ? maskWords(text, masked) : text,
		held: hits.some((h) => h.action === "hold"),
		hits,
	};
}

/** The parts of a location name that give it away: the whole name and uncommon words of 5+ letters. */
const EVERYDAY = new Set(
	[
		"station",
		"street",
		"house",
		"bridge",
		"river",
		"tunnel",
		"road",
		"north",
		"south",
		"east",
		"west",
		"park",
		"field",
		"hill",
		"farm",
		"yard",
		"track",
		"line",
		"lane",
		"green",
		"church",
		"school",
		"shop",
		"depot",
		"platform",
		"junction",
		"crossing",
		"village",
		"town",
		"city",
		"centre",
		"center",
	].map(flatten)
);

export function giveawayWords(label: string | null): string[] {
	if (!label) return [];
	const flat = flattenPhrase(label.replace(/[^\p{L}\p{N}\s]/gu, " "));
	const parts = flat.split(" ").filter((w) => w.length >= 5 && !EVERYDAY.has(w));
	return [...new Set([flat, ...parts])].filter(Boolean);
}

/* ---- Our own list ---- */

export type FilterWord = {
	id: number;
	word: string;
	kind: "block" | "allow";
	match: MatchType;
	action: FilterAction;
	created_by_username: string | null;
	created_at: number;
};

export function listWords(): FilterWord[] {
	return db
		.query<FilterWord, []>(
			"SELECT id, word, kind, match, action, created_by_username, created_at FROM chat_filter_words ORDER BY kind, word"
		)
		.all();
}

export function addWords(
	staff: User,
	input: { words?: unknown; kind?: unknown; match?: unknown; action?: unknown }
): { added: number } {
	const kind = input.kind === "allow" ? "allow" : "block";
	const match: MatchType = input.match === "contains" ? "contains" : "word";
	const action: FilterAction = FILTER_ACTIONS.includes(input.action as FilterAction)
		? (input.action as FilterAction)
		: "refuse";
	const words = (typeof input.words === "string" ? input.words : "")
		.split(/[\n,]+/)
		.map((w) => cleanText(w).toLowerCase())
		.filter((w) => w && w.length <= CHAT_LIMITS.word);
	if (!words.length) fail(400, "Enter at least one word.");
	let added = 0;
	for (const word of words)
		added += db.run(
			`INSERT INTO chat_filter_words (word, kind, match, action, created_by, created_by_username)
				VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(word, kind) DO UPDATE SET match = excluded.match, action = excluded.action`,
			[word, kind, match, action, staff.id, staff.username]
		).changes;
	resetFilterIndex();
	auditLog(staff, kind === "allow" ? "chat_filter_allow" : "chat_filter_add", {
		details: words.join(", ").slice(0, 200),
	});
	return { added };
}

export function removeWord(staff: User, id: number) {
	const row = db
		.query<{ word: string; kind: string }, [number]>("SELECT word, kind FROM chat_filter_words WHERE id = ?")
		.get(id);
	if (!row) fail(404, "That word isn't on the list.");
	db.run("DELETE FROM chat_filter_words WHERE id = ?", [id]);
	resetFilterIndex();
	auditLog(staff, "chat_filter_remove", { details: row.word });
}

/* ---- Lists from the web ---- */

export type FilterList = {
	id: number;
	url: string;
	action: FilterAction;
	enabled: number;
	count: number;
	previous_count: number | null;
	fetched_at: number | null;
	error: string | null;
	created_by_username: string | null;
	created_at: number;
};

const LIST_COLUMNS =
	"id, url, action, enabled, count, previous_count, fetched_at, error, created_by_username, created_at";

export function listLists(): FilterList[] {
	return db.query<FilterList, []>(`SELECT ${LIST_COLUMNS} FROM chat_filter_lists ORDER BY id`).all();
}

/** "owner/repo · file.txt" for GitHub, the host and file name otherwise. */
export function listName(url: string): string {
	try {
		const u = new URL(url);
		const parts = u.pathname.split("/").filter(Boolean);
		const file = decodeURIComponent(parts.at(-1) ?? u.hostname);
		if (u.hostname === "raw.githubusercontent.com" && parts.length >= 2) return `${parts[0]}/${parts[1]} · ${file}`;
		return `${u.hostname} · ${file}`;
	} catch {
		return url;
	}
}

/** GitHub file pages become raw file links. */
export function rawUrl(input: string): string {
	let u: URL;
	try {
		u = new URL(input.trim());
	} catch {
		fail(400, "Enter a full web address starting with http:// or https://.");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		fail(400, "Only http:// and https:// addresses can be used.");
	if (u.username || u.password) fail(400, "Addresses with a user name or password can't be used.");
	const blob = u.hostname === "github.com" && u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
	if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
	u.hash = "";
	return u.toString();
}

/** Loopback, private, link-local and reserved ranges, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
	const v4 = address.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19))
		);
	}
	const v6 = address.toLowerCase();
	return (
		v6 === "::" ||
		v6 === "::1" ||
		/^f[cd]/.test(v6) ||
		/^fe[89ab]/.test(v6) ||
		/^ff/.test(v6) ||
		v6.startsWith("::ffff:")
	);
}

/** Tests serve lists from this machine. */
let allowLocal = false;
export const allowLocalListsForTests = (value: boolean) => {
	allowLocal = value;
};

async function assertPublicHost(url: URL) {
	if (allowLocal) return;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
	if (!addresses.length) throw new Error("That address couldn't be found.");
	if (addresses.some(isPrivateAddress)) throw new Error("That address points at a private network.");
}

/** Over `max` bytes is an error, not a cut-off list. */
async function readCapped(res: Response, max: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new Error(`The list is bigger than ${Math.round(max / 1024 / 1024)} MB.`);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Every redirect target is checked too. */
export async function downloadList(url: string): Promise<string> {
	let next = new URL(url);
	for (let hop = 0; ; hop++) {
		await assertPublicHost(next);
		const res = await fetch(next, {
			redirect: "manual",
			signal: AbortSignal.timeout(CHAT_LIMITS.listTimeoutMs),
			headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
		});
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			if (hop >= CHAT_LIMITS.listRedirects) throw new Error("The address redirects too many times.");
			next = new URL(res.headers.get("location")!, next);
			if (next.protocol !== "http:" && next.protocol !== "https:")
				throw new Error("The address redirects somewhere that can't be read.");
			continue;
		}
		if (!res.ok) throw new Error(`The address answered with ${res.status}.`);
		const type = res.headers.get("content-type") ?? "";
		if (type && !/^(text\/|application\/(json|octet-stream))/.test(type))
			throw new Error("That address isn't a text file.");
		return readCapped(res, CHAT_LIMITS.listBytes);
	}
}

/** One entry per line (lines starting with # skipped), separated by commas, or a JSON array of strings. */
export function parseList(body: string): string[] {
	let entries: string[];
	const trimmed = body.trim();
	if (trimmed.startsWith("[")) {
		try {
			const data = JSON.parse(trimmed);
			entries = Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
		} catch {
			throw new Error("The list looks like JSON but couldn't be read.");
		}
	} else {
		entries = trimmed
			.split(/\r?\n/)
			.filter((line) => !line.trim().startsWith("#"))
			.flatMap((line) => line.split(","));
	}
	const words = new Set<string>();
	for (const entry of entries) {
		const word = cleanText(entry).toLowerCase();
		if (word && word.length <= CHAT_LIMITS.word) words.add(word);
		if (words.size >= CHAT_LIMITS.listEntries) break;
	}
	return [...words];
}

/** A failed download keeps the words it had. */
export async function refreshList(id: number): Promise<FilterList> {
	const row = db
		.query<{ url: string; count: number }, [number]>("SELECT url, count FROM chat_filter_lists WHERE id = ?")
		.get(id);
	if (!row) fail(404, "That list isn't there any more.");
	try {
		const words = parseList(await downloadList(row.url));
		if (!words.length) throw new Error("The list has no words in it.");
		db.run(
			`UPDATE chat_filter_lists SET words = ?, previous_count = count, count = ?, fetched_at = unixepoch(), error = NULL
				WHERE id = ?`,
			[words.join("\n"), words.length, id]
		);
	} catch (err) {
		const message =
			err instanceof Error
				? err.name === "TimeoutError"
					? "The address took too long to answer."
					: err.message
				: "Download failed.";
		db.run("UPDATE chat_filter_lists SET error = ? WHERE id = ?", [message.slice(0, 200), id]);
	}
	resetFilterIndex();
	return db.query<FilterList, [number]>(`SELECT ${LIST_COLUMNS} FROM chat_filter_lists WHERE id = ?`).get(id)!;
}

export async function addList(staff: User, input: { url?: unknown; action?: unknown }): Promise<FilterList> {
	const url = rawUrl(typeof input.url === "string" ? input.url : "");
	const action: FilterAction = FILTER_ACTIONS.includes(input.action as FilterAction)
		? (input.action as FilterAction)
		: "refuse";
	if (listLists().length >= CHAT_LIMITS.lists) fail(409, `Up to ${CHAT_LIMITS.lists} lists can be added.`);
	if (db.query("SELECT 1 FROM chat_filter_lists WHERE url = ?").get(url)) fail(409, "That list is already added.");
	const id = Number(
		db.run("INSERT INTO chat_filter_lists (url, action, created_by, created_by_username) VALUES (?, ?, ?, ?)", [
			url,
			action,
			staff.id,
			staff.username,
		]).lastInsertRowid
	);
	const list = await refreshList(id);
	auditLog(staff, "chat_list_add", { details: `${url} (${list.count} words)`.slice(0, 200) });
	return list;
}

export function updateList(staff: User, id: number, input: { action?: unknown; enabled?: unknown }) {
	const row = db.query<{ url: string }, [number]>("SELECT url FROM chat_filter_lists WHERE id = ?").get(id);
	if (!row) fail(404, "That list isn't there any more.");
	if (FILTER_ACTIONS.includes(input.action as FilterAction))
		db.run("UPDATE chat_filter_lists SET action = ? WHERE id = ?", [input.action as string, id]);
	if (typeof input.enabled === "boolean")
		db.run("UPDATE chat_filter_lists SET enabled = ? WHERE id = ?", [input.enabled ? 1 : 0, id]);
	resetFilterIndex();
	auditLog(staff, "chat_list_update", { details: row.url.slice(0, 200) });
}

export function removeList(staff: User, id: number) {
	const row = db.query<{ url: string }, [number]>("SELECT url FROM chat_filter_lists WHERE id = ?").get(id);
	if (!row) fail(404, "That list isn't there any more.");
	db.run("DELETE FROM chat_filter_lists WHERE id = ?", [id]);
	resetFilterIndex();
	auditLog(staff, "chat_list_remove", { details: row.url.slice(0, 200) });
}

/** Hourly: lists older than a day are downloaded again. */
export async function refreshDueLists() {
	const due = db
		.query<{ id: number }, [number]>(
			"SELECT id FROM chat_filter_lists WHERE enabled = 1 AND (fetched_at IS NULL OR fetched_at < unixepoch() - ?)"
		)
		.all(Math.floor(LIST_REFRESH_MS / 1000));
	for (const { id } of due) await refreshList(id);
	if (due.length) logInfo(`[chat] Refreshed ${due.length} word list(s)`);
}

/* ---- The default list ---- */

/** LDNOOBW's English list, well known and maintained. */
export const DEFAULT_LIST_URL =
	"https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en";
/** Everyday phrases on that list. */
const DEFAULT_ALLOWED = ["tied up", "girl on", "suck", "sucks"];
const SEEDED_KEY = "chat_filter_seeded";

/** Adds the default list once; removing it is permanent. True when added now. */
export function seedDefaultList(): boolean {
	if (db.query("SELECT 1 FROM app_settings WHERE key = ?").get(SEEDED_KEY)) return false;
	db.run(
		"INSERT OR IGNORE INTO chat_filter_lists (url, action, created_by_username) VALUES (?, 'refuse', 'system')",
		[DEFAULT_LIST_URL]
	);
	for (const word of DEFAULT_ALLOWED)
		db.run(
			"INSERT OR IGNORE INTO chat_filter_words (word, kind, created_by_username) VALUES (?, 'allow', 'system')",
			[word]
		);
	db.run("INSERT INTO app_settings (key, value) VALUES (?, '1')", [SEEDED_KEY]);
	resetFilterIndex();
	return true;
}
