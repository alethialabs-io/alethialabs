// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq } from "drizzle-orm";
import { personalIdentityAuthor } from "@/lib/authz/actor-credential";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { identityScopeWhere } from "@/lib/runners/claim-identity";
import type { CloudCredentials } from "@/types/jsonb.types";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliCloudIdentitiesResponse } from "@/lib/validations/cli-contract";

/**
 * Lists the verified cloud identities the CLI caller may use: the active org's shared (`org`)
 * identities, plus — for a signed-in person — their own `personal` ones. The same rule the console's
 * identity reads apply through RLS, so a member never sees another member's personal identity and a
 * service token sees only the org's.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "cloud_identity" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		// Service connection (no RLS) — scoped explicitly by `identityScopeWhere`.
		const identities = await getServiceDb()
			.select({
				id: cloudIdentities.id,
				provider: cloudIdentities.provider,
				credentials: cloudIdentities.credentials,
				created_at: cloudIdentities.created_at,
			})
			.from(cloudIdentities)
			.where(
				and(
					identityScopeWhere(
						actor.orgId,
						personalIdentityAuthor(actor),
					),
					eq(cloudIdentities.is_verified, true),
				),
			)
			.orderBy(asc(cloudIdentities.provider));

		const result = identities.map((i) => ({
			id: i.id,
			provider: i.provider,
			label: buildLabel(i.provider, i.credentials),
			created_at: i.created_at,
		}));

		return cliJson(cliCloudIdentitiesResponse, { cloud_identities: result });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

function buildLabel(
	provider: string,
	credentials: CloudCredentials | null,
): string {
	if (!credentials) return provider.toUpperCase();

	switch (provider) {
		case "aws":
			return credentials.account_id
				? `AWS (${credentials.account_id})`
				: "AWS";
		case "gcp":
			return credentials.project_id
				? `GCP (${credentials.project_id})`
				: "GCP";
		case "azure":
			return credentials.subscription_id
				? `Azure (${credentials.subscription_id})`
				: "Azure";
		default:
			return provider.toUpperCase();
	}
}
