/** Minimal typings for the parts of WebWire this project uses; the packages ship none. */
declare module "@webwirejs/server" {
	export class WireConnection {
		/** Whatever the server's `authenticate` hook returned for this connection. */
		auth: unknown;
		on(event: string, listener: (data: any) => void): this;
		emit(event: string, data: unknown): void;
		close(code?: number, reason?: string): void;
	}

	export class WebWireServer {
		constructor(options?: {
			authenticate?: (ctx: { token?: unknown; request?: unknown }) => Promise<unknown>;
			heartbeat?: boolean | { interval?: number; timeout?: number };
		});
		on(event: "connection", listener: (conn: WireConnection) => void): this;
		close(): void;
	}
}

declare module "@webwirejs/hono" {
	import type { Hono } from "hono";
	import type { WebWireServer } from "@webwirejs/server";
	export function webwire(server: WebWireServer, upgradeWebSocket: unknown): Hono;
}
