// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reads behind the MCP design tools' revision and idempotency (lib/ai/mcp/design.ts).
//
// A project's design REVISION is the id of its latest design-write audit row (`CREATED` or
// `UPDATED`), the same number the board's review reads (lib/rpc/procedures/canvas.ts). Audit rows are
// append-only, so the revision only ever grows, and any design write moves it.
//
// A design tool's IDEMPOTENCY KEY is recorded on the audit row its write produced (`changes.
// idempotency_key`, see `DesignWriteOptions` in app/server/actions/projects.ts) as a SHA-256 over the
// organisation, the person and the caller's key. A repeated call finds that row and answers with the
// revision it made. Every read runs under the actor's RLS scope: the audit policy admits only rows of
// the actor's own organisation's projects.

import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { auditLog, projects } from "@/lib/db/schema";

/** The audit actions that write a design. */
const DESIGN_WRITE_ACTIONS = ["CREATED", "UPDATED"] as const;

/** The value a design write records for `key`, bound to the caller's organisation and person. */
export function designKeyHash(actor: Actor, key: string): string {
	return createHash("sha256").update(`design:${actor.orgId}:${actor.userId}:${key}`).digest("hex");
}

/** The project's design revision: the id of its latest design-write audit row, or 0. */
export async function readDesignRevision(actor: Actor, projectId: string): Promise<number> {
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(and(eq(auditLog.project_id, projectId), inArray(auditLog.action, [...DESIGN_WRITE_ACTIONS])))
			.orderBy(desc(auditLog.id))
			.limit(1);
		return row?.id ?? 0;
	});
}

/** The design write of project `projectId` that recorded `keyHash`: its revision, or null. */
export async function findKeyedDesignWrite(
	actor: Actor,
	projectId: string,
	keyHash: string,
): Promise<number | null> {
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.project_id, projectId),
					inArray(auditLog.action, [...DESIGN_WRITE_ACTIONS]),
					sql`${auditLog.changes}->>'idempotency_key' = ${keyHash}`,
				),
			)
			.orderBy(desc(auditLog.id))
			.limit(1);
		return row?.id ?? null;
	});
}

/**
 * The project of the actor's organisation named `name` (names are unique per organisation, ignoring
 * case and surrounding space), or null.
 */
export async function findProjectByName(actor: Actor, name: string): Promise<string | null> {
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(
				and(eq(projects.org_id, actor.orgId), sql`lower(${projects.project_name}) = lower(${name.trim()})`),
			)
			.limit(1);
		return row?.id ?? null;
	});
}
