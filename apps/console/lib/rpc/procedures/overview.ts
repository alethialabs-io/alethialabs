// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import {
	getAiUsageSummary,
	getCollaborationAccess,
	getOrgUsage,
} from "@/app/server/actions/billing";
import {
	type ProjectListResult,
	getProjects,
	queryProjects,
} from "@/app/server/actions/projects";
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { isBillingConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { offeredClouds } from "@/lib/cloud-providers/availability";
import { getServiceDb } from "@/lib/db";
import { alertDeliveries, member } from "@/lib/db/schema";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { toDeliveryDTO } from "@/lib/queries/alerts-lists";
import { query } from "@/lib/rpc/base";
import { readConnectedCloudProviders } from "@/lib/rpc/procedures/connectors";

/** How many deliveries the overview's Alerts card lists. */
export const OVERVIEW_ALERT_ROWS = 4;

/**
 * Everything the overview's Usage card shows, and the one plan capability the overview's Create
 * menu needs (`canInvite`). Only the fields the overview renders travel — not the billing
 * summary's Stripe price, seats or lifecycle state.
 */
export interface OverviewUsage {
	/** Stripe is wired on this deployment (hosted). Self-managed shows no plan CTA. */
	hosted: boolean;
	plan: BillingPlan;
	/** Members occupying a seat; 0 in the personal scope. */
	memberCount: number;
	/** Whether this org may invite members (the Create menu's "Org member" item). */
	canInvite: boolean;
	/** Runner minutes over the CURRENT BILLING PERIOD — `periodStart` is that window's start (ISO). */
	runner: { usedMinutes: number; includedMinutes: number; periodStart: string };
	/** Jobs in flight vs the plan's concurrency cap (`max` null = unlimited). */
	concurrency: { running: number; max: number | null };
	/** The AI windows: the rolling 5-hour session and the fixed week. */
	ai: {
		enabled: boolean;
		sessionUsed: number;
		sessionBudget: number;
		sessionResetAt: string | null;
		weeklyUsed: number;
		weeklyBudget: number;
		weeklyResetAt: string;
	};
}

/** Members occupying a seat in the actor's org; 0 in the personal scope, which has no members. */
async function readSeatCount(actor: Actor): Promise<number> {
	if (actor.orgId === actor.userId) return 0;
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(member)
		.where(eq(member.organizationId, actor.orgId));
	return row?.n ?? 0;
}

/**
 * The overview's usage read: the org's metered consumption, its plan, and its seat count.
 *
 * The three usage readers are the billing domain's, called IN-PROCESS — a plain function call, not
 * a server-action POST — as `workspace.*` does (#6114). Moving their bodies out of the billing
 * action module is #6127's (ADR 0005 stress test R10): that module is its scope, and the usage and
 * billing pages read the same functions. Each resolves its actor with `currentActor()`, which the
 * `query` base binds to the actor this procedure was given — resolved from the ADDRESS, never from
 * the session's org.
 *
 * THE PLAN IS READ HERE, FROM THE BILLING ROW, AND A FAILED READ FAILS THE CARD. `getOrgUsage`
 * reads the same row but swallows a failure into `null`, i.e. into the community plan, the
 * community allowance and a month-start window — an error rendered as data, showing a paid org an
 * Upgrade button (RUBRIC B4). So the plan does not come from there: `getOrgBilling` is read
 * without a catch, and if `getOrgUsage`'s own read of that row fell back (its plan disagrees with
 * the row's), the whole read fails rather than render the fallback's allowance and window.
 *
 * Not through `getBillingSummary`, which the card used to call: that reader retrieves the Stripe
 * subscription (and, on a paid plan, the plan's live price) for the billing page's plan card, and
 * the overview shows neither.
 */
export async function readOverviewUsage(actor: Actor): Promise<OverviewUsage> {
	const [billing, usage, ai, collaboration, memberCount] = await Promise.all([
		getOrgBilling(actor.orgId),
		getOrgUsage(),
		getAiUsageSummary(),
		getCollaborationAccess(),
		readSeatCount(actor),
	]);
	const plan = billing?.plan ?? "community";
	if (usage.plan !== plan) {
		throw new Error("The usage read fell back from the org's billing row; refusing to render the fallback.");
	}
	return {
		hosted: isBillingConfigured(),
		plan,
		memberCount,
		canInvite: collaboration.canInvite,
		runner: {
			usedMinutes: usage.usedMinutes,
			includedMinutes: usage.includedMinutes,
			periodStart: usage.periodStart,
		},
		concurrency: { running: usage.runningJobs, max: usage.maxConcurrentJobs },
		ai: {
			enabled: ai.enabled,
			sessionUsed: ai.sessionUsed,
			sessionBudget: ai.sessionBudget,
			sessionResetAt: ai.sessionResetAt,
			weeklyUsed: ai.weeklyUsed,
			weeklyBudget: ai.weeklyBudget,
			weeklyResetAt: ai.weeklyResetAt,
		},
	};
}

/** The overview's Alerts card: whether the plan includes alerting, and the newest deliveries. */
export interface OverviewAlerts {
	/** The plan includes alerting. When false the card shows the plan gate, not the rows. */
	alerting: boolean;
	/** The newest {@link OVERVIEW_ALERT_ROWS} deliveries in the org's ledger. */
	deliveries: DeliveryDTO[];
}

/**
 * The overview's alerts read — the newest few deliveries, not the Alerts page's whole bootstrap
 * (channels, policies, condition options), which the card never showed, and not the Alerts page's
 * filtered ledger either, whose facet pass the card has no use for.
 *
 * A reader without `view_alerts` is refused (`FORBIDDEN` on the wire), and the card renders that
 * as its own state. The PLAN gate is data (`alerting`), not a refusal: a refused read is not
 * dehydrated into the first paint, so a typed refusal here would make every org without alerting —
 * the default plan — fetch again in the browser on every visit. A plan without alerting gets no
 * rows: the card shows the gate, so they would travel for nothing.
 */
export async function readOverviewAlerts(): Promise<OverviewAlerts> {
	const actor = await authorize("view_alerts", { type: "alert" });
	if (!getEntitlements(actor).alerting) return { alerting: false, deliveries: [] };
	const rows = await getServiceDb()
		.select()
		.from(alertDeliveries)
		.where(eq(alertDeliveries.org_id, actor.orgId))
		.orderBy(desc(alertDeliveries.created_at))
		.limit(OVERVIEW_ALERT_ROWS);
	return { alerting: true, deliveries: rows.map(toDeliveryDTO) };
}

/**
 * The grid's search, filter and sort, as the address carries them. Every field is always present,
 * so the page's prefetch and the browser's read build one key from one address.
 */
const projectsInput = z.object({
	q: z.string().max(200),
	clouds: z.array(z.string().min(1).max(64)).max(32),
	repos: z.array(z.string().min(1).max(2048)).max(64),
	sort: z.enum(["activity", "name"]),
});

/** {@link readOverviewProjects}'s input. */
type OverviewProjectsInput = z.infer<typeof projectsInput>;

/**
 * Everything the overview's project grid shows, in one read: the projects domain's list as it
 * answers it — the matching rows, and every cloud and repository in the org with its count over the
 * UNFILTERED list — plus what the grid needs about the viewer and the deployment.
 */
export interface OverviewProjects extends ProjectListResult {
	/**
	 * How many projects the organization has, whatever the search and filters, or `null` when a
	 * filtered read could not count them. The Usage card prints it; it does not decide what the
	 * grid renders.
	 */
	total: number | null;
	/**
	 * The cloud slugs with a connected account, or `null` when that could not be read. It decides a
	 * logo's colour and the empty state's first step, so its failure must not fail the grid.
	 */
	connectedProviders: string[] | null;
	/** The cloud slugs this deployment offers, in catalog order. */
	offeredClouds: string[];
	/** Whether the viewer may create a project in this organization. */
	canCreate: boolean;
}

/**
 * The overview grid's read: the projects as searched, filtered and sorted, the facet universe, and
 * what the grid needs about the viewer and the deployment to render each project truthfully.
 *
 * `queryProjects` is the projects domain's reader, called IN-PROCESS as the other overview reads
 * call theirs; it authorizes `view` on projects, so a viewer without it is refused (`FORBIDDEN` on
 * the wire) and the grid renders that as its own state. The create decision is asked with `can()`,
 * which records nothing: this read is refetched on every live hint.
 *
 * Two parts are allowed to fail without failing the grid, because neither is the grid: the
 * connected clouds, and the organization's total under a filter (unfiltered, the rows ARE the
 * total and nothing more is read).
 */
export async function readOverviewProjects(actor: Actor, input: OverviewProjectsInput): Promise<OverviewProjects> {
	const filtered = input.q.trim() !== "" || input.clouds.length > 0 || input.repos.length > 0;
	const [list, everyProject, connectedProviders, create] = await Promise.all([
		queryProjects(input),
		filtered
			? getProjects()
					.then((rows) => rows.length)
					.catch(() => null)
			: null,
		readConnectedCloudProviders().catch(() => null),
		getPdp().can(actor, "create", { type: "project" }),
	]);
	// The list is passed through whole. This read computes no facet of its own: the facet pass is
	// `queryProjects`'s, and that is the name the filter standard's ledger carries it under.
	return {
		...list,
		total: filtered ? everyProject : list.projects.length,
		connectedProviders,
		offeredClouds: [...offeredClouds()],
		canCreate: create.allowed,
	};
}

/**
 * The overview domain's reads (ADR 0005 D1, #6118). The page prefetches each through
 * `serverOrpc()` and each region reads its own, so one failing read takes down one region
 * (RUBRIC B5). There is no recent-jobs read here: the Recent-jobs card reads the shell's job feed
 * (`workspace.recentJobs`, #6114), which the `[org]` layout already prefetches.
 */
export const overviewRouter = {
	usage: query.handler(({ context }) => readOverviewUsage(context.actor)),
	alerts: query.handler(() => readOverviewAlerts()),
	projects: query
		.input(projectsInput)
		.handler(({ context, input }) => readOverviewProjects(context.actor, input)),
};
