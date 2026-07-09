// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The public JWKS for the Alethia workload-identity issuer (see lib/oidc/issuer.ts). Clouds fetch this
// (from the discovery document's jwks_uri) to verify the signature of a minted assertion. Only public
// key material is served. Public, unauthenticated, GET-only; 404 when the issuer isn't configured.

import { NextResponse } from "next/server";
import { getPublicJwks, oidcIssuerConfigured } from "@/lib/oidc/issuer";

export const dynamic = "force-dynamic";

/** Serves the public JWKS. */
export async function GET() {
	if (!oidcIssuerConfigured()) {
		return NextResponse.json({ error: "OIDC issuer not enabled" }, { status: 404 });
	}
	return NextResponse.json(await getPublicJwks(), {
		headers: { "Cache-Control": "public, max-age=300" },
	});
}
