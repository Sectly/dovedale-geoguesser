import { existsSync } from "fs";
import { join } from "path";
import { PUBLIC_DIR, ROOT_DIR } from "./config";

/**
 * Compiles the Tailwind stylesheet from the classes used in public/. Built when missing, and kept fresh in
 * development.
 */

export const STYLES_OUTPUT = join(PUBLIC_DIR, "css", "tailwind.css");

function tailwind(extraArgs: string[]) {
	return Bun.spawn(
		[
			process.execPath,
			"x",
			"tailwindcss",
			"-c",
			join(ROOT_DIR, "tailwind.config.js"),
			"-i",
			join(ROOT_DIR, "styles", "tailwind.css"),
			"-o",
			STYLES_OUTPUT,
			...extraArgs,
		],
		{ cwd: ROOT_DIR, stdout: "ignore", stderr: "pipe" }
	);
}

/** Builds the stylesheet once. Throws with Tailwind's own message if it fails. */
export async function buildStyles() {
	const proc = tailwind(["--minify"]);
	if ((await proc.exited) !== 0) throw new Error(`Tailwind build failed:\n${await new Response(proc.stderr).text()}`);
}

export async function ensureStyles() {
	if (!existsSync(STYLES_OUTPUT)) await buildStyles();
}

/** Rebuilds whenever a page or script changes. Used by `bun run dev`. */
export function watchStyles() {
	const proc = tailwind(["--watch"]);
	process.on("exit", () => proc.kill());
}
