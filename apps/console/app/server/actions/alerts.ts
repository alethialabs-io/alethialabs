"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the Alerts page (dataroom/spec/mvp/25-alerting-notifications.md). A "policy"
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
import { getProjects } from "@/app/server/actions/projects";
import { getPdp } from "@/lib/authz";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import { ACTIONS, RESOURCES } from "@/lib/authz/registry";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRuleChannels,
	alertRules,
} from "@/lib/db/schema";
import {
	type AlertChannelType,
	type AlertDeliveryStatus,
	type AlertSeverity,
	provisionJobType,
} from "@/lib/db/schema/enums";
import type { AlertRuleMatch } from "@/types/jsonb.types";
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
	/** Field-equality narrowing (min_severity + scope filters). */
	match: AlertRuleMatch;
	throttle_seconds: number;
	escalate: boolean;
	recipient: string | null;
	enabled: boolean;
	/** Bound channels with their per-channel severity floor (null = all severities). */
	channels: { id: string; minSeverity: AlertSeverity | null }[];
	/** Flat list of bound channel ids (derived from `channels`) for quick reads. */
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
	/** Whether the org's plan unlocks the alerting surface at all (team+). */
	alerting: boolean;
	/** Whether PDP-sourced (authz.*) security events are unlocked (enterprise). */
	advancedAlerting: boolean;
	/** Whether the caller holds `manage_alerts` — drives create/edit/delete UI. */
	canManage: boolean;
	encryptionConfigured: boolean;
	/** Option lists for the policy "conditions" (match) filters. */
	conditionOptions: ConditionOptions;
}

/** Selectable values for the policy condition (match) filters. */
export interface ConditionOptions {
	projects: { value: string; label: string }[];
	jobTypes: string[];
	resourceTypes: string[];
	actions: string[];
}

/** Non-throwing `manage_alerts` check — surfaces caller capability to the client UI. */
async function canManageAlerts(actor: Actor): Promise<boolean> {
	try {
		await getPdp().enforce(actor, "manage_alerts", { type: "alert" });
		return true;
	} catch (err) {
		if (err instanceof ForbiddenError) return false;
		throw err;
	}
}

/** Guards that the org's plan unlocks alerting at all (team+); throws otherwise. */
function assertAlertingEntitled(actor: Actor): void {
	if (!getEntitlements(actor).alerting) {
		throw new Error("Alerts require a Pro plan or higher.");
	}
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
	const canManage = await canManageAlerts(actor);
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

	const channelsByRule = new Map<
		string,
		{ id: string; minSeverity: AlertSeverity | null }[]
	>();
	for (const b of bindingRows) {
		const row = b.alert_rule_channels;
		const list = channelsByRule.get(row.rule_id) ?? [];
		list.push({ id: row.channel_id, minSeverity: row.min_severity });
		channelsByRule.set(row.rule_id, list);
	}

	const policies: PolicyDTO[] = ruleRows.map((r) => {
		const channels = channelsByRule.get(r.id) ?? [];
		return {
			id: r.id,
			name: r.name,
			description: r.description,
			event_patterns: r.event_patterns,
			is_security: r.event_patterns.some(isSecurityKey),
			severity: r.severity,
			match: r.match,
			throttle_seconds: r.throttle_seconds,
			escalate: r.escalate,
			recipient: r.recipient,
			enabled: r.enabled,
			channels,
			channelIds: channels.map((c) => c.id),
		};
	});

	// Option lists for the policy "conditions" editor (best-effort on projects).
	const projectList = await getProjects().catch(() => []);
	const conditionOptions: ConditionOptions = {
		projects: projectList.map((p) => ({ value: p.id, label: p.project_name })),
		jobTypes: [...provisionJobType.enumValues],
		resourceTypes: [...RESOURCES, "role", "grant"],
		actions: [...ACTIONS, "assign", "revoke"],
	};

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
		alerting: getEntitlements(actor).alerting,
		advancedAlerting: getEntitlements(actor).advancedAlerting,
		canManage,
		encryptionConfigured: isCredEncryptionConfigured(),
		conditionOptions,
	};
}

// ── Channels ────────────────────────────────────────────────────────────────────

/** Actionable error when a secret-bearing channel is configured without the key. */
const ENCRYPTION_KEY_ERROR =
	"Encryption is not configured, so webhook/Slack/RocketChat URLs can't be stored. " +
	"Set ALETHIA_CRED_ENCRYPTION_KEY (generate: openssl rand -base64 32) and restart. " +
	"Email channels work without it.";

/** Creates a channel; encrypts any secret fields (URL / signing secret). */
/**
 * Verifies the supplied endpoint, then creates the channel only if it works — a channel
 * never exists unverified. Returns the new id on success, or a friendly error (nothing is
 * persisted) so the add-channel form can surface it inline.
 */
export async function addChannel(
	input: ChannelInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	const data = channelInputSchema.parse(input);

	// Secret-bearing channels need the encryption key — fail with guidance, not an
	// opaque crypto throw from encryptSecret.
	if (data.type !== "email" && !isCredEncryptionConfigured()) {
		return { ok: false, error: ENCRYPTION_KEY_ERROR };
	}
	if (!channelDestinationPresent(data)) {
		return {
			ok: false,
			error:
				data.type === "pagerduty"
					? "PagerDuty needs an integration routing key."
					: "Email needs a recipient; the others need a destination URL.",
		};
	}

	const limit = checkRateLimit(`verify:${actor.orgId}:new`, 5, 60_000);
	if (!limit.ok) {
		return { ok: false, error: "Too many attempts — wait a minute and try again." };
	}

	const secret = encryptChannelSecret(data);
	const now = new Date();

	// Verify the endpoint BEFORE persisting against a transient (unsaved) channel.
	const preview: typeof alertChannels.$inferSelect = {
		id: "preview",
		org_id: actor.orgId,
		type: data.type,
		name: data.name,
		config: { recipients: data.recipients ?? [] },
		secret,
		enabled: true,
		is_verified: false,
		last_verified_at: null,
		created_by: actor.userId,
		created_at: now,
		updated_at: now,
	};
	try {
		await getChannelSender(data.type).verify(preview);
	} catch (err) {
		return { ok: false, error: friendlyVerifyError(err) };
	}

	const [row] = await getServiceDb()
		.insert(alertChannels)
		.values({
			org_id: actor.orgId,
			type: data.type,
			name: data.name,
			enabled: data.enabled,
			config: { recipients: data.recipients ?? [] },
			secret,
			is_verified: true,
			last_verified_at: now,
			created_by: actor.userId,
		})
		.returning({ id: alertChannels.id });
	revalidatePath(ALERTS_PATH);
	return { ok: true, id: row.id };
}

/** Updates a channel. A secret is only re-encrypted when new fields are supplied. */
export async function updateChannel(
	id: string,
	input: ChannelInput,
): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	const data = channelInputSchema.parse(input);
	// Only blocks when new secret fields are supplied (a blank URL keeps the old one).
	if (
		data.type !== "email" &&
		Boolean(
			data.secret?.url || data.secret?.signingSecret || data.secret?.routingKey,
		) &&
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
	assertAlertingEntitled(actor);
	await getServiceDb()
		.delete(alertChannels)
		.where(
			and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)),
		);
	revalidatePath(ALERTS_PATH);
}

/**
 * Toggles a channel's enabled flag only — unlike updateChannel this does NOT reset
 * verification (enabling/disabling shouldn't invalidate a proven endpoint).
 */
export async function setChannelEnabled(
	id: string,
	enabled: boolean,
): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	await getServiceDb()
		.update(alertChannels)
		.set({ enabled, updated_at: new Date() })
		.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)));
	revalidatePath(ALERTS_PATH);
}

/** Sends a synthetic test event through the channel and records the result. */
export async function verifyChannel(
	id: string,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);

	// Verification sends a real delivery (Slack/email/webhook) — throttle repeats so the
	// button can't be used to spam an endpoint. Best-effort, in-memory (per-instance).
	const limit = checkRateLimit(`verify:${actor.orgId}:${id}`, 3, 60_000);
	if (!limit.ok) {
		return {
			ok: false,
			error: "Too many verification attempts — wait a minute and try again.",
		};
	}

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
		return { ok: false, error: friendlyVerifyError(err) };
	}
}

/** Maps a raw sender/network error to a friendly, actionable verification message. */
function friendlyVerifyError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const low = raw.toLowerCase();
	if (
		low.includes("fetch failed") ||
		low.includes("network") ||
		low.includes("enotfound") ||
		low.includes("econnrefused") ||
		low.includes("eai_again") ||
		low.includes("certificate") ||
		low.includes("tls")
	)
		return "Couldn't reach the endpoint — check the URL is correct and publicly reachable.";
	if (low.includes("timed out") || low.includes("timeout") || low.includes("etimedout"))
		return "The endpoint timed out — it didn't respond in time.";
	if (/\b40[13]\b/.test(raw))
		return "The endpoint rejected the request (auth) — double-check the webhook URL or signing secret.";
	if (/\b404\b/.test(raw))
		return "Endpoint not found (404) — the URL looks wrong.";
	if (/\b5\d\d\b/.test(raw))
		return "The endpoint returned a server error — try again shortly.";
	if (low.includes("no recipients"))
		return "Add at least one recipient before verifying.";
	if (low.includes("no url") || low.includes("no webhook"))
		return "Configure the endpoint URL before verifying.";
	// Sender messages (e.g. "Slack responded 429 Too Many Requests") are already clear.
	return raw;
}

/** Builds the encrypted secret envelope from the supplied plaintext fields, or null. */
function encryptChannelSecret(data: ChannelInput) {
	const fields: Record<string, string> = {};
	if (data.secret?.url) fields.url = data.secret.url;
	if (data.secret?.signingSecret) fields.signingSecret = data.secret.signingSecret;
	if (data.secret?.routingKey) fields.routingKey = data.secret.routingKey;
	return Object.keys(fields).length > 0 ? encryptSecret(fields) : null;
}

/** Whether the input carries a usable destination for its transport. */
function channelDestinationPresent(data: ChannelInput): boolean {
	if (data.type === "email") return (data.recipients?.length ?? 0) > 0;
	if (data.type === "pagerduty") return Boolean(data.secret?.routingKey);
	return Boolean(data.secret?.url);
}

// ── Policies ────────────────────────────────────────────────────────────────────

/** Security patterns (authz.*) need advancedAlerting; ops/system patterns are free. */
function assertPatternsAllowed(
	patterns: string[],
	advancedAlerting: boolean,
): void {
	if (patterns.some(isSecurityKey) && !advancedAlerting) {
		throw new Error(
			"Security events (PDP activity) require an Enterprise plan.",
		);
	}
}

/** Creates a policy and binds its channels. */
export async function createPolicy(input: PolicyInput): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	const data = policyInputSchema.parse(input);
	assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

	const db = getServiceDb();
	await assertChannelsOwned(
		actor.orgId,
		data.channels.map((c) => c.id),
	);

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
		data.channels.map((c) => ({
			rule_id: rule.id,
			channel_id: c.id,
			min_severity: c.min_severity ?? null,
		})),
	);
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Updates a policy and replaces its channel bindings. */
export async function updatePolicy(id: string, input: PolicyInput): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	const data = policyInputSchema.parse(input);
	assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

	const db = getServiceDb();
	await assertChannelsOwned(
		actor.orgId,
		data.channels.map((c) => c.id),
	);

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
		data.channels.map((c) => ({
			rule_id: id,
			channel_id: c.id,
			min_severity: c.min_severity ?? null,
		})),
	);
	invalidateOrgRules(actor.orgId);
	revalidatePath(ALERTS_PATH);
}

/** Enables/disables a policy without opening the editor. */
export async function togglePolicy(id: string, enabled: boolean): Promise<void> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
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
	assertAlertingEntitled(actor);
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
