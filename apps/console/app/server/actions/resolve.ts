"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug resolution. The `/{org}/{project}/{env}` route layers resolve each
// slug → entity id here (tenant-scoped via withOwnerScope / membership checks),
// then render the existing id-based views. `resolveOrgScope` also syncs the
// session's active organization so the rest of the request is scoped to the URL org.

import { and, eq } from "drizzle-orm";
import { getOwnerScope } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";
import { setActiveOrganization } from "./workspace";

export interface ResolvedOrg {
	orgId: string;
	isPersonal: boolean;
}

/**
 * Resolves the URL org segment to a scope and syncs the session's active org so the
 * rest of the request runs under it. `~` = the personal scope (orgId = userId). A
 * real slug must belong to an org the user is a member of, else it throws.
 */
export async function resolveOrgScope(orgSlug: string): Promise<ResolvedOrg> {
	const { userId, activeOrgId } = await getOwnerScope();

	if (orgSlug === PERSONAL_ORG_SLUG) {
		// Personal scope: orgId === userId. Clear any active org if one is set.
		if (activeOrgId && activeOrgId !== userId) {
			await setActiveOrganization(userId);
		}
		return { orgId: userId, isPersonal: true };
	}

	const db = getServiceDb();
	const [org] = await db
		.select({ id: organization.id })
		.from(organization)
		.innerJoin(
			member,
			and(eq(member.organizationId, organization.id), eq(member.userId, userId)),
		)
		.where(eq(organization.slug, orgSlug))
		.limit(1);

	if (!org) throw new Error("Organization not found");

	if (activeOrgId !== org.id) {
		await setActiveOrganization(org.id);
	}
	return { orgId: org.id, isPersonal: false };
}

/** Resolves a project (project) slug → project id within the active scope (404 → throws). Projects
 * are unique per org, so the slug resolves directly (RLS scopes to the active org). */
export async function resolveProjectId(projectSlug: string): Promise<string> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [project] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, projectSlug))
			.limit(1);
		if (!project) throw new Error("Project not found");
		return project.id;
	});
}

/** Resolves an environment name (within a project) → environment id. */
export async function resolveEnvironmentId(
	projectId: string,
	envName: string,
): Promise<string> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [env] = await tx
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					eq(projectEnvironments.name, envName),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found");
		return env.id;
	});
}

/**
 * The active org's URL slug (server side). Prefers the session's selected org;
 * otherwise falls back to the user's earliest org membership (so a freshly
 * signed-up user lands on their auto-created org), and finally `~` (personal).
 */
export async function getActiveOrgSlug(): Promise<string> {
	const { userId, activeOrgId } = await getOwnerScope();
	const db = getServiceDb();

	if (activeOrgId && activeOrgId !== userId) {
		const [org] = await db
			.select({ slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, activeOrgId))
			.limit(1);
		if (org?.slug) return org.slug;
	}

	// No explicit selection → land on the user's primary (earliest) org if any.
	const [primary] = await db
		.select({ slug: organization.slug })
		.from(organization)
		.innerJoin(
			member,
			and(eq(member.organizationId, organization.id), eq(member.userId, userId)),
		)
		.orderBy(member.createdAt)
		.limit(1);
	return primary?.slug ?? PERSONAL_ORG_SLUG;
}

/** A project (project) slug by project id (within the active scope), or null. */
export async function getProjectSlug(projectId: string): Promise<string | null> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [row] = await tx
			.select({ projectSlug: projects.slug })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		return row?.projectSlug ?? null;
	});
}

export interface SwitcherEnv {
	id: string;
	name: string;
	stage: string;
	is_default: boolean;
}

/**
 * Lists a project's environments resolved by project slug (for the EnvSwitcher).
 * Returns [] if the slugs don't resolve in the active scope (the switcher hides).
 */
export async function getEnvironmentsForSlug(
	projectSlug: string,
): Promise<SwitcherEnv[]> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [project] = await tx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.slug, projectSlug))
			.limit(1);
		if (!project) return [];
		return tx
			.select({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				stage: projectEnvironments.stage,
				is_default: projectEnvironments.is_default,
			})
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, project.id))
			.orderBy(projectEnvironments.created_at);
	});
}
