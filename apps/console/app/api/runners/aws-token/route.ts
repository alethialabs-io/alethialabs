// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal runner endpoint: mint a short-lived OIDC assertion for keyless AWS provisioning. A managed
// runner executing a `tofu apply` against AWS has NO ambient AWS identity (the Hetzner fleet injects no
// keys). It calls this route with its runner credentials and gets a freshly-minted assertion (audience
// sts.amazonaws.com, subject alethia-connector) plus the platform role ARN. The runner exchanges the
// assertion for the platform identity via AssumeRoleWithWebIdentity (a web-identity token file the AWS SDK
// re-reads + auto-refreshes), then assumes the customer's provisioner role FROM it. No access key ever
// reaches the runner. The console is the only holder of the issuer signing key.

import { AWS_TOKEN_AUDIENCE, awsPlatformConfigured } from "@/lib/cloud-providers/session/aws-platform";
import { mintWorkloadToken } from "@/lib/oidc/issuer";
import { verifyRunnerToken } from "@/lib/runners/auth";
import { NextResponse } from "next/server";

/** Mints an AWS web-identity assertion (+ the platform role ARN) for an authenticated runner. */
export async function POST(req: Request) {
	const { error: authError } = await verifyRunnerToken(req);
	if (authError) return authError;

	// Needs both the issuer key AND the platform role ARN — awsPlatformConfigured() checks both.
	if (!awsPlatformConfigured()) {
		return NextResponse.json(
			{ error: "AWS platform identity is not configured (ALETHIA_AWS_PLATFORM_ROLE_ARN + issuer)." },
			{ status: 501 },
		);
	}

	try {
		const token = await mintWorkloadToken({ audience: AWS_TOKEN_AUDIENCE });
		return NextResponse.json({
			token,
			// The platform role the runner assumes via web identity, then chains the customer role off.
			platform_role_arn: process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN,
			// STS is global, but the SDK wants a region; fall back to us-east-1.
			region: process.env.AWS_REGION || "us-east-1",
		});
	} catch (err) {
		console.error("AWS token mint error:", err);
		return NextResponse.json({ error: "Failed to mint AWS token" }, { status: 500 });
	}
}
