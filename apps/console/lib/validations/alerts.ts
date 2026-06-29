// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Input validators for the alerting server actions (drizzle-zod over the alerts
// schema, refined for the form shape). Secrets (webhook/Slack/RocketChat URL +
// optional signing secret) arrive as plaintext fields and are encrypted in the
// action; the JSONB `match`/`config` shapes are validated against their interfaces.

import { z } from "zod";
import { alertChannelType, alertSeverity } from "@/lib/db/schema/enums";

const channelTypeEnum = z.enum(alertChannelType.enumValues);
const severityEnum = z.enum(alertSeverity.enumValues);

// An event-key pattern: dot-separated segments, lowercase, with `*` wildcards
// (authz.project.destroy.denied, authz.*.*.denied, system.job.*).
const eventPatternSchema = z
	.string()
	.min(1)
	.regex(/^[a-z0-9_]+(\.[a-z0-9_*]+)*$/, "Invalid event pattern.");

/** Plaintext channel secret fields, encrypted into the `secret` column server-side. */
const channelSecretSchema = z
	.object({
		url: z.string().url().optional(),
		signingSecret: z.string().min(1).optional(),
		// PagerDuty Events API v2 integration routing key (no URL).
		routingKey: z.string().min(1).optional(),
	})
	.partial();

/**
 * Create/update an alert channel. `recipients` for email; `secret` for the rest.
 * Destination presence (a URL / a recipient) is NOT enforced here because an edit may
 * legitimately omit the secret to keep the existing one — createChannel enforces it.
 */
export const channelInputSchema = z.object({
	type: channelTypeEnum,
	name: z.string().min(1).max(120),
	enabled: z.boolean().default(true),
	recipients: z.array(z.string().email()).optional(),
	secret: channelSecretSchema.optional(),
});

export type ChannelInput = z.infer<typeof channelInputSchema>;

/** The field-equality match shape (mirrors AlertRuleMatch). */
export const ruleMatchSchema = z
	.object({
		job_types: z.array(z.string()).optional(),
		project_ids: z.array(z.string().uuid()).optional(),
		resource_types: z.array(z.string()).optional(),
		actions: z.array(z.string()).optional(),
		min_severity: severityEnum.optional(),
	})
	.default({});

/** Create/update an alert policy (a set of event patterns + shared routing). */
export const policyInputSchema = z.object({
	name: z.string().min(1).max(120),
	description: z.string().max(500).optional(),
	event_patterns: z.array(eventPatternSchema).min(1, "Pick at least one event."),
	match: ruleMatchSchema,
	severity: severityEnum.default("warning"),
	// Re-alert/dedupe window in seconds (0 = every event); capped at 7 days.
	throttle_seconds: z.number().int().min(0).max(604_800).default(0),
	// ee/ on-call routing (stored, inert until escalation ships).
	escalate: z.boolean().default(false),
	recipient: z.string().max(120).optional(),
	enabled: z.boolean().default(true),
	// Channel bindings with an optional per-channel severity floor (null/absent = all).
	channels: z
		.array(
			z.object({
				id: z.string().uuid(),
				min_severity: severityEnum.optional(),
			}),
		)
		.min(1, "Bind at least one channel."),
});

export type PolicyInput = z.infer<typeof policyInputSchema>;
