// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { z } from "zod";
import { getProjects } from "@/app/server/actions/projects";
import { type CatalogCategory, CATEGORIES } from "@/lib/alerts/catalog";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import { ACTIONS, RESOURCES } from "@/lib/authz/registry";
import type { Actor } from "@/lib/authz/types";
import { isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { provisionJobType } from "@/lib/db/schema/enums";
import {
	type AlertChannelsPage,
	type AlertChannelsQuery,
	type AlertDeliveriesPage,
	type AlertDeliveriesQuery,
	type AlertPoliciesPage,
	type AlertPoliciesQuery,
	queryAlertChannelsPage,
	queryAlertDeliveriesPage,
	queryAlertPoliciesPage,
} from "@/lib/queries/alerts-lists";
import { query } from "@/lib/rpc/base";

/** Selectable values for the policy "conditions" (match) filters. */
export interface ConditionOptions {
	projects: { value: string; label: string }[];
	jobTypes: string[];
	resourceTypes: string[];
	actions: string[];
}

/**
 * What the Alerts hub needs that is not a list row: the plan gate, the caller's capability, the
 * event catalog and the option lists of the policy editor. The three lists are their own reads
 * (`alerts.policies` / `alerts.channels` / `alerts.deliveries`); their pristine pages are also the
 * universes the panels select and cross-reference against.
 */
export interface AlertsSettings {
	/** Whether the org's plan unlocks the alerting surface at all (team+). */
	alerting: boolean;
	/** Whether PDP-sourced (authz.*) security events are unlocked (enterprise). */
	advancedAlerting: boolean;
	/** Whether the caller holds `manage_alerts` — drives create/edit/delete UI. */
	canManage: boolean;
	encryptionConfigured: boolean;
	/** The curated event catalog (categories → events) for the policy editor. */
	categories: CatalogCategory[];
	/** Option lists for the policy "conditions" (match) filters; empty below the plan gate. */
	conditionOptions: ConditionOptions;
}

/**
 * Non-recording `manage_alerts` probe — surfaces caller capability to the client UI.
 *
 * `can()`, never `enforce()` (#5660): `enforce` records an `authz_activity_log` row for every
 * non-read allow AND every deny, so probing with it put a "managed alerts" row (or, for a
 * non-manager, a DENIAL row) in the org's audit trail on every hub load. This answer only shows or
 * hides controls; it authorizes nothing. Each mutation re-checks with the recording
 * `authorize("manage_alerts")`.
 */
async function canManageAlerts(actor: Actor): Promise<boolean> {
	const decision = await getPdp().can(actor, "manage_alerts", { type: "alert" });
	return decision.allowed;
}

/**
 * The hub's settings read (#6125). Moved here from the `getAlertsBootstrap` server action, minus
 * the channel/policy/delivery universes and the stats nobody rendered: those are list reads now.
 *
 * Every field answers for the ADDRESSED org (the actor the read router resolved). Below the plan
 * gate this is data (`alerting: false`), not a refusal, for the reason `overview.alerts` gives: the
 * route decides the gate on the server and renders the upsell without reading this at all, so a
 * typed refusal would only ever be met by a stale tab — and the empty option lists are all it
 * would carry.
 */
export async function readAlertsSettings(): Promise<AlertsSettings> {
	const actor = await authorize("view_alerts", { type: "alert" });
	const entitlements = getEntitlements(actor);
	const canManage = await canManageAlerts(actor);
	const projectList = entitlements.alerting ? await getProjects().catch(() => []) : [];
	return {
		alerting: entitlements.alerting,
		advancedAlerting: entitlements.advancedAlerting,
		canManage,
		encryptionConfigured: isCredEncryptionConfigured(),
		categories: CATEGORIES,
		conditionOptions: {
			projects: projectList.map((p) => ({ value: p.id, label: p.project_name })),
			jobTypes: entitlements.alerting ? [...provisionJobType.enumValues] : [],
			resourceTypes: entitlements.alerting ? [...RESOURCES, "role", "grant"] : [],
			actions: entitlements.alerting ? [...ACTIONS, "assign", "revoke"] : [],
		},
	};
}

/**
 * The org's alert channels for `q`: rows filtered SERVER-SIDE in SQL + type/status facet counts over
 * the org's UNFILTERED channels (lib/query/README.md, steps 5 + 6). Moved from `getAlertChannelsPage`.
 */
export async function readAlertChannelsPage(q: AlertChannelsQuery = {}): Promise<AlertChannelsPage> {
	const actor = await authorize("view_alerts", { type: "alert" });
	return queryAlertChannelsPage(actor.orgId, q);
}

/**
 * The org's alert policies for `q`: rows filtered SERVER-SIDE in SQL + status/kind/channel facet
 * counts over the org's UNFILTERED policies. Moved from `getAlertPoliciesPage`.
 */
export async function readAlertPoliciesPage(q: AlertPoliciesQuery = {}): Promise<AlertPoliciesPage> {
	const actor = await authorize("view_alerts", { type: "alert" });
	return queryAlertPoliciesPage(actor.orgId, q);
}

/**
 * The org's delivery ledger for `q`: filtered SERVER-SIDE in SQL and THEN windowed (newest first,
 * 50 by default), with status facet counts over the WHOLE ledger. Moved from
 * `getAlertDeliveriesPage`.
 */
export async function readAlertDeliveriesPage(q: AlertDeliveriesQuery = {}): Promise<AlertDeliveriesPage> {
	const actor = await authorize("view_alerts", { type: "alert" });
	return queryAlertDeliveriesPage(actor.orgId, q);
}

/** A free-text search term, as the filter bars send it (trimmed client-side; bounded here). */
const search = z.string().max(200).optional();
/** A multi-select facet's values (sorted and deduped client-side; bounded here). */
const values = z.array(z.string().max(120)).max(50).optional();

/**
 * The alerts domain's reads (ADR 0005 D1, #6125). Each list takes its panel's NORMALIZED query
 * (`components/alerts/alerts-query.ts`), so the key the route prefetches and the key the panel asks
 * for are the same object. Every read authorizes `view_alerts` on the ADDRESSED org and scopes its
 * SQL to that org — a reader without it is `FORBIDDEN` on the wire.
 */
export const alertsRouter = {
	settings: query.handler(() => readAlertsSettings()),
	policies: query
		.input(z.object({ search, status: values, kinds: values, channels: values }))
		.handler(({ input }) => readAlertPoliciesPage(input)),
	channels: query
		.input(z.object({ search, types: values, status: values }))
		.handler(({ input }) => readAlertChannelsPage(input)),
	deliveries: query
		.input(z.object({ search, status: values, limit: z.number().int().min(1).max(200).optional() }))
		.handler(({ input }) => readAlertDeliveriesPage(input)),
};
