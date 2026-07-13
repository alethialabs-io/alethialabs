// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runs a platform-operator mutation with break-glass WORM discipline: a committed `attempt` row
// (with the REQUIRED reason) is written BEFORE the act — so a mutation that crashes mid-flight is
// still on record — and a `result` row (ok|error) after. Both rows go to platform_audit via the
// service connection; the table's trigger makes them immutable even to that role.

import type { PlatformAuditInput } from "@repo/platform/types";
import { platformAudit } from "@repo/platform/schema";
import { getServiceDb } from "@/lib/db";

/**
 * @param actor   the operator's email (from assertPlatformAdmin).
 * @param action  a stable slug, e.g. "grant_enterprise" | "create_enterprise_org" | "revoke_contract".
 * @param orgId   the target org, or null for a create (the id is the result).
 * @param reason  REQUIRED free-text justification — throws if blank.
 */
export async function withPlatformAudit<T>(
	actor: string,
	action: string,
	orgId: string | null,
	reason: string,
	input: PlatformAuditInput,
	run: () => Promise<T>,
): Promise<T> {
	if (!reason?.trim()) throw new Error("A reason is required for operator actions.");
	const db = getServiceDb();
	await db.insert(platformAudit).values({
		actorEmail: actor,
		action,
		targetOrgId: orgId,
		input,
		reason: reason.trim(),
		phase: "attempt",
	});
	try {
		const out = await run();
		await db.insert(platformAudit).values({
			actorEmail: actor,
			action,
			targetOrgId: orgId,
			input,
			reason: reason.trim(),
			phase: "result",
			outcome: "ok",
		});
		return out;
	} catch (err) {
		await db.insert(platformAudit).values({
			actorEmail: actor,
			action,
			targetOrgId: orgId,
			input,
			reason: reason.trim(),
			phase: "result",
			outcome: "error",
			detail: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}
