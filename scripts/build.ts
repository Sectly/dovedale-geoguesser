/**
 * The build step: `bun run build`.
 *   1. formats the code with Prettier (skip with --no-format, as deploys do)
 *   2. compiles the Tailwind stylesheet into public/css/tailwind.css
 *   3. generates the app icons if they are missing
 */
import sharp from "sharp";
import { existsSync } from "fs";
import { join } from "path";
import { PUBLIC_DIR, ROOT_DIR } from "../src/config";
import { buildStyles, STYLES_OUTPUT } from "../src/styles";

const skipFormat = process.argv.includes("--no-format");

async function step(name: string, run: () => Promise<unknown>) {
	const start = performance.now();
	await run();
	console.log(`${name} (${Math.round(performance.now() - start)}ms)`);
}

async function format() {
	const proc = Bun.spawn([process.execPath, "x", "prettier", "--write", "--log-level", "warn", "."], {
		cwd: ROOT_DIR,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error("Formatting failed");
}

/** The compass mark on the brand blue, with enough margin to survive being cropped to a circle. */
function iconSvg(size: number): string {
	return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
		<rect width="512" height="512" fill="#09090b"/>
		<circle cx="256" cy="256" r="170" fill="#2563eb"/>
		<circle cx="256" cy="256" r="118" fill="none" stroke="#fff" stroke-width="22"/>
		<path d="M320 192 L284 284 L192 320 L228 228 Z" fill="#fff"/>
		<circle cx="256" cy="256" r="16" fill="#2563eb"/>
	</svg>`;
}

async function icons() {
	for (const size of [192, 512]) {
		const path = join(PUBLIC_DIR, "icons", `icon-${size}.png`);
		if (!existsSync(path))
			await sharp(Buffer.from(iconSvg(size)))
				.png()
				.toFile(path);
	}
}

if (!skipFormat) await step("Formatted with Prettier", format);
await step(`Built ${STYLES_OUTPUT.replace(ROOT_DIR + "/", "")}`, buildStyles);
await step("App icons ready", icons);
