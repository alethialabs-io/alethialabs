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
import { getPdp } from "@/lib/authz";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { isBillingConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { offeredClouds } from "@/lib/cloud-providers/availability";
import { getServiceDb, withActorScope } from "@/lib/db";
import { alertDeliveries, member } from "@/lib/db/schema";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { toDeliveryDTO } from "@/lib/queries/alerts-lists";
import { KEYSET_DEFAULT_LIMIT, KEYSET_MAX_LIMIT, type KeysetPosition, keysetPageInput } from "@/lib/queries/keyset";
import { type ProjectsPage, countProjects, queryProjectsPage } from "@/lib/queries/projects";
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
 * The grid's search, filter and sort, as the address carries them — the list's KEY. Every address
 * field is always present, so the page's prefetch and the browser's read build one key from one
 * address. `ids` is the grid's starred-projects lookup (the favourites live in the browser), bounded
 * by the page size it is read with.
 */
const projectsQuery = z.object({
	q: z.string().max(200),
	clouds: z.array(z.string().min(1).max(64)).max(32),
	repos: z.array(z.string().min(1).max(2048)).max(64),
	sort: z.enum(["activity", "name"]),
	ids: z.array(z.uuid()).max(KEYSET_MAX_LIMIT).optional(),
});

/** One keyset page of the grid: the query plus the opaque cursor and the page size. */
const projectsPageInput = projectsQuery.extend(keysetPageInput());

/** What the grid is asked, without the paging fields — the normalized query, and the key. */
type OverviewProjectsQuery = z.infer<typeof projectsQuery>;

/**
 * One keyset page of the overview grid (LST-4 #7486): `queryProjectsPage` inside the actor's
 * scoped transaction, so the org wall is the RLS policy on `projects`. It authorizes `view` on
 * projects first, so a viewer without it is refused (`FORBIDDEN` on the wire) and the grid renders
 * that as its own state. The facets ride on the first page only; nothing here counts the list.
 */
export async function readOverviewProjectsPage(
	input: OverviewProjectsQuery & { cursor?: KeysetPosition; limit?: number },
): Promise<ProjectsPage> {
	const actor = await authorize("view", { type: "project" });
	const { cursor, limit = KEYSET_DEFAULT_LIMIT, ...query } = input;
	return withActorScope(actor, (tx) => queryProjectsPage(tx, query, { cursor, limit }));
}

/**
 * What the grid needs about the organization, the viewer and the deployment to render each project
 * truthfully — none of it a property of one page, so none of it rides on the pages.
 */
export interface OverviewProjectsSummary {
	/**
	 * How many projects the organization has. The Usage card prints it (a usage figure, the CONTENT
	 * of that card); the grid never does — it carries no list count (lib/query/README.md → "Counts").
	 */
	projectCount: number;
	/**
	 * The cloud slugs with a connected account, or `null` when that could not be read. It decides a
	 * logo's colour and the empty state's first step, so its failure must not fail the read.
	 */
	connectedProviders: string[] | null;
	/** The cloud slugs this deployment offers, in catalog order. */
	offeredClouds: string[];
	/** Whether the viewer may create a project in this organization. */
	canCreate: boolean;
}

/**
 * The grid's summary read. Authorizes `view` on projects like the page, so the two refuse together.
 * The create decision is asked with `can()`, which records nothing: this read is refetched on every
 * live hint, because it sits under the `overview.projects` key prefix the `projects`, `connectors`
 * and deploy topics already invalidate (`lib/query/topics.ts`).
 */
export async function readOverviewProjectsSummary(actor: Actor): Promise<OverviewProjectsSummary> {
	const viewer = await authorize("view", { type: "project" });
	const [projectCount, connectedProviders, create] = await Promise.all([
		withActorScope(viewer, countProjects),
		readConnectedCloudProviders().catch(() => null),
		getPdp().can(actor, "create", { type: "project" }),
	]);
	return {
		projectCount,
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
	/**
	 * The project grid. Nested so `orpc.overview.projects.key()` — the prefix every live topic names —
	 * reaches both the pages and the summary beside them.
	 */
	projects: {
		page: query.input(projectsPageInput).handler(({ input }) => readOverviewProjectsPage(input)),
		summary: query.handler(({ context }) => readOverviewProjectsSummary(context.actor)),
	},
};
