"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the active org's General-settings fields. Name + slug live on the organization
// row; the rest (description, data region, default Project env, Terraform version) live in
// the org `metadata` JSON. Writes go through better-auth `organization.update` from the
// client (it owns the org row + hooks).

import { eq } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
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
export interface OrgPrimaryAddress {
	name: string;
	line1: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country: string;
}

interface OrgMeta {
	region?: string;
	description?: string;
	defaultEnv?: string;
	terraformVersion?: string;
	primaryAddress?: OrgPrimaryAddress;
}

/** Tolerant parse of the org metadata JSON blob. */
function parseMeta(metadata: string | null): OrgMeta {
	if (!metadata) return {};
	try {
		const m: unknown = JSON.parse(metadata);
		return m && typeof m === "object" ? (m as OrgMeta) : {};
	} catch {
		return {};
	}
}

/** Current General-settings values, or null in the personal scope (no real org). */
export async function getOrgSettings(): Promise<OrgSettings | null> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return null;

	const [org] = await getServiceDb()
		.select({
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			metadata: organization.metadata,
		})
		.from(organization)
		.where(eq(organization.id, actor.orgId))
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

/**
 * Stores the active org's primary address in its metadata JSON — set from the checkout
 * form when "Use the billing address as my team's primary address" is checked. Scoped to
 * the resolved active org (never client-supplied), merged into the existing metadata.
 */
export async function updateOrgPrimaryAddress(
	address: OrgPrimaryAddress,
): Promise<{ ok: true }> {
	const actor = await currentActor();
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
