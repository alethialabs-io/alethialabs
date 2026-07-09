// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, gt } from "drizzle-orm";
import { getOwner } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeUserId } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { supportMessages } from "@/lib/db/schema";
import { getSupportMessageTransport } from "@/lib/realtime";
import { isSupportCaseVisible } from "@/lib/support/scope";

export const dynamic = "force-dynamic";

/** The customer-visible shape of a support message emitted over SSE. */
type OutMessage = {
	id: string;
	author_type: string;
	author_name: string | null;
	body: string;
	created_at: Date;
};

/**
 * SSE stream of a support case's thread. Sends the backlog since the client's
 * Last-Event-ID (the last message id it saw), then streams new customer-visible
 * messages as they are inserted (Postgres LISTEN/NOTIFY on `support_messages`).
 * Internal staff notes (is_internal=true) are NEVER emitted.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });

	const { id: caseId } = await params;

	const denied = await authorizeUserId(owner, "view", {
		type: "support_case",
		id: caseId,
	});
	if (denied) return denied;
	const actor = await getActiveScope(owner);

	// Visibility wall (tiered): authorizeUserId above proves the org-level "can view support
	// cases" capability; this confirms the caller may see THIS specific case under the
	// support RLS — the requester sees their own, owners/admins (manage_support) see any case
	// in the org. Probed on the RLS-enforced connection so the decision is the policy's, not
	// an ad-hoc user_id compare. Only then do we stream the public thread via the service role.
	if (!(await isSupportCaseVisible(actor, caseId))) {
		return new Response("Not found", { status: 404 });
	}
	const db = getServiceDb();

	const lastEventId =
		req.headers.get("last-event-id") ??
		new URL(req.url).searchParams.get("after");

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	/** Backlog: customer-visible messages created after the last-seen message id. */
	const fetchBacklog = async (afterId: string): Promise<OutMessage[]> => {
		const [cursor] = await db
			.select({ created_at: supportMessages.created_at })
			.from(supportMessages)
			.where(eq(supportMessages.id, afterId))
			.limit(1);
		if (!cursor) return [];
		return db
			.select({
				id: supportMessages.id,
				author_type: supportMessages.author_type,
				author_name: supportMessages.author_name,
				body: supportMessages.body,
				created_at: supportMessages.created_at,
			})
			.from(supportMessages)
			.where(
				and(
					eq(supportMessages.case_id, caseId),
					eq(supportMessages.is_internal, false),
					gt(supportMessages.created_at, cursor.created_at),
				),
			)
			.orderBy(asc(supportMessages.created_at), asc(supportMessages.id));
	};

	/** Fetch a single customer-visible message row by id (internal notes excluded). */
	const fetchMessage = async (messageId: string): Promise<OutMessage | null> => {
		const [row] = await db
			.select({
				id: supportMessages.id,
				author_type: supportMessages.author_type,
				author_name: supportMessages.author_name,
				body: supportMessages.body,
				created_at: supportMessages.created_at,
			})
			.from(supportMessages)
			.where(
				and(
					eq(supportMessages.id, messageId),
					eq(supportMessages.case_id, caseId),
					eq(supportMessages.is_internal, false),
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

			// Backlog since the client's Last-Event-ID (message id), oldest first.
			if (lastEventId) {
				try {
					send(await fetchBacklog(lastEventId));
				} catch {
					/* transient read error; live stream still delivers new rows */
				}
			}

			// Live: each notify carries the new message id — fetch it (visible only) and emit.
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
