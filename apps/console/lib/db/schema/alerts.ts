// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerting (dataroom/spec/mvp/25-alerting-notifications.md). An alert_rule binds an event-key
// pattern (e.g. `authz.project.destroy.denied`, `authz.*.denied`, `system.job.failed`) —
// optionally narrowed by `match` — to one or more alert_channels; when a source emits
// an event, each matching rule produces one alert_delivery per bound channel. Event
// keys are TEXT (not a DB enum): the catalog is code-derived from the PDP registry
// (lib/alerts/catalog.ts) so adding an action/event never needs a migration. Deliveries
// are a durable ledger (retry + audit + the Activity view), not fire-and-forget.
// Org-scoped; the PDP (`alert` resource) authorizes mutations in the server actions.

import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AlertChannelConfig,
	AlertEventContext,
	AlertRuleMatch,
	EncryptedSecret,
} from "@/types/database-custom.types";
import { alertChannelType, alertDeliveryStatus, alertSeverity } from "./enums";

// A delivery destination. The sensitive material (webhook/Slack/RocketChat URL +
// optional signing secret) is AEAD-encrypted into `secret` (lib/crypto/secrets.ts);
// non-secret settings (email recipients) live in `config`.
export const alertChannels = pgTable(
	"alert_channels",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Coarse tenancy scope; community org_id = user_id via trigger.
		org_id: uuid().notNull(),
		type: alertChannelType().notNull(),
		name: text().notNull(),
		config: jsonb().$type<AlertChannelConfig>().default({}).notNull(),
		secret: jsonb().$type<EncryptedSecret>(),
		enabled: boolean().default(true).notNull(),
		is_verified: boolean().default(false).notNull(),
		last_verified_at: timestamp({ withTimezone: true }),
		created_by: uuid().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_alert_channels_org").on(t.org_id)],
);

// A "policy" (UI name) binds a SET of event-key patterns to channels + shared routing.
// Each entry of `event_patterns` is an exact key or a `*`-segment glob (`authz.*.denied`);
// `match` (field-equality) further narrows; `throttle_seconds` collapses repeats (0 =
// every event). Security patterns (`authz.*`) are gated by advancedAlerting at emit time.
// `escalate`/`recipient` are stored but inert until the ee/ escalation engine ships.
export const alertRules = pgTable(
	"alert_rules",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		name: text().notNull(),
		description: text(),
		event_patterns: text().array().default([]).notNull(),
		match: jsonb().$type<AlertRuleMatch>().default({}).notNull(),
		severity: alertSeverity().default("warning").notNull(),
		// Re-alert/dedupe window in seconds; 0 = fire on every matching event.
		throttle_seconds: integer().default(0).notNull(),
		// ee/ on-call routing (stored, inert until the escalation engine ships).
		escalate: boolean().default(false).notNull(),
		recipient: text(),
		enabled: boolean().default(true).notNull(),
		created_by: uuid().notNull(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("idx_alert_rules_org").on(t.org_id)],
);

// rule ⇆ channels (M2M). Deleting either side drops the binding.
export const alertRuleChannels = pgTable(
	"alert_rule_channels",
	{
		rule_id: uuid()
			.notNull()
			.references(() => alertRules.id, { onDelete: "cascade" }),
		channel_id: uuid()
			.notNull()
			.references(() => alertChannels.id, { onDelete: "cascade" }),
		// Per-channel severity floor: a binding only delivers events at/above this level
		// (null = all severities). Refines routing on top of the rule-level match.
		min_severity: alertSeverity(),
	},
	(t) => [
		primaryKey({ columns: [t.rule_id, t.channel_id] }),
		index("idx_alert_rule_channels_channel").on(t.channel_id),
	],
);

// The durable delivery ledger. `context` is the rendered payload captured at emit
// time (replayable). The sweeper claims rows by (status, next_attempt_at); the
// Activity view reads by (org_id, created_at). rule_id/channel_id are SET NULL on
// delete so history outlives the rule/channel that produced it.
export const alertDeliveries = pgTable(
	"alert_deliveries",
	{
		id: uuid().primaryKey().defaultRandom(),
		org_id: uuid().notNull(),
		rule_id: uuid().references(() => alertRules.id, { onDelete: "set null" }),
		channel_id: uuid().references(() => alertChannels.id, {
			onDelete: "set null",
		}),
		event_key: text().notNull(),
		// Identity for throttle/dedupe (rule_id + channel + event subject); a non-dead
		// delivery with the same key inside the rule's window suppresses a repeat.
		dedupe_key: text(),
		context: jsonb().$type<AlertEventContext>().notNull(),
		status: alertDeliveryStatus().default("pending").notNull(),
		attempts: integer().default(0).notNull(),
		max_attempts: integer().default(5).notNull(),
		last_error: text(),
		next_attempt_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		sent_at: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("idx_alert_deliveries_sweep").on(t.status, t.next_attempt_at),
		index("idx_alert_deliveries_org_created").on(t.org_id, t.created_at),
		index("idx_alert_deliveries_dedupe").on(t.dedupe_key, t.created_at),
	],
);

export type AlertChannel = typeof alertChannels.$inferSelect;
export type NewAlertChannel = typeof alertChannels.$inferInsert;
export type AlertRule = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;
export type AlertRuleChannel = typeof alertRuleChannels.$inferSelect;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
