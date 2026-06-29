// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { ssoProvider } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliSsoProviderResponse } from "@/lib/validations/cli-contract";
import { toSsoWire } from "../route";

/** Reads a single SSO identity provider by id, scoped to the active org. Gated on
 * `view` of `org`. 404 when the provider doesn't exist in the org. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const [row] = await getServiceDb()
			.select()
			.from(ssoProvider)
			.where(
				and(eq(ssoProvider.id, id), eq(ssoProvider.organizationId, actor.orgId)),
			)
			.limit(1);
		if (!row) {
			return NextResponse.json({ error: "SSO provider not found" }, { status: 404 });
		}
		return cliJson(cliSsoProviderResponse, { sso_provider: toSsoWire(row) });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
