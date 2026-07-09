// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS session — the server-side equivalent of the runner's `credentials.go`. The console assumes the
// customer's cross-account role (zero customer secrets stored; the role + external id are metadata). The
// platform identity it assumes FROM is KEYLESS — federated into the platform AWS account via the OIDC
// issuer (session/aws-platform.ts), not a static key. The resulting short-lived session backs the health
// probe + the asset inventory sync, so a connection test no longer needs a runner. Every connection is
// platform-managed (hosted = Alethia's account; OSS = the operator's).

import { STSClient } from "@aws-sdk/client-sts";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { platformCredentialProvider } from "@/lib/cloud-providers/session/aws-platform";
import type { CloudIdentity } from "@/lib/db/schema";

/** Short-lived AWS credentials + the region they were minted for. */
export interface AwsSession {
	credentials: {
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken: string;
	};
	/** The account id we authenticated into (proof of access; from the role ARN). */
	accountId: string | null;
	region: string;
}

/** Per-call network timeout so a hung cloud API never ties up a console worker. */
const TIMEOUT_MS = 12_000;

/** The default region for control-plane calls (STS/regions enumeration is global-ish). */
export const DEFAULT_AWS_REGION = "us-east-1";

/** Extracts the 12-digit account id from a role ARN (arn:aws:iam::<account>:role/...). */
function accountIdFromArn(roleArn: string | null | undefined): string | null {
	if (!roleArn) return null;
	const m = roleArn.match(/^arn:aws[^:]*:iam::(\d{12}):/);
	return m?.[1] ?? null;
}

/**
 * Assumes the customer's cross-account role for one cloud identity and returns a short-lived session.
 * Throws on missing platform creds, a missing role ARN, or an AssumeRole failure (revoked trust /
 * wrong external id) — the caller maps that to DISCONNECTED.
 */
export async function assumeAwsRole(
	identity: Pick<CloudIdentity, "credentials">,
	opts?: { region?: string; purpose?: string },
): Promise<AwsSession> {
	const region = opts?.region ?? DEFAULT_AWS_REGION;
	const roleArn = identity.credentials.role_arn ?? null;
	if (!roleArn) throw new Error("This AWS connection has no role ARN.");

	const sts = new STSClient({
		region,
		credentials: platformCredentialProvider(),
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
	const res = await sts.send(
		new AssumeRoleCommand({
			RoleArn: roleArn,
			ExternalId: identity.credentials.external_id ?? undefined,
			RoleSessionName: `alethia-${(opts?.purpose ?? "probe").slice(0, 24)}`,
			DurationSeconds: 3600,
		}),
	);
	const c = res.Credentials;
	if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
		throw new Error("AssumeRole returned no credentials.");
	}
	return {
		credentials: {
			accessKeyId: c.AccessKeyId,
			secretAccessKey: c.SecretAccessKey,
			sessionToken: c.SessionToken,
		},
		accountId: accountIdFromArn(roleArn),
		region,
	};
}
