import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./config";

/** Database backups in data/backups. Each kind has a limit; the oldest are removed. */

export const BACKUP_DIR = join(DATA_DIR, "backups");

/** How many of each kind are kept. */
export const BACKUP_LIMITS = {
	/** One a day, made by the hourly maintenance job. */
	daily: 7,
	/** Made before a release changes existing data. */
	upgrade: 3,
	/** Made before an update is installed from the staff panel. */
	update: 3,
	/** Made by an operator from the staff panel. */
	manual: 5,
} as const;

export type BackupKind = keyof typeof BACKUP_LIMITS;

const NAME = /^(daily|upgrade|update|manual)-[A-Za-z0-9._-]{1,60}\.sqlite$/;

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

export function listBackups() {
	if (!existsSync(BACKUP_DIR)) return [];
	return readdirSync(BACKUP_DIR)
		.filter((name) => NAME.test(name))
		.map((name) => {
			const stat = statSync(join(BACKUP_DIR, name));
			return {
				name,
				kind: name.split("-")[0] as BackupKind,
				size: stat.size,
				created_at: Math.floor(stat.mtimeMs / 1000),
			};
		})
		.sort((a, b) => b.created_at - a.created_at || b.name.localeCompare(a.name));
}

/** Removes the oldest backups of a kind beyond its limit. */
function prune(kind: BackupKind) {
	const ofKind = listBackups().filter((b) => b.kind === kind);
	for (const old of ofKind.slice(BACKUP_LIMITS[kind])) unlinkSync(join(BACKUP_DIR, old.name));
}

/** Writes a consistent copy of the live database, whatever is still in its write-ahead log. */
export function createBackup(db: Database, kind: BackupKind, label = stamp()): string {
	mkdirSync(BACKUP_DIR, { recursive: true });
	const name = `${kind}-${label}.sqlite`;
	if (!NAME.test(name)) throw new Error(`Invalid backup name: ${name}`);
	const path = join(BACKUP_DIR, name);
	if (existsSync(path)) unlinkSync(path);
	db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
	prune(kind);
	return name;
}

/** Makes today's daily backup if there is not one yet. Returns its name when one was made. */
export function ensureDailyBackup(db: Database, today = new Date().toISOString().slice(0, 10)): string | null {
	if (existsSync(join(BACKUP_DIR, `daily-${today}.sqlite`))) return null;
	return createBackup(db, "daily", today);
}

/** The full path of a backup, or null when the name is not one of ours (no paths, no other files). */
export function backupPath(name: string): string | null {
	if (!NAME.test(name)) return null;
	const path = join(BACKUP_DIR, name);
	return existsSync(path) ? path : null;
}

export function deleteBackup(name: string): boolean {
	const path = backupPath(name);
	if (!path) return false;
	unlinkSync(path);
	return true;
}
