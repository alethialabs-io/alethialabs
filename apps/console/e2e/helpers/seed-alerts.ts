// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct-DB seeding for the Alerts domain e2e specs. The alerting tables (alert_channels,
// alert_rules, alert_rule_channels, alert_deliveries) are only touched by the alerts flow,
// so cleaning them for a persona org is safe under the parallel-agent rule (it never wipes
// projects/jobs/identities that sibling agents seed). Every row is scoped to the target
// org so the app's org-scoped reads see it. Inserts run as the owner DB role (RLS bypassed).

import { db } from "./db";
import type { Owner } from "./seed";

/**
 * Removes every alerting row for an org (deliveries → rules → channels; rule_channels
 * cascades from either side). Establishes a deterministic empty baseline for the org.
 */
export async function cleanAlerts(orgId: string): Promise<void> {
	const sql = db();
	await sql`delete from alert_deliveries where org_id = ${orgId}`;
	await sql`delete from alert_rules where org_id = ${orgId}`;
	await sql`delete from alert_channels where org_id = ${orgId}`;
}

/** Inserts a notification channel (defaults to a verified email channel). */
export async function seedChannel(
	owner: Owner,
	opts: {
		type?: string;
		name?: string;
		recipients?: string[];
		enabled?: boolean;
		verified?: boolean;
	} = {},
): Promise<{ id: string }> {
	const sql = db();
	const type = opts.type ?? "email";
	const isEmail = type === "email";
	const verified = opts.verified ?? true;
	const [row] = await sql<{ id: string }[]>`
		insert into alert_channels ${sql({
			org_id: owner.orgId,
			type,
			name: opts.name ?? `e2e-channel-${Date.now()}`,
			config: sql.json({
				recipients: isEmail ? (opts.recipients ?? ["ops@e2e.test"]) : [],
			}),
			// A non-null (dummy) envelope so the UI's `has_secret` reads true for URL/key
			// transports; seeded secret-bearing channels are never re-verified in tests.
			secret: isEmail ? null : sql.json({ v: 1, alg: "e2e", ct: "e2e" }),
			enabled: opts.enabled ?? true,
			is_verified: verified,
			last_verified_at: verified ? new Date() : null,
			created_by: owner.userId,
		})}
		returning id`;
	return row;
}

/** Inserts an alert policy (alert_rules) and optionally binds it to channels. */
export async function seedRule(
	owner: Owner,
	opts: {
		name?: string;
		description?: string;
		eventPatterns?: string[];
		enabled?: boolean;
		throttle?: number;
		channelIds?: string[];
	} = {},
): Promise<{ id: string }> {
	const sql = db();
	const [row] = await sql<{ id: string }[]>`
		insert into alert_rules ${sql({
			org_id: owner.orgId,
			name: opts.name ?? `e2e-policy-${Date.now()}`,
			description: opts.description ?? null,
			event_patterns: opts.eventPatterns ?? ["system.job.failed"],
			match: sql.json({}),
			severity: "warning",
			throttle_seconds: opts.throttle ?? 300,
			enabled: opts.enabled ?? true,
			created_by: owner.userId,
		})}
		returning id`;
	for (const cid of opts.channelIds ?? []) {
		await sql`
			insert into alert_rule_channels ${sql({
				rule_id: row.id,
				channel_id: cid,
				min_severity: null,
			})}`;
	}
	return row;
}

/** Inserts a delivery ledger row (defaults to a successful "sent" delivery). */
export async function seedDelivery(
	owner: Owner,
	opts: {
		status?: "pending" | "sent" | "failed" | "dead";
		eventKey?: string;
		title?: string;
		attempts?: number;
		lastError?: string;
		ruleId?: string;
		channelId?: string;
	} = {},
): Promise<{ id: string }> {
	const sql = db();
	const status = opts.status ?? "sent";
	const [row] = await sql<{ id: string }[]>`
		insert into alert_deliveries ${sql({
			org_id: owner.orgId,
			rule_id: opts.ruleId ?? null,
			channel_id: opts.channelId ?? null,
			event_key: opts.eventKey ?? "system.job.failed",
			context: sql.json({
				title: opts.title ?? "Deploy failed",
				severity: "critical",
			}),
			status,
			attempts: opts.attempts ?? 1,
			last_error: opts.lastError ?? null,
			sent_at: status === "sent" ? new Date() : null,
		})}
		returning id`;
	return row;
}
