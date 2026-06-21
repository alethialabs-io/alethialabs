"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the active org's General-settings fields. Name + slug live on the organization
// row; the rest (description, data region, default Spec env, Terraform version) live in
// the org `metadata` JSON. Writes go through better-auth `organization.update` from the
// client (it owns the org row + hooks).

import { eq } from "drizzle-orm";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";

export interface OrgSettings {
	name: string;
	slug: string;
	description: string;
	region: string;
	defaultEnv: string;
	terraformVersion: string;
}

interface OrgMeta {
	region?: string;
	description?: string;
	defaultEnv?: string;
	terraformVersion?: string;
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
		description: m.description ?? "",
		region: m.region ?? "eu-west-1",
		defaultEnv: m.defaultEnv ?? "staging",
		terraformVersion: m.terraformVersion ?? "1.9.5",
	};
}
