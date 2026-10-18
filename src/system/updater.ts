import { ROOT_DIR } from "../config";
import { createBackup } from "../backups";
import { db } from "../db";
import { SUPERVISED } from "../lib/lifecycle";
import { logInfo } from "../lib/logs";
import { cancelRestart, restartIn, scheduleRestart } from "./restart";

/** Branch that panel updates fast-forward to: UPDATE_BRANCH, or main. */

const BRANCH = /^[\w./-]{1,80}$/.test(process.env.UPDATE_BRANCH ?? "") ? process.env.UPDATE_BRANCH! : "main";
const REMOTE = "origin";
/** Set PANEL_UPDATES=off to remove the feature entirely. */
export const UPDATES_ENABLED = (process.env.PANEL_UPDATES ?? "on").toLowerCase() !== "off";

type Result = { ok: boolean; out: string; streamed?: boolean };

/** Runs a command in the checkout. With `onLine`, each line of output is handed over as it is printed. */
async function run(cmd: string[], timeoutMs = 60_000, onLine?: (line: string) => void): Promise<Result> {
	try {
		const proc = Bun.spawn({
			cmd,
			cwd: ROOT_DIR,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const read = async (stream: ReadableStream<Uint8Array>) => {
			let all = "";
			let partial = "";
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true });
				all += text;
				if (!onLine) continue;
				const lines = (partial + text).split(/\r?\n|\r/);
				partial = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) onLine(line);
			}
			if (onLine && partial.trim()) onLine(partial);
			return all;
		};
		const [out, err, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
		clearTimeout(timer);
		return { ok: code === 0, out: `${out}${err}`.trim(), streamed: !!onLine };
	} catch (err) {
		return { ok: false, out: err instanceof Error ? err.message : String(err) };
	}
}

const git = (...args: string[]) => run(["git", ...args]);

export type Commit = { hash: string; subject: string; author: string; date: number };

/** A file changed on the server, and whether only its permissions changed (a chmod, say). */
export type LocalChange = { path: string; permissions_only: boolean };

/** `git status --porcelain` lines, with `git diff --summary` telling permission-only changes apart. */
export function parseLocalChanges(status: string, summary: string): LocalChange[] {
	const modeOnly = new Set([...summary.matchAll(/^\s*mode change \d+ => \d+ (.+)$/gm)].map((m) => m[1].trim()));
	return status
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => line.trim().replace(/^\S+\s+/, ""))
		.map((path) => ({ path, permissions_only: modeOnly.has(path) }));
}

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
	const [branch, dirty, summary, current, behind, ahead] = await Promise.all([
		git("rev-parse", "--abbrev-ref", "HEAD"),
		git("status", "--porcelain", "--untracked-files=no"),
		git("diff", "--summary"),
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
		local_files: parseLocalChanges(dirty.out, summary.out).slice(0, 20),
		fetch_error: fetchError,
		checked_at: lastFetch ? Math.floor(lastFetch / 1000) : null,
		restart_in: restartIn(),
		job,
	};
}

type StepState = "waiting" | "running" | "done" | "failed";
type Step = { name: string; state: StepState; started_at: number | null; ended_at: number | null };

type Job = {
	/** A panel update, or a restart on its own. */
	kind: "update" | "restart";
	state: "idle" | "running" | "failed" | "restarting" | "needs_restart" | "done";
	step: string;
	steps: Step[];
	log: string[];
	started_at: number | null;
	ended_at: number | null;
	started_by: string | null;
	/** The version being installed, and the one it replaces. */
	from: string | null;
	to: string | null;
};

const STEP_NAMES = [
	"Backing up the database",
	"Downloading the update",
	"Installing dependencies",
	"Building styles",
	"Building map tiles",
	"Copying the icon font",
] as const;

/** The last step of an update, and the only one of a plain restart. It ends when the new server is up. */
const RESTART_STEP = "Restarting the server";

const JOB_KEY = "last_update";
const LOG_LINES = 400;
const nowSecs = () => Math.floor(Date.now() / 1000);

function blankJob(): Job {
	return {
		kind: "update",
		state: "idle",
		step: "",
		steps: [],
		log: [],
		started_at: null,
		ended_at: null,
		started_by: null,
		from: null,
		to: null,
	};
}

/** Kept in the database, so the record of an update survives the restart that finishes it. */
function saveJob() {
	try {
		db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [JOB_KEY, JSON.stringify(job)]);
	} catch {}
}

/** The last update, as left by the server before this one. One that was restarting has now finished. */
function loadJob(): Job {
	try {
		const row = db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(JOB_KEY);
		if (!row) return blankJob();
		const saved = { ...blankJob(), ...(JSON.parse(row.value) as Partial<Job>) };
		if (saved.state === "restarting" || saved.state === "needs_restart") {
			saved.state = "done";
			saved.step = saved.kind === "restart" ? "Restarted" : "Updated and restarted";
			saved.ended_at = nowSecs();
			const restart = restartStepOf(saved);
			restart.state = "done";
			restart.started_at ??= saved.ended_at;
			restart.ended_at = saved.ended_at;
			saved.log.push(`${stamp(saved)} The server is back up`);
		}
		if (saved.state === "running") {
			saved.state = "failed";
			saved.log.push(`${stamp(saved)} The server stopped before the update finished`);
			for (const step of saved.steps) if (step.state === "running") step.state = "failed";
		}
		return saved;
	} catch {
		return blankJob();
	}
}

function restartStepOf(of: Job): Step {
	let step = of.steps.find((s) => s.name === RESTART_STEP);
	if (!step) of.steps.push((step = { name: RESTART_STEP, state: "waiting", started_at: null, ended_at: null }));
	return step;
}

/** Marks the restart step as under way, from the start of the players' warning. */
function beginRestartStep() {
	const step = restartStepOf(job);
	step.state = "running";
	step.started_at = nowSecs();
	step.ended_at = null;
	note(`> ${RESTART_STEP}`);
	logInfo(`[update] ${RESTART_STEP}`);
}

/** Time since the update started, as "1:05", for the start of each log line. */
function stamp(of: Job = job): string {
	const seconds = of.started_at ? Math.max(0, nowSecs() - of.started_at) : 0;
	return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}]`;
}

function note(line: string) {
	for (const part of line.split("\n")) {
		if (!part.trim()) continue;
		job.log.push(`${stamp()} ${part}`);
	}
	if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
}

const job: Job = loadJob();
/** True once an update has been installed that the running server has not restarted into. */
let installed = false;
const INSTALLED_STEP = "Installed. Restart the server to finish.";

const shortHash = async () => (await git("rev-parse", "--short", "HEAD")).out || null;

/** Backs up, fast-forwards, installs, rebuilds styles and tiles, restarts. Stops at the first failure. */
export async function runUpdate(startedBy: string): Promise<string | null> {
	if (!UPDATES_ENABLED) return "Updates from the panel are switched off on this server.";
	if (job.state === "running" || job.state === "restarting") return "An update is already running.";
	const status = await updateStatus(true);
	if (!status.available) return status.reason;
	if (status.local_changes)
		return `Files on the server have been edited by hand (${status.local_files.map((f) => f.path).join(", ")}). Commit or discard them first.`;
	if (status.branch !== BRANCH) return `The server is on branch "${status.branch}", not "${BRANCH}".`;
	if (status.ahead) return "The server has commits the remote does not. Sort that out by hand first.";
	if (!status.pending.length) return "Already up to date.";

	Object.assign(job, blankJob(), {
		state: "running",
		steps: [...STEP_NAMES, RESTART_STEP].map((name) => ({
			name,
			state: "waiting",
			started_at: null,
			ended_at: null,
		})),
		started_at: nowSecs(),
		started_by: startedBy,
		from: await shortHash(),
		to: status.pending[0].hash.slice(0, 7),
	});
	note(`Update started by ${startedBy}: ${status.pending.length} commit(s), ${job.from} to ${job.to}`);
	logInfo(`[update] Started by ${startedBy}: ${status.pending.length} commit(s), ${job.from} to ${job.to}`);
	saveJob();

	void (async () => {
		const actions: Record<(typeof STEP_NAMES)[number], () => Promise<Result>> = {
			"Backing up the database": async () => ({ ok: true, out: `Saved ${createBackup(db, "update")}` }),
			"Downloading the update": () => git("pull", "--ff-only", REMOTE, BRANCH),
			"Installing dependencies": () => run([process.execPath, "install"], 300_000, note),
			"Building styles": () => run([process.execPath, "run", "build:css"], 300_000, note),
			"Building map tiles": () => run([process.execPath, "run", "tiles"], 30 * 60_000, note),
			/** Its script never fails the update: the server copies the font on the first page view instead. */
			"Copying the icon font": () => run([process.execPath, "run", "icons"], 120_000, note),
		};
		for (const step of job.steps.filter((s) => s.name !== RESTART_STEP)) {
			job.step = step.name;
			step.state = "running";
			step.started_at = nowSecs();
			note(`> ${step.name}`);
			logInfo(`[update] ${step.name}`);
			saveJob();
			let result: Result;
			try {
				result = await actions[step.name as (typeof STEP_NAMES)[number]]();
			} catch (err) {
				result = { ok: false, out: err instanceof Error ? err.message : String(err) };
			}
			step.ended_at = nowSecs();
			if (result.out && !result.streamed) note(result.out.slice(-4000));
			if (!result.ok) {
				step.state = "failed";
				job.state = "failed";
				job.ended_at = nowSecs();
				note(`Failed at "${step.name}". The server was not restarted.`);
				console.error(
					`[update] "${step.name}" failed. The server was not restarted.\n${result.out.slice(-2000)}`
				);
				saveJob();
				return;
			}
			step.state = "done";
			note(`Done in ${step.ended_at - (step.started_at ?? step.ended_at)}s`);
			saveJob();
		}
		logInfo(`[update] Installed ${job.to}, started by ${startedBy}`, job.log.join("\n"));
		installed = true;
		if (!SUPERVISED) {
			job.state = "needs_restart";
			job.step = INSTALLED_STEP;
			note(INSTALLED_STEP);
			saveJob();
			return;
		}
		job.state = "restarting";
		job.step = "Installed. Restarting once players have had their warning";
		note(job.step);
		beginRestartStep();
		saveJob();
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
	if (!installed) Object.assign(job, blankJob(), { kind: "restart", started_at: nowSecs(), started_by: startedBy });
	job.state = "restarting";
	job.step = "Restarting once players have had their warning";
	note(`Restart requested by ${startedBy}`);
	beginRestartStep();
	saveJob();
	scheduleRestart("Restart requested from the staff panel");
	return null;
}

/** Calls off a restart that is still counting down. An update already installed stays installed. */
export function cancelPendingRestart(cancelledBy: string): string | null {
	if (job.state !== "restarting" || !cancelRestart()) return "No restart is waiting to happen.";
	logInfo(`[server] Restart called off from the staff panel by ${cancelledBy}`);
	job.state = installed ? "needs_restart" : "idle";
	job.step = installed ? INSTALLED_STEP : "";
	note(`Restart called off by ${cancelledBy}`);
	Object.assign(restartStepOf(job), { state: "waiting", started_at: null, ended_at: null });
	saveJob();
	return null;
}
