import { ROOT_DIR } from "../config";
import { createBackup } from "../backups";
import { db } from "../db";
import { SUPERVISED } from "../lib/lifecycle";
import { logInfo } from "../lib/logs";
import { cancelRestart, restartIn, scheduleRestart } from "./restart";

/**
 * Installing updates from the staff panel. The server only ever fast-forwards to what
 * is on the configured branch of its own git remote: nothing here takes a URL, a
 * branch name or a command from the request.
 */

const BRANCH = /^[\w./-]{1,80}$/.test(process.env.UPDATE_BRANCH ?? "") ? process.env.UPDATE_BRANCH! : "main";
const REMOTE = "origin";
/** Set PANEL_UPDATES=off to remove the feature entirely. */
export const UPDATES_ENABLED = (process.env.PANEL_UPDATES ?? "on").toLowerCase() !== "off";

type Result = { ok: boolean; out: string };

async function run(cmd: string[], timeoutMs = 60_000): Promise<Result> {
	try {
		const proc = Bun.spawn({
			cmd,
			cwd: ROOT_DIR,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		clearTimeout(timer);
		return { ok: code === 0, out: `${out}${err}`.trim() };
	} catch (err) {
		return { ok: false, out: err instanceof Error ? err.message : String(err) };
	}
}

const git = (...args: string[]) => run(["git", ...args]);

export type Commit = { hash: string; subject: string; author: string; date: number };

function parseCommits(out: string): Commit[] {
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, subject, author, date] = line.split("\x1f");
			return { hash, subject, author, date: Number(date) };
		});
}

const LOG_FORMAT = "--format=%H%x1f%s%x1f%an%x1f%ct";
let lastFetch = 0;

/** Where the checkout is and what the remote has that it does not. `refresh` asks the remote first. */
export async function updateStatus(refresh = false) {
	const head = await git("rev-parse", "HEAD");
	if (!head.ok) return { available: false as const, reason: "The server is not running from a git checkout." };

	let fetchError: string | null = null;
	if (refresh && Date.now() - lastFetch > 15_000) {
		lastFetch = Date.now();
		const fetched = await git("fetch", "--quiet", REMOTE, BRANCH);
		if (!fetched.ok) fetchError = fetched.out.slice(0, 300) || "Could not reach the remote.";
	}
	const [branch, dirty, current, behind, ahead] = await Promise.all([
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("status", "--porcelain", "--untracked-files=no"),
		git("log", "-1", LOG_FORMAT),
		git("log", "--max-count=50", LOG_FORMAT, `HEAD..${REMOTE}/${BRANCH}`),
		git("rev-list", "--count", `${REMOTE}/${BRANCH}..HEAD`),
	]);
	return {
		available: true as const,
		enabled: UPDATES_ENABLED,
		supervised: SUPERVISED,
		branch: branch.out,
		tracking: `${REMOTE}/${BRANCH}`,
		current: parseCommits(current.out)[0] ?? null,
		pending: behind.ok ? parseCommits(behind.out) : [],
		ahead: Number(ahead.out) || 0,
		/** Files changed on the server itself; an update refuses to run over them. */
		local_changes: dirty.out ? dirty.out.split("\n").length : 0,
		fetch_error: fetchError,
		checked_at: lastFetch ? Math.floor(lastFetch / 1000) : null,
		/** Seconds until the announced restart, while one is counting down. */
		restart_in: restartIn(),
		job,
	};
}

type Job = {
	state: "idle" | "running" | "failed" | "restarting" | "needs_restart";
	step: string;
	log: string[];
	started_at: number | null;
	started_by: string | null;
};

const job: Job = { state: "idle", step: "", log: [], started_at: null, started_by: null };
/** True once an update has been installed that the running server has not restarted into. */
let installed = false;
const INSTALLED_STEP = "Installed. Restart the server to finish.";

function note(line: string) {
	job.log.push(line);
	if (job.log.length > 200) job.log.shift();
}

/**
 * Backs up the database, fast-forwards to the remote branch, installs dependencies and
 * rebuilds the stylesheet, then restarts once players have had their warning. Stops at
 * the first step that fails, leaving the running server as it was.
 */
export async function runUpdate(startedBy: string): Promise<string | null> {
	if (!UPDATES_ENABLED) return "Updates from the panel are switched off on this server.";
	if (job.state === "running" || job.state === "restarting") return "An update is already running.";
	const status = await updateStatus(true);
	if (!status.available) return status.reason;
	if (status.local_changes) return "Files on the server have been edited by hand. Commit or discard them first.";
	if (status.branch !== BRANCH) return `The server is on branch "${status.branch}", not "${BRANCH}".`;
	if (status.ahead) return "The server has commits the remote does not. Sort that out by hand first.";
	if (!status.pending.length) return "Already up to date.";

	Object.assign(job, {
		state: "running",
		step: "",
		log: [],
		started_at: Math.floor(Date.now() / 1000),
		started_by: startedBy,
	});
	void (async () => {
		const steps: [string, () => Promise<Result>][] = [
			["Backing up the database", async () => ({ ok: true, out: createBackup(db, "update") })],
			["Downloading the update", () => git("pull", "--ff-only", REMOTE, BRANCH)],
			["Installing dependencies", () => run([process.execPath, "install"], 300_000)],
			["Building styles", () => run([process.execPath, "run", "build:css"], 300_000)],
		];
		for (const [name, step] of steps) {
			job.step = name;
			note(`> ${name}`);
			let result: Result;
			try {
				result = await step();
			} catch (err) {
				result = { ok: false, out: err instanceof Error ? err.message : String(err) };
			}
			if (result.out) note(result.out.slice(-2000));
			if (!result.ok) {
				job.state = "failed";
				console.error(`[update] "${name}" failed. The server was not restarted.\n${result.out}`);
				return;
			}
		}
		logInfo(`[update] Installed ${status.pending.length} commit(s), started by ${startedBy}`, job.log.join("\n"));
		installed = true;
		if (!SUPERVISED) {
			job.state = "needs_restart";
			job.step = INSTALLED_STEP;
			return;
		}
		job.state = "restarting";
		job.step = "Installed. Restarting once players have had their warning";
		scheduleRestart("Update installed");
	})();
	return null;
}

/** Exits so the process manager starts the server again. Refused when nothing would restart it. */
export function restartServer(startedBy: string): string | null {
	if (!SUPERVISED) return "The server is not running under a process manager, so nothing would start it again.";
	if (job.state === "running") return "An update is running. It will restart the server when it finishes.";
	if (job.state === "restarting") return "The server is already about to restart.";
	logInfo(`[server] Restart requested from the staff panel by ${startedBy}`);
	job.state = "restarting";
	job.step = "Restarting once players have had their warning";
	scheduleRestart("Restart requested from the staff panel");
	return null;
}

/** Calls off a restart that is still counting down. An update already installed stays installed. */
export function cancelPendingRestart(cancelledBy: string): string | null {
	if (job.state !== "restarting" || !cancelRestart()) return "No restart is waiting to happen.";
	logInfo(`[server] Restart called off from the staff panel by ${cancelledBy}`);
	job.state = installed ? "needs_restart" : "idle";
	job.step = installed ? INSTALLED_STEP : "";
	return null;
}
