import type { User } from "../db";
import { displayName } from "./webhook";

/** Who has what open in the staff panel. In memory: a courtesy marker, never a lock. */

export const CLAIM_KINDS = ["submission", "ticket"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type Claim = { kind: ClaimKind; id: number; staff_id: number; name: string; at: number };

/** A claim nobody has renewed for this long is dropped. The panel renews it while the item stays open. */
const CLAIM_MS = 90_000;

const claims = new Map<number, Claim>();

export function setClaim(staff: User, kind: ClaimKind, id: number) {
	claims.set(staff.id, { kind, id, staff_id: staff.id, name: displayName(staff), at: Date.now() });
}

export function releaseClaim(staffId: number) {
	claims.delete(staffId);
}

export function liveClaims(): Claim[] {
	const cutoff = Date.now() - CLAIM_MS;
	for (const [staffId, claim] of claims) if (claim.at < cutoff) claims.delete(staffId);
	return [...claims.values()];
}
