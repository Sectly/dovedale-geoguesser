import { DISCORD, SITE_URL } from "../config";

export type WebhookCategory =
	"submissions" | "suggestions" | "locations" | "users" | "bans" | "duels" | "support" | "system";

const STYLE: Record<WebhookCategory, [color: number, label: string]> = {
	submissions: [0x42a5f5, "Submissions"],
	suggestions: [0x26c6da, "Suggestions"],
	locations: [0x66bb6a, "Locations"],
	users: [0x9e9e9e, "Accounts"],
	bans: [0xef5350, "Moderation"],
	duels: [0xab47bc, "Duels"],
	support: [0xffa726, "Tickets"],
	system: [0x78909c, "System"],
};

const MAX_QUEUED = 50;
const queue: object[] = [];
let sending = false;

/** Posts one message at a time and waits out Discord's rate limit, so bursts are not dropped. */
async function drain(url: string) {
	if (sending) return;
	sending = true;
	while (queue.length) {
		const payload = queue[0];
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(5000),
			});
			if (res.status === 429) {
				const wait = Number(res.headers.get("Retry-After")) || 2;
				await Bun.sleep(Math.min(wait, 15) * 1000);
				continue;
			}
		} catch {}
		queue.shift();
	}
	sending = false;
}

export function md(value: string | null | undefined): string {
	return (value ?? "").replace(/([\\*_~`|>\[\]()#-])/g, "\\$1");
}

/** Fire-and-forget Discord notification. Never throws. A leading "**Title**" becomes the embed title. */
export function notify(category: WebhookCategory, content: string, adminPath = "/admin") {
	const url = DISCORD.webhookUrl;
	if (!url) return;
	if (!DISCORD.webhookEvents.has("all") && !DISCORD.webhookEvents.has(category)) return;
	if (queue.length >= MAX_QUEUED) return;

	const [color, label] = STYLE[category];
	const heading = /^\*\*(.+?)\*\*:?\s*/.exec(content);
	const title = heading ? heading[1] : label;
	const description = (heading ? content.slice(heading[0].length) : content).trim();
	queue.push({
		embeds: [
			{
				title: title.slice(0, 250),
				description: description.slice(0, 3500) || undefined,
				url: SITE_URL ? `${SITE_URL}${adminPath}` : undefined,
				color,
				footer: { text: label },
				timestamp: new Date().toISOString(),
			},
		],
		/** Usernames and labels are user-controlled, so never let them ping anyone. */
		allowed_mentions: { parse: [] },
	});
	void drain(url);
}

export function displayName(user: { display_name?: string | null; username: string }): string {
	return user.display_name || user.username;
}
