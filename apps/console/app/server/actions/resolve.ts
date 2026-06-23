"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// C2 slug resolution. The `/{org}/{zone}/{spec}/{env}` route layers resolve each
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
	specEnvironments,
	specs,
	zones,
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

/** Resolves a zone slug → zone id within the active scope (404 → throws). */
export async function resolveZoneId(zoneSlug: string): Promise<string> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [zone] = await tx
			.select({ id: zones.id })
			.from(zones)
			.where(eq(zones.slug, zoneSlug))
			.limit(1);
		if (!zone) throw new Error("Zone not found");
		return zone.id;
	});
}

/** Resolves a spec slug (within a zone) → spec id. */
export async function resolveSpecId(
	zoneId: string,
	specSlug: string,
): Promise<string> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [spec] = await tx
			.select({ id: specs.id })
			.from(specs)
			.where(and(eq(specs.zone_id, zoneId), eq(specs.slug, specSlug)))
			.limit(1);
		if (!spec) throw new Error("Spec not found");
		return spec.id;
	});
}

/** Resolves an environment name (within a spec) → environment id. */
export async function resolveEnvironmentId(
	specId: string,
	envName: string,
): Promise<string> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [env] = await tx
			.select({ id: specEnvironments.id })
			.from(specEnvironments)
			.where(
				and(
					eq(specEnvironments.spec_id, specId),
					eq(specEnvironments.name, envName),
				),
			)
			.limit(1);
		if (!env) throw new Error("Environment not found");
		return env.id;
	});
}

export interface SwitcherEnv {
	id: string;
	name: string;
	stage: string;
	is_default: boolean;
}

/**
 * Lists a spec's environments resolved by zone+spec slug (for the EnvSwitcher).
 * Returns [] if the slugs don't resolve in the active scope (the switcher hides).
 */
export async function getEnvironmentsForSlug(
	zoneSlug: string,
	specSlug: string,
): Promise<SwitcherEnv[]> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [zone] = await tx
			.select({ id: zones.id })
			.from(zones)
			.where(eq(zones.slug, zoneSlug))
			.limit(1);
		if (!zone) return [];
		const [spec] = await tx
			.select({ id: specs.id })
			.from(specs)
			.where(and(eq(specs.zone_id, zone.id), eq(specs.slug, specSlug)))
			.limit(1);
		if (!spec) return [];
		return tx
			.select({
				id: specEnvironments.id,
				name: specEnvironments.name,
				stage: specEnvironments.stage,
				is_default: specEnvironments.is_default,
			})
			.from(specEnvironments)
			.where(eq(specEnvironments.spec_id, spec.id))
			.orderBy(specEnvironments.created_at);
	});
}
