// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Durable connector-credential health, updated at point of use (no polling). markFailed
// records the failure and emits `system.connector.token_failed` ONCE per transition (and
// re-alerts after a window) via an atomic claim on `alerted_at` — race-safe across
// instances. markHealthy clears on recovery. Both are best-effort: they never throw into
// the caller. See dataroom/spec/mvp/25-alerting-notifications.md.

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { connectorHealth } from "@/lib/db/schema";
import type { ConnectorHealthKind } from "@/lib/db/schema/enums";

export interface HealthScope {
	userId: string;
	orgId: string;
}

// Re-alert window: while a credential stays failed, alert again at most this often.
const REALERT_INTERVAL = sql`interval '24 hours'`;

/**
 * Records a credential as failed and emits `system.connector.token_failed` exactly once
 * per transition (or once per re-alert window). The conditional UPDATE on `alerted_at`
 * is the claim: only the caller whose UPDATE returns a row emits.
 */
export async function markFailed(
	scope: HealthScope,
	kind: ConnectorHealthKind,
	provider: string,
	error?: string,
): Promise<void> {
	try {
		const db = getServiceDb();
		await db
			.insert(connectorHealth)
			.values({
				org_id: scope.orgId,
				user_id: scope.userId,
				kind,
				provider,
				status: "failed",
				last_error: error ?? null,
			})
			.onConflictDoUpdate({
				target: [
					connectorHealth.user_id,
					connectorHealth.kind,
					connectorHealth.provider,
				],
				set: {
					status: "failed",
					last_error: error ?? null,
					last_checked_at: new Date(),
					org_id: scope.orgId,
					updated_at: new Date(),
				},
			});

		// Atomic transition claim: win the alert only on the edge into failed (or after
		// the re-alert window). Concurrent callers see alerted_at already set and skip.
		const [claimed] = await db
			.update(connectorHealth)
			.set({ alerted_at: new Date() })
			.where(
				and(
					eq(connectorHealth.user_id, scope.userId),
					eq(connectorHealth.kind, kind),
					eq(connectorHealth.provider, provider),
					eq(connectorHealth.status, "failed"),
					or(
						isNull(connectorHealth.alerted_at),
						lt(connectorHealth.alerted_at, sql`now() - ${REALERT_INTERVAL}`),
					),
				),
			)
			.returning({ id: connectorHealth.id });

		if (claimed) {
			emitAlertEventSafe(scope.orgId, "system.connector.token_failed", {
				title: `Connector credential failed: ${provider}`,
				summary: error,
				severity: "warning",
				actor_id: scope.userId,
				connector_slug: provider,
			});
		}
	} catch (err) {
		console.error("[connector-health] markFailed failed for provider:", provider, err);
	}
}

/** Clears a previously-failed credential back to healthy (writes only on recovery). */
export async function markHealthy(
	scope: HealthScope,
	kind: ConnectorHealthKind,
	provider: string,
): Promise<void> {
	try {
		await getServiceDb()
			.update(connectorHealth)
			.set({
				status: "healthy",
				last_error: null,
				alerted_at: null,
				last_checked_at: new Date(),
				updated_at: new Date(),
			})
			.where(
				and(
					eq(connectorHealth.user_id, scope.userId),
					eq(connectorHealth.kind, kind),
					eq(connectorHealth.provider, provider),
					eq(connectorHealth.status, "failed"),
				),
			);
	} catch (err) {
		console.error("[connector-health] markHealthy failed for provider:", provider, err);
	}
}
