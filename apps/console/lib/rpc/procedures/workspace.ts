// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getGettingStartedState } from "@/app/server/actions/onboarding";
import { getProjects } from "@/app/server/actions/projects";
import { getEnvironmentsForSlug } from "@/app/server/actions/resolve";
import { listMyCases } from "@/app/server/actions/support";
import { getJobs, type JobWithMeta } from "@/app/server/actions/jobs";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { getEntitlements } from "@/lib/authz/entitlements";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";
import { isBillingActive } from "@/lib/billing/plan";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	member,
	organization,
	organizationBilling,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import { query } from "@/lib/rpc/base";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";

export interface WorkspaceOrg {
	id: string;
	name: string;
	/**
	 * URL slug for C2 routing (`/{slug}/…`). The synthetic personal scope uses the reserved `~`.
	 *
	 * NULLABLE, AND IT MUST NOT BE ALIASED. `organizations.slug` is `text().unique()` with no
	 * notNull, so a real org can have none — and this used to answer `r.slug ?? PERSONAL_ORG_SLUG`
	 * for that case, which made a real org indistinguishable on the wire from the user's PERSONAL
	 * workspace. The switcher then navigated anyone who picked it to `/~`: a different tenant,
	 * silently, with no error. An org with no slug has no URL, and saying so is the only honest
	 * answer — `null` here, and the switcher renders it non-selectable.
	 */
	slug: string | null;
	/** Served logo URL, or null → monogram. */
	logo: string | null;
	role: string;
	/** Effective billing plan — the org's plan while its subscription is live, else
	 * `community`. Drives the plan badge in the switcher. */
	plan: BillingPlan;
	/** Subscription status — drives the "Trial" highlight in the switcher. */
	status: BillingStatus;
}

export interface WorkspaceContext {
	/** The org the REQUEST is scoped to — the address's org (drives the PDP + RLS). */
	activeOrgId: string;
	/** Orgs the user belongs to; community = a single synthetic "Personal" workspace. */
	organizations: WorkspaceOrg[];
	entitlements: Entitlements;
	/** Hosted SaaS vs self-managed/community deployment — gates platform-fleet surfaces client-side. */
	isHosted: boolean;
}

/**
 * The dashboard's workspace context for `actor`: the org the request is scoped to, the orgs the
 * user can switch to, and the feature entitlements (the client uses these to gate the org switcher
 * and the admin surfaces). Community has no org plugin, so the `member` table may be empty, and then
 * the user's "Personal" workspace is synthesized.
 *
 * THE ACTOR IS THE ADDRESS'S (ADR 0005 R3, #6114). Every caller passes the actor its entry point
 * resolved — the read router binds `currentActor()`, which follows the URL's org — so
 * `activeOrgId` and `entitlements` describe the org the page is ON, never whichever org the
 * session last pointed at. It used to resolve from `getOwnerScope()` (the session), so a tab on B
 * with a session on A read A's entitlements.
 */
export async function readWorkspaceContext(actor: Actor): Promise<WorkspaceContext> {
	const rows = await getServiceDb()
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: member.role,
			plan: organizationBilling.plan,
			status: organizationBilling.status,
		})
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.leftJoin(organizationBilling, eq(organization.id, organizationBilling.organizationId))
		.where(eq(member.userId, actor.userId));

	const organizations: WorkspaceOrg[] =
		rows.length > 0
			? rows.map((r) => ({
					id: r.id,
					name: r.name,
					// NOT `?? PERSONAL_ORG_SLUG` — see the field's doc. Aliasing a slugless org onto
					// the reserved personal slug is how picking it navigated to the wrong tenant.
					slug: r.slug,
					logo: r.logo,
					role: r.role,
					// Effective plan: the paid plan only while the subscription is live.
					plan: r.plan && r.status && isBillingActive(r.status) ? r.plan : "community",
					status: r.status ?? "none",
				}))
			: [
					{
						id: actor.userId,
						name: "Personal",
						slug: PERSONAL_ORG_SLUG,
						logo: null,
						role: "owner",
						plan: "community",
						status: "none",
					},
				];

	return {
		activeOrgId: actor.orgId,
		organizations,
		entitlements: getEntitlements(actor),
		isHosted: deploymentMode() === "hosted",
	};
}

/** How many jobs the shell's feed carries: the bell lists 20, and toasts only follow new jobs. */
export const SHELL_JOB_FEED_LIMIT = 20;

/**
 * A job as the shell shows it — the bell, the toasts, the breadcrumbs, the palette, the overview's
 * recent-jobs card. A slim projection: none of the JSONB columns (`config_snapshot`,
 * `execution_metadata`), which the shell never renders and which made up most of a job's bytes.
 */
export type ShellJob = Pick<
	JobWithMeta,
	| "id"
	| "job_type"
	| "status"
	| "created_at"
	| "completed_at"
	| "error_message"
	| "project_id"
	| "project_name"
	| "project_slug"
	| "environment_name"
	| "environment_stage"
	| "cloud_provider"
	| "runner_id"
>;

/**
 * The org's newest jobs, capped at {@link SHELL_JOB_FEED_LIMIT}, in the slim {@link ShellJob} shape.
 * Same authorization and row scope as the full feed (`getJobs`): the PDP's `view job`, then the
 * caller's owner/org scope under RLS. Bounded by the LIMIT on `created_at DESC`, so its cost does
 * not grow with the org's history — which is what lets the `[org]` layout await it.
 */
export async function readRecentJobs(): Promise<ShellJob[]> {
	const actor = await authorize("view", { type: "job" });
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const rows = await tx
			.select({
				id: jobs.id,
				job_type: jobs.job_type,
				status: jobs.status,
				created_at: jobs.created_at,
				completed_at: jobs.completed_at,
				error_message: jobs.error_message,
				project_id: jobs.project_id,
				runner_id: jobs.runner_id,
				project_name: projects.project_name,
				project_slug: projects.slug,
				environment_name: projectEnvironments.name,
				environment_stage: projectEnvironments.stage,
				cloud_provider: cloudIdentities.provider,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(cloudIdentities, eq(jobs.cloud_identity_id, cloudIdentities.id))
			.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
			.orderBy(desc(jobs.created_at))
			.limit(SHELL_JOB_FEED_LIMIT);
		return rows.map((r) => ({
			...r,
			project_name: r.project_name ?? null,
			project_slug: r.project_slug ?? null,
			environment_name: r.environment_name ?? null,
			environment_stage: r.environment_stage ?? null,
			cloud_provider: r.cloud_provider ?? null,
		}));
	});
}

/**
 * The app shell's reads (ADR 0005 D1, #6114): everything the chrome around every `/{org}` page
 * shows — the org and plan, the project list, the job and support-case feeds behind the bell and
 * the toasts, the setup guide, the project's environments — served over GET and prefetched by the
 * `[org]` layout, so the shell paints with data and issues no request of its own on first load.
 *
 * `recentJobs` is the shell's job feed (capped, slim) and is what the layout prefetches. `jobs` is
 * the org's FULL job list for the few pages that need all of it (runners, the plan flow); it is
 * never prefetched by the layout — its size grows with the org's history.
 *
 * `context` owns its body (moved here from the workspace server action). The others call their
 * domain's existing reader IN-PROCESS — a plain function call, not a server-action POST — exactly as
 * `jobs.page` started (#6113): moving those bodies is their domain lane's (stress test R10).
 */
export const workspaceRouter = {
	context: query.handler(({ context }) => readWorkspaceContext(context.actor)),
	projects: query.handler(() => getProjects()),
	jobs: query.handler(() => getJobs()),
	recentJobs: query.handler(() => readRecentJobs()),
	supportCases: query.handler(() => listMyCases({})),
	setupGuide: query.handler(() => getGettingStartedState()),
	environments: query
		.input(z.object({ project: z.string().min(1).max(200) }))
		.handler(({ input }) => getEnvironmentsForSlug(input.project)),
};
