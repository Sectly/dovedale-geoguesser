import { beforeAll, describe, expect, mock, test } from "bun:test";

/** Embeds need absolute links, so this file runs with a public address. */
const config = await import("../src/config");
mock.module("../src/config", () => ({ ...config, SITE_URL: "https://geo.example" }));
const { call, createUser, post } = await import("./helpers");
const { db } = await import("../src/db");
const sharp = (await import("sharp")).default;

type Component = {
	type: number;
	style?: number;
	url?: string;
	content?: string;
	media?: { url: string };
	components?: Component[];
	accessory?: Component;
};

async function embedOf(path: string) {
	const html = String((await call(path)).data);
	const json = html.match(/<script id="discord:component-embed" type="application\/json">(.*?)<\/script>/)?.[1];
	expect(json).toBeTruthy();
	expect(Buffer.byteLength(json!)).toBeLessThanOrEqual(3000);
	const payload = JSON.parse(json!);
	expect(Object.keys(payload)).toEqual(["component"]);
	return { html, json: json!, component: payload.component as Component };
}

const flatten = (c: Component): Component[] => [
	c,
	...(c.components ?? []).flatMap(flatten),
	...(c.accessory ? flatten(c.accessory) : []),
];

let username = "";

beforeAll(() => {
	const user = createUser();
	username = user.username;
	db.run("UPDATE users SET display_name = ? WHERE id = ?", ["</script><b>*Bold*", user.id]);
});

describe("Discord component embeds", () => {
	test("each share page has one container of link buttons, beside its Open Graph tags", async () => {
		for (const path of [
			"/",
			"/play",
			"/daily",
			"/duels",
			"/leaderboard",
			"/duel/abc123",
			`/u/${username}`,
			"/specials",
			"/specials/memory",
			"/play?special=flash",
		]) {
			const { html, component } = await embedOf(path);
			expect(html).toContain('property="og:title"');
			expect(component.type).toBe(17);
			const all = flatten(component);
			expect(all.length).toBeLessThanOrEqual(40);
			expect(all.filter((c) => c.type === 17)).toHaveLength(1);
			for (const b of all.filter((c) => c.type === 2)) {
				expect(b.style).toBe(5);
				expect(b.url).toStartWith("https://geo.example/");
			}
		}
	});

	test("player names cannot close the script tag or add formatting", async () => {
		const { json, component } = await embedOf(`/u/${username}`);
		expect(json).not.toContain("</script");
		const heading = flatten(component).find((c) => c.type === 10)!.content!;
		expect(heading).toStartWith("# [\\</script\\>\\<b\\>\\*Bold\\*](");
	});

	test("a working tournament invite link gets an invite embed that keeps the code", async () => {
		const staff = createUser({ role: "supervisor" });
		const id = (await post("/api/admin/tournaments", staff, { title: "Game night", rounds: 1 })).data.id;
		const code = (await post(`/api/admin/tournaments/${id}/invite`, staff, { on: true })).data.invite_code;
		await post(`/api/admin/tournaments/${id}/open`, staff);

		const invited = (await embedOf(`/tournament/${id}?invite=${code.toLowerCase()}`)).component;
		expect(flatten(invited).find((c) => c.type === 10)!.content).toStartWith("-# You're invited to play");
		const join = flatten(invited).find((c) => c.type === 2)!;
		expect(join.url).toBe(`https://geo.example/tournament/${id}?invite=${code}`);

		const wrong = (await embedOf(`/tournament/${id}?invite=WRONG1`)).component;
		expect(flatten(wrong).find((c) => c.type === 10)!.content).not.toContain("invited");
	});

	test("profile avatars are served from the site, where Discord will load them", async () => {
		const user = createUser();
		const discordUrl = `https://cdn.discordapp.com/avatars/1/abc.png?size=256`;
		db.run("UPDATE users SET avatar_url = ? WHERE id = ?", [discordUrl, user.id]);
		const thumb = flatten((await embedOf(`/u/${user.username}`)).component).find((c) => c.type === 11)!;
		expect(thumb.media!.url).toMatch(
			new RegExp(`^https://geo\\.example/u/${user.username}/avatar-[0-9a-z]+\\.webp$`)
		);

		const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f00" } })
			.png()
			.toBuffer();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(red, { headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;
		try {
			const res = await call(new URL(thumb.media!.url).pathname);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/webp");
		} finally {
			globalThis.fetch = realFetch;
		}
		expect((await call(`/u/nobody-here/avatar-abc.webp`)).status).toBe(404);
	});

	test("specials and team room invites describe themselves", async () => {
		const flash = (await embedOf("/play?special=flash")).component;
		expect(flatten(flash).find((c) => c.type === 10)!.content).toContain("# [Flash](");
		expect(flatten(flash).find((c) => c.type === 2)!.url).toBe("https://geo.example/play?special=flash");

		const host = createUser();
		const code = (await post("/api/teams/rooms", host, { rounds: 3 })).data.code;
		const invite = await embedOf(`/specials/teams?room=${code}`);
		expect(invite.html).toContain("Team Duels room | Dovedale GeoGuesser</title>");
		const join = flatten(invite.component).find((c) => c.type === 2)!;
		expect(join.url).toBe(`https://geo.example/specials/teams?room=${code}`);
		expect(flatten(invite.component).find((c) => c.type === 10)!.content).toContain(
			"2 vs 2 · 3 rounds · 1 of 4 players"
		);

		const gone = await embedOf("/specials/teams?room=ZZZZZZ");
		expect(flatten(gone.component).find((c) => c.type === 10)!.content).toContain("# [Team Duels](");
	});

	test("pages without a share preview get none", async () => {
		expect(String((await call("/settings")).data)).not.toContain("discord:component-embed");
	});
});
