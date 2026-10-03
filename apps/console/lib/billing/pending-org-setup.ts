// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server-side record of a paid create-a-team setup (#5445) — `pending_org_setups`, see
// lib/db/schema/pending-org-setups.ts for why it exists and what stamps each column.
//
// Every function here takes the ACTOR's user id from its caller (a server action that read it from
// the session, or the organization plugin's hook that read it from the request) and filters on it.
// Nothing here trusts a user id, an org id or a subscription id from the browser on its own.
//
// FINDING THE ORGANIZATION. better-auth's `/organization/create` inserts the organization row, then
// the creator's `member` row, then runs `afterCreateOrganization` — three statements, no transaction.
// So an organization can exist with its marker and NO owner: in the gap between the inserts, or for
// good when the member insert fails. A lookup that joined on an owner member could not see it, and the
// resume then created a second organization. `findSetupOrg` instead finds the organization by
// `created_org_id`, or by the server-stamped marker (lib/billing/new-org-setup.ts) — neither depends on
// the member row — and, when the organization has NO members at all, adds the actor as its owner. It
// never adds the actor to an organization that has other members: a team someone else is in is not
// "the one I paid for and lost", whatever its metadata says.

import "server-only";
import { and, asc, desc, eq, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { ensureMemberGrant } from "@/lib/authz/grants";
import {
	NEW_ORG_CREATED_BY_KEY,
	NEW_ORG_SETUP_ORG_EXISTS_CODE,
	NEW_ORG_SUBSCRIPTION_KEY,
	newOrgCreatedByOf,
	newOrgSubscriptionIdOf,
} from "@/lib/billing/new-org-setup";
import { TAX_ID_TYPES, type TaxIdType } from "@/lib/billing/tax-ids";
import { getServiceDb } from "@/lib/db";
import { member, organization, pendingOrgSetups } from "@/lib/db/schema";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";

/** One `pending_org_setups` row. */
export type PendingOrgSetupRow = typeof pendingOrgSetups.$inferSelect;

/** The checkout billing details as the browser sends them — validated, never trusted as typed. */
export const pendingOrgSetupBillingSchema = z.object({
	name: z.string().max(200),
	line1: z.string().max(200),
	line2: z.string().max(200).optional(),
	city: z.string().max(200),
	state: z.string().max(200).optional(),
	postalCode: z.string().max(40),
	country: z.string().max(2),
	taxType: z.custom<TaxIdType>(
		(v) => typeof v === "string" && TAX_ID_TYPES.some((t) => t.value === v),
	),
	taxValue: z.string().max(64),
	useAsPrimary: z.boolean(),
});

/** A slug as the create-a-team form accepts it (the org's own rules decide availability later). */
export const pendingOrgSetupSlugSchema = z
	.string()
	.trim()
	.max(63)
	.regex(/^[a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * Records a new-org subscription the moment it is minted, before the client can pay it. A second call
 * for the same subscription (it never happens: Stripe ids are unique) changes nothing.
 */
export async function recordPendingOrgSetup(input: {
	userId: string;
	subscriptionId: string;
	customerId: string;
	name: string;
	slug: string;
}): Promise<void> {
	await getServiceDb()
		.insert(pendingOrgSetups)
		.values({
			user_id: input.userId,
			subscription_id: input.subscriptionId,
			customer_id: input.customerId,
			intended_name: input.name,
			intended_slug: input.slug,
		})
		.onConflictDoNothing({ target: pendingOrgSetups.subscription_id });
}

/**
 * Drops the record of a subscription that was replaced before it was paid (a currency switch, a
 * "← Back" and re-declare). Only while nothing has been created for it.
 */
export async function forgetPendingOrgSetup(userId: string, subscriptionId: string): Promise<void> {
	await getServiceDb()
		.delete(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.created_org_id),
				isNull(pendingOrgSetups.linked_at),
			),
		);
}

/** The actor's record for one subscription, or null — never another user's. */
export async function pendingOrgSetupFor(
	userId: string,
	subscriptionId: string,
): Promise<PendingOrgSetupRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
			),
		)
		.limit(1);
	return row ?? null;
}

/** The actor's setups whose last step (the payer declaration) has not been recorded, newest first. */
export async function unfinishedPendingOrgSetups(
	userId: string,
	limit = 10,
): Promise<PendingOrgSetupRow[]> {
	return getServiceDb()
		.select()
		.from(pendingOrgSetups)
		.where(and(eq(pendingOrgSetups.user_id, userId), isNull(pendingOrgSetups.declared_at)))
		.orderBy(desc(pendingOrgSetups.created_at))
		.limit(limit);
}

/** Saves the slug (and, when given, the checkout billing details) on the actor's unfinished record. */
export async function savePendingOrgSetupDetails(
	userId: string,
	subscriptionId: string,
	details: { slug: string; billing: PendingOrgSetupBilling | null },
): Promise<void> {
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({
			intended_slug: details.slug,
			...(details.billing ? { billing: details.billing } : {}),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.declared_at),
			),
		);
}

/** Stamps the link step: the subscription now names `orgId`. */
export async function markPendingOrgSetupLinked(
	userId: string,
	subscriptionId: string,
	orgId: string,
): Promise<void> {
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ created_org_id: orgId, linked_at: new Date(), updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
			),
		);
}

/**
 * Stamps the last step — the payer declaration for `orgId` — on the actor's record for that org, and
 * drops the billing details it no longer needs.
 */
export async function markPendingOrgSetupDeclared(userId: string, orgId: string): Promise<void> {
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ declared_at: new Date(), billing: null, updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.created_org_id, orgId),
				isNull(pendingOrgSetups.declared_at),
			),
		);
}

/**
 * What `beforeCreateOrganization` should do with a create's metadata: leave it alone (null — it
 * carries neither key), replace it, or refuse the create.
 */
export type NewOrgMetadataVerdict =
	| null
	| { metadata: Record<string, unknown> | undefined }
	| { refusal: { code: string; message: string } };

/**
 * The organization plugin's `beforeCreateOrganization` half (ee/src/new-org-setup-hooks.ts). Returns
 * the metadata to insert: the marker kept, and the creator stamped beside it, only when `userId` owns
 * the setup record the marker names. Both keys are removed from anything else, so no client can make
 * an organization claim a setup it does not own.
 *
 * Refuses a create naming a setup that already has an organization — the server-side idempotency key
 * for "one organization per charge". Two creates arriving inside the same instant can both pass this
 * check; the slug's unique index then refuses the second when both carry the same slug, and the resume
 * converges on the older organization when they do not.
 */
export async function stampNewOrgMetadata(
	metadata: unknown,
	userId: string,
): Promise<NewOrgMetadataVerdict> {
	if (typeof metadata !== "object" || metadata === null) return null;
	if (!(NEW_ORG_SUBSCRIPTION_KEY in metadata) && !(NEW_ORG_CREATED_BY_KEY in metadata)) return null;
	const subscriptionId = newOrgSubscriptionIdOf(metadata);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (key !== NEW_ORG_SUBSCRIPTION_KEY && key !== NEW_ORG_CREATED_BY_KEY) rest[key] = value;
	}
	const keep = (): NewOrgMetadataVerdict => ({
		metadata: Object.keys(rest).length > 0 ? rest : undefined,
	});
	if (!subscriptionId) return keep();
	const row = await pendingOrgSetupFor(userId, subscriptionId);
	if (!row) return keep();
	if (row.created_org_id || (await markedOrgs(subscriptionId, userId)).length > 0) {
		return {
			refusal: {
				code: NEW_ORG_SETUP_ORG_EXISTS_CODE,
				message: "A team was already created for this payment.",
			},
		};
	}
	return {
		metadata: {
			...rest,
			[NEW_ORG_SUBSCRIPTION_KEY]: subscriptionId,
			[NEW_ORG_CREATED_BY_KEY]: userId,
		},
	};
}

/**
 * The organization plugin's `beforeUpdateOrganization` half: an update that writes the metadata blob
 * gets the two marker keys from what is STORED, never from the request. Without it any admin could
 * write a marker naming someone else's charge onto their own organization (blocking that customer's
 * setup), and a settings save that rewrites the blob would drop a real one. Null when the update does
 * not touch the metadata.
 */
export async function keepStoredNewOrgMarker(
	orgId: string,
	metadata: unknown,
): Promise<{ metadata: Record<string, unknown> } | null> {
	if (typeof metadata !== "object" || metadata === null) return null;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (key !== NEW_ORG_SUBSCRIPTION_KEY && key !== NEW_ORG_CREATED_BY_KEY) next[key] = value;
	}
	const [stored] = await getServiceDb()
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	const subscriptionId = newOrgSubscriptionIdOf(stored?.metadata ?? null);
	const createdBy = newOrgCreatedByOf(stored?.metadata ?? null);
	if (subscriptionId) next[NEW_ORG_SUBSCRIPTION_KEY] = subscriptionId;
	if (createdBy) next[NEW_ORG_CREATED_BY_KEY] = createdBy;
	return { metadata: next };
}

/**
 * The organization plugin's `afterCreateOrganization` half: records the new organization on the
 * creator's setup record. Only for a marker the before-hook stamped for this same user.
 */
export async function recordNewOrgCreated(
	orgId: string,
	metadata: unknown,
	userId: string,
): Promise<void> {
	const subscriptionId = newOrgSubscriptionIdOf(metadata);
	if (!subscriptionId || newOrgCreatedByOf(metadata) !== userId) return;
	await getServiceDb()
		.update(pendingOrgSetups)
		.set({ created_org_id: orgId, updated_at: new Date() })
		.where(
			and(
				eq(pendingOrgSetups.user_id, userId),
				eq(pendingOrgSetups.subscription_id, subscriptionId),
				isNull(pendingOrgSetups.created_org_id),
			),
		);
}

/**
 * Organizations whose server-stamped marker names `subscriptionId` and `userId` as creator, oldest
 * first. The LIKE is only a prefilter (it can over-match: `_` is a wildcard); the parsed metadata
 * decides.
 */
async function markedOrgs(
	subscriptionId: string,
	userId: string,
): Promise<{ id: string; slug: string | null }[]> {
	const candidates = await getServiceDb()
		.select({ id: organization.id, slug: organization.slug, metadata: organization.metadata })
		.from(organization)
		.where(like(organization.metadata, `%${subscriptionId}%`))
		.orderBy(asc(organization.createdAt));
	return candidates.filter(
		(o) =>
			newOrgSubscriptionIdOf(o.metadata) === subscriptionId &&
			newOrgCreatedByOf(o.metadata) === userId,
	);
}

/**
 * The organization created for the actor's setup `row`, found without depending on the owner member
 * row; null when there is none, or when it is a team the actor is not in and others are.
 *
 * Found by `created_org_id`, else by the server-stamped marker (and then recorded as
 * `created_org_id`, once it is known to be the actor's). An organization with NO members — better-auth's member insert never landed — is
 * repaired by adding the actor as its owner, with the owner grant `afterCreateOrganization` would have
 * written. Both ways of finding it are proof the actor created it: the hook stamped the marker from the
 * request's own session, and `created_org_id` is written only from that marker or by a link the actor
 * was authorized for in that organization.
 */
export async function findSetupOrg(
	row: PendingOrgSetupRow,
	userId: string,
): Promise<{ id: string; slug: string } | null> {
	if (row.user_id !== userId) return null;
	const db = getServiceDb();
	let org: { id: string; slug: string | null } | null = null;
	if (row.created_org_id) {
		const [found] = await db
			.select({ id: organization.id, slug: organization.slug })
			.from(organization)
			.where(eq(organization.id, row.created_org_id))
			.limit(1);
		org = found ?? null;
	}
	let foundByMarker = false;
	if (!org) {
		const [marked] = await markedOrgs(row.subscription_id, userId);
		if (!marked) return null;
		org = marked;
		foundByMarker = true;
	}
	const members = await db
		.select({ userId: member.userId })
		.from(member)
		.where(eq(member.organizationId, org.id));
	if (!members.some((m) => m.userId === userId)) {
		if (members.length > 0) return null;
		// Inserted only while the organization still has no member at all, in one statement, so two
		// resumes racing here cannot both add a row, and nothing lands in a team someone joined since.
		await db.execute(sql`
			insert into public.member (organization_id, user_id, role)
			select ${org.id}::uuid, ${userId}::uuid, 'owner'
			 where not exists (select 1 from public.member where organization_id = ${org.id}::uuid)`);
		const [mine] = await db
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.organizationId, org.id), eq(member.userId, userId)))
			.limit(1);
		if (!mine) return null;
		await ensureMemberGrant(org.id, userId, mine.role);
	}
	// Recorded only now, once the organization is known to be the actor's.
	if (foundByMarker) {
		await db
			.update(pendingOrgSetups)
			.set({ created_org_id: org.id, updated_at: new Date() })
			.where(and(eq(pendingOrgSetups.id, row.id), eq(pendingOrgSetups.user_id, userId)));
	}
	return { id: org.id, slug: org.slug ?? "" };
}
