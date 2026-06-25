// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Signup onboarding: give every new user a real, named organization (slug = their
// provider username) and make them its owner. Runs from the Better Auth
// user.create.after hook. The org plugin is EE-gated and not loaded at init, so we
// write organization/member directly; resolveOrgScope reads these tables anyway.

import { eq } from "drizzle-orm";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { getServiceDb } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { pickFreeSlug, RESERVED_SLUGS, slugify } from "@/lib/routing";

interface NewUser {
	id: string;
	email: string;
	name?: string | null;
	username?: string | null;
}

/** The email local-part (`bob@x.com` → `bob`), or "" when unusable. */
function emailLocalPart(email: string): string {
	return email.split("@")[0] ?? "";
}

/**
 * Provisions a new user's primary organization: a real `organization` row named
 * after them (slug = their username, globally unique via pickFreeSlug), an owner
 * `member` row, and an owner grant mirrored into the PDP/OpenFGA. Idempotent — a
 * no-op once the user belongs to any org.
 */
export async function provisionPrimaryOrg(u: NewUser): Promise<void> {
	const db = getServiceDb();

	// Idempotency: skip if the user already has a membership.
	const existingMember = await db
		.select({ id: member.id })
		.from(member)
		.where(eq(member.userId, u.id))
		.limit(1);
	if (existingMember.length > 0) return;

	// Handle: prefer the provider username, then the display name, then the email
	// local-part. Drives both the org's display name and its slug.
	const handle = u.username || u.name || emailLocalPart(u.email) || "user";
	const orgName = `${handle}'s Org`;

	const taken = await db
		.select({ slug: organization.slug })
		.from(organization);
	const slug = pickFreeSlug(slugify(handle) || "org", [
		...taken.map((r) => r.slug),
		...RESERVED_SLUGS,
	]);

	const [org] = await db
		.insert(organization)
		.values({ name: orgName, slug })
		.returning({ id: organization.id });
	if (!org) return;

	await db.insert(member).values({
		organizationId: org.id,
		userId: u.id,
		role: "owner",
		status: "active",
	});

	// Owner grant for the new org (Postgres grant + OpenFGA tuple mirror).
	await ensureMemberGrant(org.id, u.id, "owner");
}
