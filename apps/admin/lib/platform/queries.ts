// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read models for the operator Orgs plane. Cross-tenant, via the service connection (RLS-bypass) —
// the PLATFORM_ADMIN_EMAILS allowlist behind Cloudflare Access is the wall.

import { desc, eq, ilike, or, sql } from "drizzle-orm";
import { enterpriseContract } from "@repo/platform/schema";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	organizationBilling,
	user,
} from "@/lib/db-schema";

export interface OrgListRow {
	id: string;
	name: string;
	slug: string | null;
	plan: string;
	status: string;
	ownerEmail: string | null;
}

/** Escapes LIKE wildcards so a user's `%`/`_`/`\` match literally. */
function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Orgs matching `search` (name / slug / owner email), newest first. Owner = earliest owner member. */
export async function searchOrgs(search?: string): Promise<OrgListRow[]> {
	const db = getServiceDb();
	const q = search?.trim();
	const like = q ? `%${escapeLike(q)}%` : null;

	// Owner email per org (earliest owner membership), as a correlated lateral-ish subquery.
	const ownerEmail = sql<string | null>`(
		select u.email from member m
		join "user" u on u.id = m.user_id
		where m.organization_id = ${organization.id} and m.role = 'owner'
		order by m.created_at asc limit 1
	)`;

	const rows = await db
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			plan: sql<string>`coalesce(${organizationBilling.plan}, 'community')`,
			status: sql<string>`coalesce(${organizationBilling.status}, 'none')`,
			ownerEmail,
		})
		.from(organization)
		.leftJoin(
			organizationBilling,
			eq(organizationBilling.organizationId, organization.id),
		)
		.where(
			like
				? or(
						ilike(organization.name, like),
						ilike(organization.slug, like),
						sql`exists (
							select 1 from member m join "user" u on u.id = m.user_id
							where m.organization_id = ${organization.id} and u.email ilike ${like}
						)`,
					)
				: undefined,
		)
		.orderBy(desc(organization.createdAt))
		.limit(50);

	return rows;
}

export interface OrgMember {
	email: string;
	name: string | null;
	role: string;
}
export interface OrgDetail {
	id: string;
	name: string;
	slug: string | null;
	billing: {
		plan: string;
		status: string;
		seats: number | null;
		currentPeriodEnd: string | null;
		stripeSubscriptionId: string | null;
	} | null;
	members: OrgMember[];
	contracts: {
		id: string;
		plan: string;
		collectionMethod: string;
		seats: number | null;
		termStart: string;
		termEnd: string | null;
		amountCents: number | null;
		currency: string;
		contractRef: string | null;
		createdByEmail: string;
		createdAt: string;
		revokedAt: string | null;
	}[];
}

/** Full operator view of one org: billing + members + contract history. */
export async function getOrgDetail(orgId: string): Promise<OrgDetail | null> {
	const db = getServiceDb();
	const [org] = await db
		.select({ id: organization.id, name: organization.name, slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	if (!org) return null;

	const [billing] = await db
		.select({
			plan: organizationBilling.plan,
			status: organizationBilling.status,
			seats: organizationBilling.seats,
			currentPeriodEnd: organizationBilling.currentPeriodEnd,
			stripeSubscriptionId: organizationBilling.stripeSubscriptionId,
		})
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);

	const members = await db
		.select({ email: user.email, name: user.name, role: member.role })
		.from(member)
		.innerJoin(user, eq(user.id, member.userId))
		.where(eq(member.organizationId, orgId))
		.orderBy(member.createdAt);

	const contracts = await db
		.select()
		.from(enterpriseContract)
		.where(eq(enterpriseContract.organizationId, orgId))
		.orderBy(desc(enterpriseContract.createdAt));

	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		billing: billing
			? {
					plan: billing.plan,
					status: billing.status,
					seats: billing.seats,
					currentPeriodEnd: billing.currentPeriodEnd?.toISOString() ?? null,
					stripeSubscriptionId: billing.stripeSubscriptionId,
				}
			: null,
		members,
		contracts: contracts.map((c) => ({
			id: c.id,
			plan: c.plan,
			collectionMethod: c.collectionMethod,
			seats: c.seats,
			termStart: c.termStart.toISOString(),
			termEnd: c.termEnd?.toISOString() ?? null,
			amountCents: c.amountCents,
			currency: c.currency,
			contractRef: c.contractRef,
			createdByEmail: c.createdByEmail,
			createdAt: c.createdAt.toISOString(),
			revokedAt: c.revokedAt?.toISOString() ?? null,
		})),
	};
}

/** The org's current Stripe customer id, if any (Flow A Stripe reuses it). */
export async function getOrgStripeCustomer(orgId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ id: organizationBilling.stripeCustomerId })
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row?.id ?? null;
}

