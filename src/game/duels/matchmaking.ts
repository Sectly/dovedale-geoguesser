import { auditLog } from "../../lib/audit";
import { db, type User } from "../../db";
import { ratingOf } from "./rating";
import { createRoom, duelRooms, joinRoom, leaveWaitingRoom, type DuelRoom } from "./rooms";

type QueueEntry = { code: string; rounds: number; rating: number };

const queue = new Map<number, QueueEntry>();
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

export function markConnected(userId: number) {
	matched.delete(userId);
}

export function cancelQuickplay(userId: number) {
	const code = queue.get(userId)?.code ?? matched.get(userId);
	queue.delete(userId);
	matched.delete(userId);
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
