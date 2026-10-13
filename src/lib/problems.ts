import { md, notify } from "./webhook";

const MIN_GAP_MS = 60 * 1000;
let lastReport = 0;
let suppressed = 0;

/** Tells the staff channel something broke, at most once a minute. */
export function reportProblem(what: string, err: unknown, ref?: string) {
	const now = Date.now();
	if (now - lastReport < MIN_GAP_MS) {
		suppressed++;
		return;
	}
	const message = err instanceof Error ? err.message : String(err);
	const more = suppressed ? `\n-# ${suppressed} more since the last report` : "";
	lastReport = now;
	suppressed = 0;
	notify(
		"system",
		`**${what}**\n\`\`\`\n${message.slice(0, 600).replace(/`/g, "'")}\n\`\`\`${ref ? `\nReference ${md(ref)}` : ""}${more}`,
		"/admin#audit"
	);
}
