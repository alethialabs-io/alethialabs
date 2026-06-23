"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the Alerts page (spec/mvp/25-alerting-notifications.md). A "policy"
// (table `alert_rules`) binds a SET of event-key patterns to channels + shared routing.
// Every mutation is PDP-guarded on the `alert` resource; reads use `view_alerts`. Channel
// secrets are AES-encrypted at rest and never returned. `authz.*` patterns are gated on
// the advancedAlerting entitlement. Policy mutations invalidate the emit cache.

import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getChannelSender } from "@/lib/alerts/channels";
import {
	ALL_EVENTS,
	type CatalogCategory,
	CATEGORIES,
	isSecurityKey,
} from "@/lib/alerts/catalog";
import { eventMatches } from "@/lib/alerts/catalog";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRuleChannels,
	alertRules,
} from "@/lib/db/schema";
import type {
	AlertChannelType,
	AlertDeliveryStatus,
	AlertSeverity,
} from "@/lib/db/schema/enums";
import {
	type ChannelInput,
	channelInputSchema,
	type PolicyInput,
	policyInputSchema,
} from "@/lib/validations/alerts";

const ALERTS_PATH = "/dashboard/alerts";

// ── DTOs (client-safe; never carry the encrypted secret envelope) ───────────────

export interface ChannelDTO {
	id: string;
	type: AlertChannelType;
	name: string;
	enabled: boolean;
	is_verified: boolean;
	recipients: string[];
	has_secret: boolean;
	last_verified_at: string | null;
}

export interface PolicyDTO {
	id: string;
	name: string;
	description: string | null;
	event_patterns: string[];
	is_security: boolean;
	severity: AlertSeverity;
	throttle_seconds: number;
	escalate: boolean;
	recipient: string | null;
	enabled: boolean;
	channelIds: string[];
}

export interface DeliveryDTO {
	id: string;
	event_key: string;
	status: AlertDeliveryStatus;
	title: string;
	attempts: number;
	last_error: string | null;
	created_at: string;
	sent_at: string | null;
}

export interface AlertsStats {
	policies: number;
	enabled: number;
	eventsCovered: number;
	totalEvents: number;
	routed24h: number;
}

export interface AlertsBootstrap {
	channels: ChannelDTO[];
	policies: PolicyDTO[];
	deliveries: DeliveryDTO[];
	/** The curated event catalog (categories → events) for the policy editor. */
	categories: CatalogCategory[];
	stats: AlertsStats;
	advancedAlerting: boolean;
	encryptionConfigured: boolean;
}

/** Maps a channel row to its client-safe DTO. */
function toChannelDTO(row: typeof alertChannels.$inferSelect): ChannelDTO {
	return {
		id: row.id,
		type: row.type,
		name: row.name,
		enabled: row.enabled,
		is_verified: row.is_verified,
		recipients: row.config.recipients ?? [],
		has_secret: Boolean(row.secret),
		last_verified_at: row.last_verified_at?.toISOString() ?? null,
	};
}

/** Everything the Alerts page needs in one round-trip. */
export async function getAlertsBootstrap(): Promise<AlertsBootstrap> {
	const actor = await authorize("view_alerts", { type: "alert" });
	const db = getServiceDb();
	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

	const [channelRows, ruleRows, bindingRows, deliveryRows, routed] =
		await Promise.all([
			db
				.select()
				.from(alertChannels)
				.where(eq(alertChannels.org_id, actor.orgId))
				.orderBy(desc(alertChannels.created_at)),
			db
				.select()
				.from(alertRules)
				.where(eq(alertRules.org_id, actor.orgId))
				.orderBy(desc(alertRules.created_at)),
			db
				.select()
				.from(alertRuleChannels)
				.innerJoin(alertRules, eq(alertRules.id, alertRuleChannels.rule_id))
				.where(eq(alertRules.org_id, actor.orgId)),
			db
				.select()
				.from(alertDeliveries)
				.where(eq(alertDeliveries.org_id, actor.orgId))
				.orderBy(desc(alertDeliveries.created_at))
				.limit(50),
			db
				.select({ c: count() })
				.from(alertDeliveries)
				.where(
					and(
						eq(alertDeliveries.org_id, actor.orgId),
						gt(alertDeliveries.created_at, since24h),
					),
				),
		]);

	const channelIdsByRule = new Map<string, string[]>();
	for (const b of bindingRows) {
		const list = channelIdsByRule.get(b.alert_rule_channels.rule_id) ?? [];
		list.push(b.alert_rule_channels.channel_id);
		channelIdsByRule.set(b.alert_rule_channels.rule_id, list);
	}

	const policies: PolicyDTO[] = ruleRows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		event_patterns: r.event_patterns,
		is_security: r.event_patterns.some(isSecurityKey),
		severity: r.severity,
		throttle_seconds: r.throttle_seconds,
		escalate: r.escalate,
		recipient: r.recipient,
		enabled: r.enabled,
		channelIds: channelIdsByRule.get(r.id) ?? [],
	}));

	// "Events covered" = catalog events matched by ≥1 enabled policy's patterns.
	const enabledPatterns = policies
		.filter((p) => p.enabled)
		.flatMap((p) => p.event_patterns);
	const eventsCovered = ALL_EVENTS.filter((e) =>
		enabledPatterns.some((pat) => eventMatches(pat, e.key)),
	).length;

	return {
		channels: channelRows.map(toChannelDTO),
		policies,
		deliveries: deliveryRows.map((d) => ({
			id: d.id,
			event_key: d.event_key,
			status: d.status,
			title: d.context.title,
			attempts: d.attempts,
			last_error: d.last_error,
			created_at: d.created_at.toISOString(),
			sent_at: d.sent_at?.toISOString() ?? null,
		})),
		categories: CATEGORIES,
		stats: {
			policies: policies.length,
			enabled: policies.filter((p) => p.enabled).length,
			eventsCovered,
			totalEvents: ALL_EVENTS.length,
			routed24h: routed[0]?.c ?? 0,
		},
		advancedAlerting: getEntitlements(actor).advancedAlerting,
		encryptionConfigured: isCredEncryptionConfigured(),
	};
}

// ── Channels ────────────────────────────────────────────────────────────────────

/** Actionable error when a secret-bearing channel is configured without the key. */
const ENCRYPTION_KEY_ERROR =
	"Encryption is not configured, so webhook/Slack/RocketChat URLs can't be stored. " +
	"Set ALETHIA_CRED_ENCRYPTION_KEY (generate: openssl rand -base64 32) and restart. " +
	"Email channels work without it.";

/** Creates a channel; encrypts any secret fields (URL / signing secret). */
export async function createChannel(input: ChannelInput): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	const data = channelInputSchema.parse(input);

	// Secret-bearing channels need the encryption key — fail with guidance, not an
	// opaque crypto throw from encryptSecret.
	if (data.type !== "email" && !isCredEncryptionConfigured()) {
		throw new Error(ENCRYPTION_KEY_ERROR);
	}

	// Destination is required at creation (an edit may omit it to keep the old secret).
	const hasDestination =
		data.type === "email"
			? (data.recipients?.length ?? 0) > 0
			: Boolean(data.secret?.url);
	if (!hasDestination) {
		throw new Error(
			"Email channels need a recipient; webhook/Slack/RocketChat need a URL.",
		);
	}

	await getServiceDb()
		.insert(alertChannels)
		.values({
			org_id: actor.orgId,
			type: data.type,
			name: data.name,
			enabled: data.enabled,
			config: { recipients: data.recipients ?? [] },
			secret: encryptChannelSecret(data),
			created_by: actor.userId,
		});
	revalidatePath(ALERTS_PATH);
}

/** Updates a channel. A secret is only re-encrypted when new fields are supplied. */
export async function updateChannel(
	id: string,
	input: ChannelInput,
): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	const data = channelInputSchema.parse(input);
	// Only blocks when new secret fields are supplied (a blank URL keeps the old one).
	if (
		data.type !== "email" &&
		Boolean(data.secret?.url || data.secret?.signingSecret) &&
		!isCredEncryptionConfigured()
	) {
		throw new Error(ENCRYPTION_KEY_ERROR);
	}
	const secret = encryptChannelSecret(data);

	await getServiceDb()
		.update(alertChannels)
		.set({
			type: data.type,
			name: data.name,
			enabled: data.enabled,
			config: { recipients: data.recipients ?? [] },
			is_verified: false,
			...(secret ? { secret } : {}),
			updated_at: new Date(),
		})
		.where(
			and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)),
		);
	revalidatePath(ALERTS_PATH);
}

/** Deletes a channel (its policy bindings cascade; deliveries keep history via SET NULL). */
export async function deleteChannel(id: string): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	await getServiceDb()
		.delete(alertChannels)
		.where(
			and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)),
		);
	revalidatePath(ALERTS_PATH);
}

/** Sends a synthetic test event through the channel and records the result. */
export async function verifyChannel(
	id: string,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	const db = getServiceDb();
	const [channel] = await db
		.select()
		.from(alertChannels)
		.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)))
		.limit(1);
	if (!channel) return { ok: false, error: "Channel not found." };

	try {
		await getChannelSender(channel.type).verify(channel);
		await db
			.update(alertChannels)
			.set({ is_verified: true, last_verified_at: new Date() })
			.where(eq(alertChannels.id, id));
		revalidatePath(ALERTS_PATH);
		return { ok: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Test delivery failed.";
		return { ok: false, error: message };
	}
}

/** Builds the encrypted secret envelope from the supplied plaintext fields, or null. */
function encryptChannelSecret(data: ChannelInput) {
	const fields: Record<string, string> = {};
	if (data.secret?.url) fields.url = data.secret.url;
	if (data.secret?.signingSecret) fields.signingSecret = data.secret.signingSecret;
	return Object.keys(fields).length > 0 ? encryptSecret(fields) : null;
}

// ── Policies ────────────────────────────────────────────────────────────────────

/** Security patterns (authz.*) need advancedAlerting; ops/system patterns are free. */
function assertPatternsAllowed(
	patterns: string[],
	advancedAlerting: boolean,
): void {
	if (patterns.some(isSecurityKey) && !advancedAlerting) {
		throw new Error(
			"Security events (PDP audit) require a Business plan or higher.",
		);
	}
}

/** Creates a policy and binds its channels. */
export async function createPolicy(input: PolicyInput): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	const data = policyInputSchema.parse(input);
	assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

	const db = getServiceDb();
	await assertChannelsOwned(actor.orgId, data.channelIds);

	const [rule] = await db
		.insert(alertRules)
		.values({
			org_id: actor.orgId,
			name: data.name,
			description: data.description ?? null,
			event_patterns: data.event_patterns,
			match: data.match,
			severity: data.severity,
			throttle_seconds: data.throttle_seconds,
			escalate: data.escalate,
			recipient: data.recipient ?? null,
			enabled: data.enabled,
			created_by: actor.userId,
		})
		.returning({ id: alertRules.id });

	await db.insert(alertRuleChannels).values(
		data.channelIds.map((channel_id) => ({ rule_id: rule.id, channel_id })),
	);
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Updates a policy and replaces its channel bindings. */
export async function updatePolicy(id: string, input: PolicyInput): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	const data = policyInputSchema.parse(input);
	assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

	const db = getServiceDb();
	await assertChannelsOwned(actor.orgId, data.channelIds);

	await db
		.update(alertRules)
		.set({
			name: data.name,
			description: data.description ?? null,
			event_patterns: data.event_patterns,
			match: data.match,
			severity: data.severity,
			throttle_seconds: data.throttle_seconds,
			escalate: data.escalate,
			recipient: data.recipient ?? null,
			enabled: data.enabled,
			updated_at: new Date(),
		})
		.where(and(eq(alertRules.id, id), eq(alertRules.org_id, actor.orgId)));

	await db.delete(alertRuleChannels).where(eq(alertRuleChannels.rule_id, id));
	await db.insert(alertRuleChannels).values(
		data.channelIds.map((channel_id) => ({ rule_id: id, channel_id })),
	);
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Enables/disables a policy without opening the editor. */
export async function togglePolicy(id: string, enabled: boolean): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	await getServiceDb()
		.update(alertRules)
		.set({ enabled, updated_at: new Date() })
		.where(and(eq(alertRules.id, id), eq(alertRules.org_id, actor.orgId)));
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Deletes a policy (its bindings cascade). */
export async function deletePolicy(id: string): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	await getServiceDb()
		.delete(alertRules)
		.where(and(eq(alertRules.id, id), eq(alertRules.org_id, actor.orgId)));
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Guards that every bound channel belongs to the actor's org (no cross-org binding). */
async function assertChannelsOwned(
	orgId: string,
	channelIds: string[],
): Promise<void> {
	const owned = await getServiceDb()
		.select({ id: alertChannels.id })
		.from(alertChannels)
		.where(
			and(
				eq(alertChannels.org_id, orgId),
				inArray(alertChannels.id, channelIds),
			),
		);
	if (owned.length !== channelIds.length) {
		throw new Error("One or more channels are invalid.");
	}
}
