// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Platform AWS identity — KEYLESS. The control plane runs off-AWS (a Hetzner box), so instead of a
// long-lived IAM access key it federates INTO the platform AWS account via STS AssumeRoleWithWebIdentity,
// presenting a short-lived assertion minted by Alethia's own OIDC issuer (lib/oidc/issuer.ts) — the same
// issuer Azure + Alibaba use. The result is temporary creds that back BOTH:
//   • the customer AssumeRole in session/aws.ts (AWS connectors), and
//   • the GCP Workload-Identity subject token — google-auth's `--aws` source reads AWS_* from the
//     environment, so ensurePlatformAwsEnv() writes/refreshes those vars (incl. the session token).
// No secret is stored anywhere; the only long-lived material is the auto-managed issuer signing key.

import {
	AssumeRoleWithWebIdentityCommand,
	STSClient,
} from "@aws-sdk/client-sts";
import { mintWorkloadToken, oidcIssuerConfigured } from "@/lib/oidc/issuer";

/** Temporary platform-AWS credentials (shape is assignable to the AWS SDK's credential provider). */
export interface PlatformAwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
	expiration: Date;
}

/** The audience AWS's IAM OIDC provider trusts for the web-identity token exchange (GitHub-Actions convention). */
export const AWS_TOKEN_AUDIENCE = "sts.amazonaws.com";

/** Region for the (global-ish) STS web-identity exchange. */
const STS_REGION = "us-east-1";
const TIMEOUT_MS = 12_000;
/** Refresh this long before actual expiry so a call never races the boundary. */
const EXPIRY_SKEW_MS = 5 * 60_000;

/** Whether this instance can federate as the platform AWS identity (issuer configured + role ARN set). */
export function awsPlatformConfigured(): boolean {
	return oidcIssuerConfigured() && !!process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
}

let cached: PlatformAwsCredentials | null = null;

/**
 * Returns temporary platform-AWS credentials, minting fresh ones via AssumeRoleWithWebIdentity when the
 * cache is empty or near expiry. Throws a clear error if the issuer / platform role ARN isn't configured.
 */
export async function getPlatformAwsCredentials(): Promise<PlatformAwsCredentials> {
	if (cached && cached.expiration.getTime() - Date.now() > EXPIRY_SKEW_MS) {
		return cached;
	}
	const roleArn = process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
	if (!roleArn) {
		throw new Error("Platform AWS role is not configured (ALETHIA_AWS_PLATFORM_ROLE_ARN).");
	}
	if (!oidcIssuerConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}

	const token = await mintWorkloadToken({ audience: AWS_TOKEN_AUDIENCE });
	// AssumeRoleWithWebIdentity is an unauthenticated STS action — the web-identity token authenticates
	// it, so the client needs no credentials.
	const sts = new STSClient({
		region: STS_REGION,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
	const res = await sts.send(
		new AssumeRoleWithWebIdentityCommand({
			RoleArn: roleArn,
			WebIdentityToken: token,
			RoleSessionName: "alethia-platform",
			DurationSeconds: 3600,
		}),
	);
	const c = res.Credentials;
	if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
		throw new Error("AssumeRoleWithWebIdentity returned no credentials.");
	}
	cached = {
		accessKeyId: c.AccessKeyId,
		secretAccessKey: c.SecretAccessKey,
		sessionToken: c.SessionToken,
		expiration: c.Expiration,
	};
	return cached;
}

/**
 * An AWS SDK credential provider backed by the keyless platform identity — pass as `credentials` to an
 * STSClient. The SDK re-invokes it as the temporary creds approach expiry.
 */
export function platformCredentialProvider(): () => Promise<PlatformAwsCredentials> {
	return async () => getPlatformAwsCredentials();
}

/**
 * Ensures `process.env.AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN` (+ AWS_REGION) hold fresh
 * platform creds — this is what google-auth-library's AWS subject-token source reads to federate GCP.
 * Call before minting a GCP WIF token. No-op-safe to call repeatedly (creds are cached).
 */
export async function ensurePlatformAwsEnv(): Promise<void> {
	const c = await getPlatformAwsCredentials();
	process.env.AWS_ACCESS_KEY_ID = c.accessKeyId;
	process.env.AWS_SECRET_ACCESS_KEY = c.secretAccessKey;
	if (c.sessionToken) process.env.AWS_SESSION_TOKEN = c.sessionToken;
	process.env.AWS_REGION ??= STS_REGION;
}

/** Test seam: clear the cached credentials. */
export function __resetPlatformAwsCache(): void {
	cached = null;
}
