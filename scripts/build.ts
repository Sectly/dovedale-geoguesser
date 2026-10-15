/**
 * The build step (`bun run build`):
 *   1. formats the code with Prettier (skip with --no-format)
 *   2. compiles the Tailwind stylesheet
 *   3. generates the app icons if missing
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

function iconSvg(size: number): string {
	return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
		<rect width="512" height="512" fill="#09090b"/>
		<circle cx="256" cy="256" r="170" fill="#2563eb"/>
		<circle cx="256" cy="256" r="118" fill="none" stroke="#fff" stroke-width="22"/>
		<path d="M320 192 L284 284 L192 320 L228 228 Z" fill="#fff"/>
		<circle cx="256" cy="256" r="16" fill="#2563eb"/>
	</svg>`;
}

function icoFile(images: { size: number; png: Buffer }[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, png }, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(size, entry);
		header.writeUInt8(size, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...images.map((image) => image.png)]);
}

async function icons() {
	for (const size of [192, 512]) {
		const path = join(PUBLIC_DIR, "icons", `icon-${size}.png`);
		if (!existsSync(path))
			await sharp(Buffer.from(iconSvg(size)))
				.png()
				.toFile(path);
	}
	const favicon = join(PUBLIC_DIR, "favicon.ico");
	if (!existsSync(favicon)) {
		const images = await Promise.all(
			[16, 32, 48].map(async (size) => ({
				size,
				png: await sharp(Buffer.from(iconSvg(size)))
					.png()
					.toBuffer(),
			}))
		);
		await Bun.write(favicon, icoFile(images));
	}
}

if (!skipFormat) await step("Formatted with Prettier", format);
await step(`Built ${STYLES_OUTPUT.replace(ROOT_DIR + "/", "")}`, buildStyles);
await step("App icons ready", icons);
