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

/** A zone's slug by id (within the active scope), or null. */
export async function getZoneSlug(zoneId: string): Promise<string | null> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [zone] = await tx
			.select({ slug: zones.slug })
			.from(zones)
			.where(eq(zones.id, zoneId))
			.limit(1);
		return zone?.slug ?? null;
	});
}

/** A spec's slug path `{ zoneSlug, specSlug }` by spec id, or null if either is missing. */
export async function getSpecSlugPath(
	specId: string,
): Promise<{ zoneSlug: string; specSlug: string } | null> {
	const { userId } = await getOwnerScope();
	return withOwnerScope(userId, async (tx) => {
		const [row] = await tx
			.select({ specSlug: specs.slug, zoneSlug: zones.slug })
			.from(specs)
			.leftJoin(zones, eq(specs.zone_id, zones.id))
			.where(eq(specs.id, specId))
			.limit(1);
		if (!row?.specSlug || !row.zoneSlug) return null;
		return { zoneSlug: row.zoneSlug, specSlug: row.specSlug };
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
