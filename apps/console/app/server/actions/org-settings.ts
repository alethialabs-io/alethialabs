"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the active org's General-settings fields. Name + slug live on the organization
// row; the rest (description, data region, default Project env, Terraform version) live in
// the org `metadata` JSON. Writes go through better-auth `organization.update` from the
// client (it owns the org row + hooks).

import { eq } from "drizzle-orm";
import { authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import {
	type OrgMeta,
	type OrgPrimaryAddress,
	type OrgSettings,
	orgSettingsForOrg,
	parseMeta,
} from "@/lib/org/settings";

export type { OrgPrimaryAddress, OrgSettings } from "@/lib/org/settings";

// The by-id read (orgSettingsForOrg) lives in lib/org/settings.ts. It takes an org id and reads
// through the service client with no session, so as an export of this `"use server"` file it
// answered ANY org's name, description and billing address to anyone who could name the id
// (#5219). Its callers — getOrgSettings below and the CLI route — resolve the org first.

/** The active org's General-settings values, or null in the personal scope (no real org). */
export async function getOrgSettings(): Promise<OrgSettings | null> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return null;
	return orgSettingsForOrg(actor.orgId);
}

/**
 * Stores an org's primary address in its metadata JSON — set from the checkout form when "Use the
 * billing address as my team's primary address" is checked. Merged into the existing metadata.
 *
 * @param orgId the org to write to, when it is not the ambient one. NAMED for the same reason
 * `startProTrial` and `linkSubscriptionToNewOrg` are: the create-org sheet runs from a page inside
 * the CURRENT org and then writes to the org it has just created, so under URL-wins the ambient org
 * is the wrong one — ticking "use as my primary address" while creating a team from `/acme/…`
 * silently overwrote ACME's primary address, and the caller's `catch {}` meant nothing surfaced.
 * Optional because `upgrade-org-sheet` and `onboarding-form` genuinely mean the ambient org.
 *
 * It is still never client-supplied in the ambient case — an id passed here is authorized through
 * `authorizeInOrg`, which refuses an org the caller is not scoped to.
 */
export async function updateOrgPrimaryAddress(
	address: OrgPrimaryAddress,
	orgId?: string,
): Promise<{ ok: true }> {
	const actor = orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, orgId)
		: await currentActor();
	if (actor.orgId === actor.userId) {
		throw new Error("No organization in scope.");
	}
	const db = getServiceDb();
	const [org] = await db
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	const next: OrgMeta = { ...parseMeta(org?.metadata ?? null), primaryAddress: address };
	await db
		.update(organization)
		.set({ metadata: JSON.stringify(next), updatedAt: new Date() })
		.where(eq(organization.id, actor.orgId));
	return { ok: true };
}
