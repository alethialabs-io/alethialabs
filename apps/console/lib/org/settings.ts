// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An organization's General-settings values, read by org id. Name + slug live on the organization
// row; the rest (description, data region, default Project env, Terraform version, the billing-
// derived primary address) live in the org `metadata` JSON.
//
// This lives in lib/, NOT in app/server/actions/org-settings.ts: orgSettingsForOrg takes an org id
// and reads through the service client with no session, and inside a `"use server"` file every
// export is a public POST-addressable Server Action — so it answered ANY org's settings, primary
// address included, to anyone who could name the id (#5219). Both callers resolve the org first:
// getOrgSettings (web, currentActor) and GET /api/cli/org-settings (authorizeCli).
//
// Do not add `"use server"` here.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";

export interface OrgSettings {
	name: string;
	slug: string;
	logo: string | null;
	description: string;
	/** Billing-derived primary address (set from checkout); null when unset. */
	primaryAddress: OrgPrimaryAddress | null;
	region: string;
	defaultEnv: string;
	terraformVersion: string;
}

/** The org's primary (billing-derived) address, stored in the org metadata JSON. */
const orgPrimaryAddressSchema = z.object({
	name: z.string(),
	line1: z.string(),
	line2: z.string().optional(),
	city: z.string().optional(),
	state: z.string().optional(),
	postalCode: z.string().optional(),
	country: z.string(),
});
export type OrgPrimaryAddress = z.infer<typeof orgPrimaryAddressSchema>;

/** The org metadata JSON blob. Every field is tolerant: a malformed value degrades to `undefined`
 *  (never throws, never lies), and a non-object blob to `{}` — parseMeta trusts nothing. */
const orgMetaSchema = z
	.object({
		region: z.string().optional().catch(undefined),
		description: z.string().optional().catch(undefined),
		defaultEnv: z.string().optional().catch(undefined),
		terraformVersion: z.string().optional().catch(undefined),
		primaryAddress: orgPrimaryAddressSchema.optional().catch(undefined),
	})
	.catch({});
export type OrgMeta = z.infer<typeof orgMetaSchema>;

/** Tolerant parse of the org metadata JSON blob. */
export function parseMeta(metadata: string | null): OrgMeta {
	if (!metadata) return {};
	try {
		return orgMetaSchema.parse(JSON.parse(metadata));
	} catch {
		return {};
	}
}

/**
 * The General-settings values for a given org id (no session lookup) — the shared read behind
 * both getOrgSettings (web, session-scoped) and the CLI org-settings route (token-scoped). Returns
 * null when the org row is missing. Callers are responsible for the community-mode short-circuit.
 */
export async function orgSettingsForOrg(orgId: string): Promise<OrgSettings | null> {
	const [org] = await getServiceDb()
		.select({
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	if (!org) return null;

	const m = parseMeta(org.metadata);
	return {
		name: org.name,
		slug: org.slug ?? "",
		logo: org.logo,
		description: m.description ?? "",
		primaryAddress: m.primaryAddress ?? null,
		region: m.region ?? "eu-west-1",
		defaultEnv: m.defaultEnv ?? "staging",
		terraformVersion: m.terraformVersion ?? "1.9.5",
	};
}
