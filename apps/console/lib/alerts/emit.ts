// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ingest seam (dataroom/spec/mvp/25-alerting-notifications.md). `emitActionEvent` is called
// from the single PDP chokepoint (enforceDecision) for EVERY decision, so any action is
// alertable by config; system sources call `emitAlertEvent` with a `system.*` key.
// emitAlertEvent matches the org's enabled rules (cached) by event-key glob + field
// `match`, gates `authz.*` keys on advancedAlerting, applies the per-rule throttle, fans
// out to bound channels as `pending` deliveries, and dispatches. Fire-and-forget — a
// notification failure can never fail a deploy or an authz decision.

import { and, eq, gt, ne } from "drizzle-orm";
import { resolveOrgEntitlements } from "@/lib/billing/queries";
import { getServiceDb } from "@/lib/db";
import {
	alertDeliveries,
	alertRuleChannels,
	type AlertRule,
	type NewAlertDelivery,
} from "@/lib/db/schema";
import type { Action, Resource } from "@/lib/authz/registry";
import type { Actor } from "@/lib/authz/types";
import type { AlertEventContext } from "@/types/database-custom.types";
import { authzEventKey, eventMatches, isSecurityKey, labelForKey } from "./catalog";
import { dispatchDeliveries } from "./dispatch";
import { matchesRule, meetsSeverity } from "./events";
import { getEnabledRules } from "./rule-cache";

/** The event "subject" — distinguishes throttle buckets within one rule+channel. */
function subjectOf(context: AlertEventContext): string {
	return (
		context.resource_id ??
		context.job_id ??
		context.project_id ??
		context.connector_slug ??
		""
	);
}

/**
 * Emits an event for an org against its configured rules. Returns the number of
 * deliveries created. No-op (and no insert) when no rule matches.
 */
export async function emitAlertEvent(
	orgId: string,
	eventKey: string,
	context: AlertEventContext,
): Promise<number> {
	const rules = await getEnabledRules(orgId);
	if (rules.length === 0) return 0;

	const matched = rules.filter(
		(r) =>
			r.event_patterns.some((p) => eventMatches(p, eventKey)) &&
			matchesRule(r.match, context, context.severity ?? r.severity),
	);
	if (matched.length === 0) return 0;

	// Open-core gate: PDP-sourced (authz.*) events require enterprise (advancedAlerting).
	if (isSecurityKey(eventKey)) {
		const entitlements = await resolveOrgEntitlements(orgId);
		if (!entitlements.advancedAlerting) return 0;
	}

	const db = getServiceDb();
	const subject = subjectOf(context);
	const rows: NewAlertDelivery[] = [];

	for (const rule of matched) {
		const severity = context.severity ?? rule.severity;
		const channels = await db
			.select({
				channel_id: alertRuleChannels.channel_id,
				min_severity: alertRuleChannels.min_severity,
			})
			.from(alertRuleChannels)
			.where(eq(alertRuleChannels.rule_id, rule.id));

		for (const { channel_id, min_severity } of channels) {
			// Per-channel routing floor: skip channels that only want higher severities.
			if (min_severity && !meetsSeverity(severity, min_severity)) continue;
			const dedupeKey = `${rule.id}:${channel_id}:${eventKey}:${subject}`;
			if (await isThrottled(rule, dedupeKey)) continue;
			rows.push({
				org_id: orgId,
				rule_id: rule.id,
				channel_id,
				event_key: eventKey,
				dedupe_key: dedupeKey,
				context: { ...context, severity },
				status: "pending",
			});
		}
	}
	if (rows.length === 0) return 0;

	const inserted = await db.insert(alertDeliveries).values(rows).returning();
	void dispatchDeliveries(inserted);
	return inserted.length;
}

/** True if a non-dead delivery with this dedupe_key exists inside the rule's window. */
async function isThrottled(rule: AlertRule, dedupeKey: string): Promise<boolean> {
	if (rule.throttle_seconds <= 0) return false;
	const since = new Date(Date.now() - rule.throttle_seconds * 1000);
	const [recent] = await getServiceDb()
		.select({ id: alertDeliveries.id })
		.from(alertDeliveries)
		.where(
			and(
				eq(alertDeliveries.dedupe_key, dedupeKey),
				ne(alertDeliveries.status, "dead"),
				gt(alertDeliveries.created_at, since),
			),
		)
		.limit(1);
	return Boolean(recent);
}

/** Fire-and-forget wrapper for hot paths; never throws into the caller. */
export function emitAlertEventSafe(
	orgId: string,
	eventKey: string,
	context: AlertEventContext,
): void {
	void emitAlertEvent(orgId, eventKey, context).catch((err) =>
		console.error(`[alerts] emit failed (${eventKey}):`, err),
	);
}

/**
 * Emits an `authz.<resource>.<action>.<allowed|denied>` event from a PDP decision — the
 * universal action seam (enforceDecision). Cheap when the org has no rules (cached).
 */
export function emitActionEvent(
	actor: Actor,
	action: Action,
	resource: { type: Resource; id?: string },
	allowed: boolean,
): void {
	const key = authzEventKey(resource.type, action, allowed);
	emitAlertEventSafe(actor.orgId, key, {
		title: allowed
			? `Allowed: ${labelForKey(key)}`
			: `Denied: ${labelForKey(key)}`,
		severity: allowed ? "info" : "warning",
		actor_id: actor.userId,
		action,
		resource_type: resource.type,
		resource_id: resource.id,
	});
}
