// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import {
	type Hint,
	PROTOCOL_VERSION,
	type ResyncReason,
	type RevokedReason,
} from "./topics";

// The frames of `/{org}/~/events` (#6115). Every frame is built here and nowhere else, so what can
// reach the wire is exactly what these functions write: a topic name, a row uuid, a cursor (a
// decimal counter), a boot uuid and a fixed reason word. A notice's org, owner and project ids are
// never an argument to anything in this file.

/** A comment frame. Sent every 20 s, well under Cloudflare's 125 s proxy read timeout (ADR 0005 D3). */
export const HEARTBEAT_FRAME = ":\n\n";

/** The response headers of an event stream. `no-transform` + `X-Accel-Buffering` keep proxies from buffering it. */
export const EVENT_STREAM_HEADERS: Readonly<Record<string, string>> = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "private, no-cache, no-transform",
	"X-Accel-Buffering": "no",
	Connection: "keep-alive",
};

/**
 * The client's reconnect delay: 3–8 s, drawn per stream so a deploy that drops every stream at once
 * does not bring them all back in the same second (ADR 0005 §10 R9).
 */
export function retryDelayMs(random: () => number = Math.random): number {
	return 3000 + Math.floor(random() * 5000);
}

/** `retry:` — the reconnect delay the browser's SSE parser honours. */
export function retryFrame(ms: number): string {
	return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}

/** `hello` — the first event on every stream. */
export function helloFrame(boot: string, cursor: string): string {
	return `event: hello\ndata: ${JSON.stringify({ v: PROTOCOL_VERSION, boot, cursor })}\n\n`;
}

/** `hint` — one invalidation hint. The object is rebuilt from `t` and `id` so no other field can ride along. */
export function hintFrame(hint: Hint, cursor: string): string {
	const data = hint.id === undefined ? { t: hint.t } : { t: hint.t, id: hint.id };
	return `event: hint\nid: ${cursor}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** `resync` — invalidate everything this org's client shows. */
export function resyncFrame(reason: ResyncReason, cursor: string): string {
	return `event: resync\nid: ${cursor}\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/** `revoked` — the stream ends and must not simply be reopened. */
export function revokedFrame(reason: RevokedReason): string {
	return `event: revoked\ndata: ${JSON.stringify({ reason })}\n\n`;
}
