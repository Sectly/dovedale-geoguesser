import { auditLog } from "../../lib/audit";
import { db, type User } from "../../db";
import { ratingOf } from "./rating";
import { createRoom, duelRooms, joinRoom, leaveWaitingRoom, type DuelRoom } from "./rooms";

/** Quick Play: the first player waits; the next with the same rounds joins the closest in rating. */

type QueueEntry = { code: string; rounds: number; rating: number };

/** Players waiting alone in a quickplay room, keyed by user id. */
const queue = new Map<number, QueueEntry>();
/** Players who were matched and have yet to connect to their room. */
const matched = new Map<number, string>();

function waitingRoom(code: string): DuelRoom | null {
	const room = duelRooms.get(code);
	return room && room.status === "waiting" ? room : null;
}

export function pruneMatchmaking() {
	for (const [userId, entry] of queue) {
		if (!waitingRoom(entry.code)) queue.delete(userId);
	}
	for (const [userId, code] of matched) {
		if (!waitingRoom(code)) matched.delete(userId);
	}
}

/** Finds an opponent for the user or queues them. Returns the room to connect to. */
export function quickplay(user: User, rounds: number, canCreateRoom: () => boolean) {
	pruneMatchmaking();

	const queued = queue.get(user.id);
	if (queued) return { status: "waiting" as const, code: queued.code };
	const pending = matched.get(user.id);
	if (pending) return { status: "matched" as const, code: pending };

	const rating = ratingOf(user);
	const closestFirst = [...queue]
		.filter(([, entry]) => entry.rounds === rounds)
		.sort(([, a], [, b]) => Math.abs(a.rating - rating) - Math.abs(b.rating - rating));
	for (const [hostId, entry] of closestFirst) {
		const room = waitingRoom(entry.code);
		/** Only match into rooms whose host is actually sitting there. */
		if (!room || room.players.length !== 1 || !room.players[0].connected) continue;
		if (joinRoom(entry.code, user.id) !== "ok") continue;

		queue.delete(hostId);
		matched.set(user.id, entry.code);
		auditLog(user, "quickplay_queue", {
			targetType: "duel",
			targetId: room.dbId,
			details: `matched, room ${entry.code}, ${rounds} rounds`,
		});
		return { status: "matched" as const, code: entry.code };
	}

	if (!canCreateRoom()) return null;
	const room = createRoom(user.id, rounds, true);
	queue.set(user.id, { code: room.code, rounds, rating });
	auditLog(user, "quickplay_queue", { targetType: "duel", targetId: room.dbId, details: `queued, ${rounds} rounds` });
	return { status: "waiting" as const, code: room.code };
}

/** The player has taken their seat, so the match no longer needs tracking. */
export function markConnected(userId: number) {
	matched.delete(userId);
}

/** Leaves the quickplay queue or backs out of a match that has not started. */
export function cancelQuickplay(userId: number) {
	const code = queue.get(userId)?.code ?? matched.get(userId);
	queue.delete(userId);
	matched.delete(userId);
	/** A host whose room already filled is in neither map, so fall back to looking for their seat. */
	const room = code
		? waitingRoom(code)
		: [...duelRooms.values()].find(
				(r) => r.quickplay && r.status === "waiting" && r.players.some((p) => p.userId === userId)
			);
	if (room) leaveQuickplayRoom(room, userId);
}

/** Removes a player from a waiting room. In quickplay the player left behind goes back in the queue. */
export function leaveQuickplayRoom(room: DuelRoom, userId: number) {
	leaveWaitingRoom(room, userId);
	if (!room.quickplay) return;
	queue.delete(userId);
	const remaining = room.players[0];
	if (remaining && duelRooms.get(room.code) === room) {
		const user = db
			.query<{ duel_rating: number | null }, [number]>("SELECT duel_rating FROM users WHERE id = ?")
			.get(remaining.userId);
		queue.set(remaining.userId, { code: room.code, rounds: room.rounds, rating: ratingOf(user ?? {}) });
	}
}
