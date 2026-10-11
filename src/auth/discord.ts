import { randomBytes } from "crypto";
import { DISCORD } from "../config";
import type { DiscordProfile } from "./sessions";

const STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, number>();

export function pruneOauthStates() {
	const now = Date.now();
	for (const [state, expiry] of oauthStates) {
		if (expiry < now) oauthStates.delete(state);
	}
}

export function oauthConfigured(): boolean {
	return !!(DISCORD.clientId && DISCORD.clientSecret && DISCORD.redirectUri);
}

export function createAuthUrl(): string {
	const state = randomBytes(16).toString("hex");
	oauthStates.set(state, Date.now() + STATE_TTL_MS);
	const params = new URLSearchParams({
		client_id: DISCORD.clientId!,
		redirect_uri: DISCORD.redirectUri!,
		response_type: "code",
		scope: "identify",
		state,
	});
	return `https://discord.com/oauth2/authorize?${params}`;
}

/** States are single use. */
export function consumeState(state: string): boolean {
	const expiry = oauthStates.get(state);
	oauthStates.delete(state);
	return expiry !== undefined && expiry >= Date.now();
}

export async function exchangeCode(code: string): Promise<DiscordProfile> {
	const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: DISCORD.redirectUri!,
			client_id: DISCORD.clientId!,
			client_secret: DISCORD.clientSecret!,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
	const tokens = (await tokenRes.json()) as { access_token: string };

	const userRes = await fetch("https://discord.com/api/users/@me", {
		headers: { Authorization: `Bearer ${tokens.access_token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!userRes.ok) throw new Error(`User info failed: ${userRes.status}`);
	const info = (await userRes.json()) as {
		id: string;
		username: string;
		global_name: string | null;
		avatar: string | null;
	};

	return {
		discord_id: info.id,
		username: info.username,
		display_name: info.global_name || info.username,
		avatar_url: info.avatar
			? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png?size=256`
			: `https://cdn.discordapp.com/embed/avatars/${(BigInt(info.id) >> 22n) % 6n}.png`,
	};
}
