import sharp from "sharp";
import { randomBytes } from "crypto";
import { unlink } from "fs/promises";
import { join } from "path";
import { LIMITS, UPLOADS_DIR } from "../config";
import { fail } from "./http";

const ALLOWED_FORMATS = ["jpeg", "png", "webp", "gif"];

export async function saveUploadedImage(file: unknown): Promise<string> {
	if (!(file instanceof File)) fail(400, "Image required");
	if (file.size > LIMITS.uploadBytes) fail(400, "File too large (max 8MB)");

	let data: Buffer;
	try {
		const input = Buffer.from(await file.arrayBuffer());
		const meta = await sharp(input).metadata();
		if (!meta.width || !meta.height || !meta.format) throw new Error("Not a valid image");
		if (meta.width < 64 || meta.height < 64) throw new Error("Image too small (min 64×64)");
		if (!ALLOWED_FORMATS.includes(meta.format)) throw new Error("Unsupported image format");
		data = await sharp(input)
			.resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
			.webp({ quality: 85 })
			.toBuffer();
	} catch (err) {
		fail(400, `Invalid image: ${err instanceof Error ? err.message : "unknown error"}`);
	}

	const filename = `${randomBytes(16).toString("hex")}.webp`;
	await Bun.write(join(UPLOADS_DIR, filename), data);
	return filename;
}

export async function deleteUpload(filename: string | null | undefined) {
	if (!filename || !/^[\w.-]+$/.test(filename)) return;
	await unlink(join(UPLOADS_DIR, filename)).catch(() => {});
}

export function uploadUrl(filename: string): string {
	return `/uploads/${filename}`;
}
