import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Every test run gets a throwaway database and uploads folder. */
const dir = mkdtempSync(join(tmpdir(), "dovedale-test-"));
process.env.DATA_DIR = join(dir, "data");
process.env.UPLOADS_DIR = join(dir, "uploads");
process.env.AUTH_DEV = "false";
process.env.SITE_URL = "";
process.env.OPERATOR_IDS = "";
process.env.MODERATOR_IDS = "";
delete process.env.DISCORD_WEBHOOK_URL;

/** Pages reference the compiled stylesheet, so make sure it has been built. */
const { ensureStyles } = await import("../src/styles");
await ensureStyles();
