// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OIDC discovery for the Alethia workload-identity issuer (see lib/oidc/issuer.ts). A customer's cloud
// (Azure federated identity, Alibaba RAM OIDC provider) fetches this at `${issuer}/.well-known/
// openid-configuration` to find the JWKS before verifying a minted assertion. Public, unauthenticated,
// GET-only; 404 when the issuer isn't configured on this instance.

import { NextResponse } from "next/server";
import { discoveryDocument, oidcIssuerConfigured } from "@/lib/oidc/issuer";

export const dynamic = "force-dynamic";

/** Serves the OIDC discovery document. */
export async function GET() {
	if (!oidcIssuerConfigured()) {
		return NextResponse.json({ error: "OIDC issuer not enabled" }, { status: 404 });
	}
	return NextResponse.json(await discoveryDocument(), {
		headers: { "Cache-Control": "public, max-age=300" },
	});
}
