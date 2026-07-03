// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure rule-evaluation helpers (dataroom/spec/mvp/25-alerting-notifications.md): severity
// ordering and the field-equality `match` evaluation. Event-key identity, the catalog,
// glob matching, and labels live in lib/alerts/catalog.ts. No I/O — unit-testable.

import type {
	AlertEventContext,
	AlertRuleMatch,
} from "@/types/jsonb.types";
import type { AlertSeverity } from "@/lib/db/schema/enums";

const SEVERITY_RANK: Record<AlertSeverity, number> = {
	info: 0,
	warning: 1,
	critical: 2,
};

/** True if `actual` is at least as severe as `floor`. */
export function meetsSeverity(
	actual: AlertSeverity,
	floor: AlertSeverity,
): boolean {
	return SEVERITY_RANK[actual] >= SEVERITY_RANK[floor];
}

/** Whether a context value is allowed by an optional set of permitted values. */
function passesSet(allowed: string[] | undefined, value?: string): boolean {
	if (!allowed || allowed.length === 0) return true; // no constraint
	return value !== undefined && allowed.includes(value);
}

/**
 * Evaluates a rule's field-equality `match` against an event context. Empty match
 * passes everything; each present filter is an AND constraint. `severity` is the
 * effective severity (context override, else the rule's severity).
 */
export function matchesRule(
	match: AlertRuleMatch,
	context: AlertEventContext,
	severity: AlertSeverity,
): boolean {
	if (match.min_severity && !meetsSeverity(severity, match.min_severity)) {
		return false;
	}
	return (
		passesSet(match.job_types, context.job_type) &&
		passesSet(match.project_ids, context.project_id) &&
		passesSet(match.resource_types, context.resource_type) &&
		passesSet(match.actions, context.action)
	);
}
