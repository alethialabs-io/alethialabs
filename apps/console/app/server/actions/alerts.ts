"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the Alerts page (dataroom/spec/mvp/25-alerting-notifications.md). A "policy"
// (table `alert_rules`) binds a SET of event-key patterns to channels + shared routing.
// Every mutation is PDP-guarded on the `alert` resource and gated on the `alerting` entitlement.
// Channel secrets are AES-encrypted at rest and never returned. `authz.*` patterns are gated on
// the advancedAlerting entitlement. Policy mutations invalidate the emit cache.
//
// WRITES ONLY (ADR 0005 D1/D4, #6125). The hub's reads moved to `lib/rpc/procedures/alerts.ts` and
// are served over GET; every export here is a `defineAction` returning `ActionResult<T>`, called from
// the client through `useActionMutation`, which invalidates the keys that show the change. Other tabs
// and other members hear it on the `alerts` topic (the alert tables' triggers, programmables.sql).
//
// THE ORG BINDING. Every write that names a row by id matches it under `org_id = actor.orgId` as
// well — the PDP's `manage_alerts` is a decision about the org, not about the row — and a write that
// matched nothing is NOT_FOUND, the same answer for a row that never existed and one of another org.

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { getChannelSender } from "@/lib/alerts/channels";
import { isSecurityKey } from "@/lib/alerts/catalog";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { SsrfError, UNREACHABLE_DESTINATION } from "@/lib/net/ssrf-guard";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertRuleChannels, alertRules } from "@/lib/db/schema";
import type {
	AlertChannelType,
	AlertDeliveryStatus,
	AlertSeverity,
} from "@/lib/db/schema/enums";
import type { AlertRuleMatch } from "@/types/jsonb.types";
import {
	type ChannelInput,
	channelInputSchema,
	policyInputSchema,
} from "@/lib/validations/alerts";

// ── DTOs (client-safe; never carry the encrypted secret envelope) ───────────────
// Declared here because the list builders (lib/queries/alerts-lists.ts) and the components both
// import them; the imports are type-only, so they are erased.

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

/**
 * What adding a channel came to. A destination that did not verify is an ANSWER the sheet renders
 * inline beside the field the user is editing, not a failure — nothing was persisted, and the user's
 * next move is to fix the URL, so a toast that disappears would be the wrong place for it.
 */
export type AddChannelOutcome = { added: true; id: string } | { added: false; error: string };

/** What a verification attempt came to — rendered inline by the verify control. */
export type VerifyChannelOutcome = { verified: true } | { verified: false; error: string };

/** The one argument the per-row actions take. */
const idInput = z.object({ id: z.string().uuid() });

/** Guards that the org's plan unlocks alerting at all (team+); refuses otherwise. */
function assertAlertingEntitled(actor: Actor): void {
	if (!getEntitlements(actor).alerting) {
		throw new ActionRefusal("entitlement", "Alerts require a Pro plan or higher.", "alerting");
	}
}

/** `manage_alerts` (recording) + the plan gate: the preamble of every write here. */
async function managingActor(): Promise<Actor> {
	const actor = await authorize("manage_alerts", { type: "alert" });
	assertAlertingEntitled(actor);
	return actor;
}

// ── Channels ────────────────────────────────────────────────────────────────────

/** Actionable error when a secret-bearing channel is configured without the key. */
const ENCRYPTION_KEY_ERROR =
	"Encryption is not configured, so webhook/Slack/RocketChat URLs can't be stored. " +
	"Set ALETHIA_CRED_ENCRYPTION_KEY (generate: openssl rand -base64 32) and restart. " +
	"Email channels work without it.";

/** What every id-addressed channel write says when the id does not resolve in the org. */
const CHANNEL_NOT_FOUND = "Channel not found.";

/**
 * Verifies the supplied endpoint, then creates the channel only if it works — a channel never
 * exists unverified. A destination that does not verify comes back as `{ added: false, error }`
 * (nothing is persisted) so the add-channel sheet can surface it inline.
 */
export async function addChannel(raw: z.input<typeof channelInputSchema>): Promise<ActionResult<AddChannelOutcome>> {
	return defineAction({ input: channelInputSchema, run: ({ input }) => createChannel(input) })(raw);
}

/** The body of {@link addChannel}, on already-validated input. */
async function createChannel(data: ChannelInput): Promise<AddChannelOutcome> {
	const actor = await managingActor();

	// Secret-bearing channels need the encryption key — fail with guidance, not an
	// opaque crypto throw from encryptSecret.
	if (data.type !== "email" && !isCredEncryptionConfigured()) {
		return { added: false, error: ENCRYPTION_KEY_ERROR };
	}
	if (!channelDestinationPresent(data)) {
		return {
			added: false,
			error:
				data.type === "pagerduty"
					? "PagerDuty needs an integration routing key."
					: "Email needs a recipient; the others need a destination URL.",
		};
	}

	// failOpen: this limit is a courtesy — it damps repeat test deliveries to an endpoint the org itself
	// configured, behind manage_alerts. During a database outage it admits the hit, so the person is told
	// the save failed (the insert below needs the database) rather than "too many attempts".
	const limit = await checkRateLimit(`verify:${actor.orgId}:new`, 5, 60_000, { failOpen: true });
	if (!limit.ok) {
		return { added: false, error: "Too many attempts — wait a minute and try again." };
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
		return { added: false, error: friendlyVerifyError(err) };
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
	return { added: true, id: row.id };
}

const updateChannelInput = channelInputSchema.extend({ id: z.string().uuid() });

/** Updates a channel. A secret is only re-encrypted when new fields are supplied. */
export async function updateChannel(
	raw: z.input<typeof updateChannelInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({ input: updateChannelInput, run: ({ input }) => rewriteChannel(input) })(raw);
}

/** The body of {@link updateChannel}. */
async function rewriteChannel({ id, ...data }: z.output<typeof updateChannelInput>): Promise<{ id: string }> {
	const actor = await managingActor();
	// Only blocks when new secret fields are supplied (a blank URL keeps the old one).
	if (
		data.type !== "email" &&
		Boolean(data.secret?.url || data.secret?.signingSecret || data.secret?.routingKey) &&
		!isCredEncryptionConfigured()
	) {
		throw new ActionRefusal("conflict", ENCRYPTION_KEY_ERROR);
	}
	const secret = encryptChannelSecret(data);

	const [row] = await getServiceDb()
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
		.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)))
		.returning({ id: alertChannels.id });
	if (!row) throw new ActionRefusal("not-found", CHANNEL_NOT_FOUND);
	return row;
}

/** Deletes a channel (its policy bindings cascade; deliveries keep history via SET NULL). */
export async function deleteChannel(raw: z.input<typeof idInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: idInput,
		run: async ({ input }) => {
			const actor = await managingActor();
			const [row] = await getServiceDb()
				.delete(alertChannels)
				.where(and(eq(alertChannels.id, input.id), eq(alertChannels.org_id, actor.orgId)))
				.returning({ id: alertChannels.id });
			if (!row) throw new ActionRefusal("not-found", CHANNEL_NOT_FOUND);
			// A deleted channel can leave a policy with no destination; the emit cache holds rules.
			invalidateOrgRules(actor.orgId);
			return row;
		},
	})(raw);
}

const channelEnabledInput = z.object({ id: z.string().uuid(), enabled: z.boolean() });

/**
 * Toggles a channel's enabled flag only — unlike updateChannel this does NOT reset
 * verification (enabling/disabling shouldn't invalidate a proven endpoint).
 */
export async function setChannelEnabled(
	raw: z.input<typeof channelEnabledInput>,
): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: channelEnabledInput,
		run: async ({ input }) => {
			const actor = await managingActor();
			const [row] = await getServiceDb()
				.update(alertChannels)
				.set({ enabled: input.enabled, updated_at: new Date() })
				.where(and(eq(alertChannels.id, input.id), eq(alertChannels.org_id, actor.orgId)))
				.returning({ id: alertChannels.id });
			if (!row) throw new ActionRefusal("not-found", CHANNEL_NOT_FOUND);
			return row;
		},
	})(raw);
}

/** Sends a synthetic test event through the channel and records the result. */
export async function verifyChannel(raw: z.input<typeof idInput>): Promise<ActionResult<VerifyChannelOutcome>> {
	return defineAction({ input: idInput, run: ({ input }) => verifyOwnedChannel(input.id) })(raw);
}

/** The body of {@link verifyChannel}. */
async function verifyOwnedChannel(id: string): Promise<VerifyChannelOutcome> {
	const actor = await managingActor();

	// Verification sends a real delivery (Slack/email/webhook) — throttle repeats so the
	// button can't be used to spam an endpoint. Shared across replicas (lib/rate-limit.ts). failOpen for
	// addChannel's reason: a courtesy limit, and the channel read below needs the database anyway, so an
	// outage surfaces as that failure rather than as "too many attempts".
	const limit = await checkRateLimit(`verify:${actor.orgId}:${id}`, 3, 60_000, { failOpen: true });
	if (!limit.ok) {
		return { verified: false, error: "Too many verification attempts — wait a minute and try again." };
	}

	const db = getServiceDb();
	const [channel] = await db
		.select()
		.from(alertChannels)
		.where(and(eq(alertChannels.id, id), eq(alertChannels.org_id, actor.orgId)))
		.limit(1);
	if (!channel) throw new ActionRefusal("not-found", CHANNEL_NOT_FOUND);

	try {
		await getChannelSender(channel.type).verify(channel);
	} catch (err) {
		return { verified: false, error: friendlyVerifyError(err) };
	}
	await db
		.update(alertChannels)
		.set({ is_verified: true, last_verified_at: new Date() })
		.where(and(eq(alertChannels.id, channel.id), eq(alertChannels.org_id, actor.orgId)));
	return { verified: true };
}

/**
 * Maps a raw sender/network error to a friendly, actionable verification message.
 *
 * A refusal by the outbound-URL guard always reads as {@link UNREACHABLE_DESTINATION}: its own
 * message describes how the destination resolved, which is the server's business, so it is logged
 * here and never returned.
 */
function friendlyVerifyError(err: unknown): string {
	if (err instanceof SsrfError) {
		console.warn("[alerts] channel destination refused by the outbound guard:", err.message);
		return UNREACHABLE_DESTINATION;
	}
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

/** What every id-addressed policy write says when the id does not resolve in the org. */
const POLICY_NOT_FOUND = "Alert policy not found.";

/** Security patterns (authz.*) need advancedAlerting; ops/system patterns are free. */
function assertPatternsAllowed(patterns: string[], advancedAlerting: boolean): void {
	if (patterns.some(isSecurityKey) && !advancedAlerting) {
		throw new ActionRefusal(
			"entitlement",
			"Security events (PDP activity) require an Enterprise plan.",
			"advancedAlerting",
		);
	}
}

/** Creates a policy and binds its channels. */
export async function createPolicy(raw: z.input<typeof policyInputSchema>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: policyInputSchema,
		run: async ({ input: data }) => {
			const actor = await managingActor();
			assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

			const db = getServiceDb();
			await assertChannelsOwned(
				actor.orgId,
				data.channels.map((c) => c.id),
			);

			const rule = await db.transaction(async (tx) => {
				const [created] = await tx
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

				await tx.insert(alertRuleChannels).values(
					data.channels.map((c) => ({
						rule_id: created.id,
						channel_id: c.id,
						min_severity: c.min_severity ?? null,
					})),
				);
				return created;
			});
			invalidateOrgRules(actor.orgId);
			return rule;
		},
	})(raw);
}

const updatePolicyInput = policyInputSchema.extend({ id: z.string().uuid() });

/** Updates a policy and replaces its channel bindings. */
export async function updatePolicy(raw: z.input<typeof updatePolicyInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: updatePolicyInput,
		run: async ({ input: { id, ...data } }) => {
			const actor = await managingActor();
			assertPatternsAllowed(data.event_patterns, getEntitlements(actor).advancedAlerting);

			const db = getServiceDb();
			await assertChannelsOwned(
				actor.orgId,
				data.channels.map((c) => c.id),
			);

			// One transaction, and the channel rewrite keys on the rule the ORG-BOUND update matched — never
			// on the caller's `id`. A policy of another organization matches no row here, so it is refused
			// as not found before any binding is touched.
			const updated = await db.transaction(async (tx) => {
				const [rule] = await tx
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
					.where(and(eq(alertRules.id, id), eq(alertRules.org_id, actor.orgId)))
					.returning({ id: alertRules.id });
				if (!rule) throw new ActionRefusal("not-found", POLICY_NOT_FOUND);

				await tx.delete(alertRuleChannels).where(eq(alertRuleChannels.rule_id, rule.id));
				await tx.insert(alertRuleChannels).values(
					data.channels.map((c) => ({
						rule_id: rule.id,
						channel_id: c.id,
						min_severity: c.min_severity ?? null,
					})),
				);
				return rule;
			});
			invalidateOrgRules(actor.orgId);
			return updated;
		},
	})(raw);
}

const policyEnabledInput = z.object({ id: z.string().uuid(), enabled: z.boolean() });

/** Enables/disables a policy without opening the editor. */
export async function togglePolicy(raw: z.input<typeof policyEnabledInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: policyEnabledInput,
		run: async ({ input }) => {
			const actor = await managingActor();
			const [row] = await getServiceDb()
				.update(alertRules)
				.set({ enabled: input.enabled, updated_at: new Date() })
				.where(and(eq(alertRules.id, input.id), eq(alertRules.org_id, actor.orgId)))
				.returning({ id: alertRules.id });
			if (!row) throw new ActionRefusal("not-found", POLICY_NOT_FOUND);
			invalidateOrgRules(actor.orgId);
			return row;
		},
	})(raw);
}

/** Deletes a policy (its bindings cascade). */
export async function deletePolicy(raw: z.input<typeof idInput>): Promise<ActionResult<{ id: string }>> {
	return defineAction({
		input: idInput,
		run: async ({ input }) => {
			const actor = await managingActor();
			const [row] = await getServiceDb()
				.delete(alertRules)
				.where(and(eq(alertRules.id, input.id), eq(alertRules.org_id, actor.orgId)))
				.returning({ id: alertRules.id });
			if (!row) throw new ActionRefusal("not-found", POLICY_NOT_FOUND);
			invalidateOrgRules(actor.orgId);
			return row;
		},
	})(raw);
}

/** Guards that every bound channel belongs to the actor's org (no cross-org binding). */
async function assertChannelsOwned(orgId: string, channelIds: string[]): Promise<void> {
	const owned = await getServiceDb()
		.select({ id: alertChannels.id })
		.from(alertChannels)
		.where(and(eq(alertChannels.org_id, orgId), inArray(alertChannels.id, channelIds)));
	if (owned.length !== channelIds.length) {
		throw new ActionRefusal("not-found", "One or more channels are invalid.");
	}
}
