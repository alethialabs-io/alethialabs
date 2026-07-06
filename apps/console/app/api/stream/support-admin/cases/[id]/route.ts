// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, gt } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { supportCases, supportMessages } from "@/lib/db/schema";
import { getSupportMessageTransport } from "@/lib/realtime";
import { getSupportStaff } from "@/lib/support/staff";

export const dynamic = "force-dynamic";

/** The staff-visible shape of a support message over SSE — includes the internal flag. */
type OutMessage = {
	id: string;
	author_type: string;
	author_name: string | null;
	body: string;
	is_internal: boolean;
	created_at: Date;
};

/**
 * Staff SSE stream of a case's thread. Cross-tenant: gated by the support-staff allowlist
 * (not org membership), reads via getServiceDb, and — unlike the customer stream — emits
 * ALL messages INCLUDING is_internal staff notes. Backlog since Last-Event-ID, then live
 * inserts via Postgres LISTEN/NOTIFY on `support_messages`.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const staff = await getSupportStaff();
	if (!staff) return new Response("Not found", { status: 404 });

	const { id: caseId } = await params;
	const db = getServiceDb();

	const [supportCase] = await db
		.select({ id: supportCases.id })
		.from(supportCases)
		.where(eq(supportCases.id, caseId))
		.limit(1);
	if (!supportCase) return new Response("Not found", { status: 404 });

	const lastEventId =
		req.headers.get("last-event-id") ??
		new URL(req.url).searchParams.get("after");

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const MESSAGE_COLS = {
		id: supportMessages.id,
		author_type: supportMessages.author_type,
		author_name: supportMessages.author_name,
		body: supportMessages.body,
		is_internal: supportMessages.is_internal,
		created_at: supportMessages.created_at,
	};

	/** Backlog: all messages (incl. internal) created after the last-seen message id. */
	const fetchBacklog = async (afterId: string): Promise<OutMessage[]> => {
		const [cursor] = await db
			.select({ created_at: supportMessages.created_at })
			.from(supportMessages)
			.where(eq(supportMessages.id, afterId))
			.limit(1);
		if (!cursor) return [];
		return db
			.select(MESSAGE_COLS)
			.from(supportMessages)
			.where(
				and(
					eq(supportMessages.case_id, caseId),
					gt(supportMessages.created_at, cursor.created_at),
				),
			)
			.orderBy(asc(supportMessages.created_at), asc(supportMessages.id));
	};

	/** Fetch a single message row by id (internal notes included for staff). */
	const fetchMessage = async (messageId: string): Promise<OutMessage | null> => {
		const [row] = await db
			.select(MESSAGE_COLS)
			.from(supportMessages)
			.where(
				and(
					eq(supportMessages.id, messageId),
					eq(supportMessages.case_id, caseId),
				),
			)
			.limit(1);
		return row ?? null;
	};

	const stream = new ReadableStream({
		async start(controller) {
			const send = (rows: OutMessage[]) => {
				for (const r of rows) {
					controller.enqueue(
						encoder.encode(`id: ${r.id}\ndata: ${JSON.stringify(r)}\n\n`),
					);
				}
			};

			if (lastEventId) {
				try {
					send(await fetchBacklog(lastEventId));
				} catch {
					/* transient read error; live stream still delivers new rows */
				}
			}

			unsubscribe = getSupportMessageTransport().subscribe(caseId, (messageId) => {
				if (closed) return;
				void (async () => {
					try {
						const row = await fetchMessage(messageId);
						if (row && !closed) send([row]);
					} catch {
						/* transient read error; the next message retries */
					}
				})();
			});

			heartbeat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(":\n\n"));
			}, 20_000);

			req.signal.addEventListener("abort", () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			cleanup();
		},
	});

	function cleanup() {
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		if (unsubscribe) unsubscribe();
	}

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
