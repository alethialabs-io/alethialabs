// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS session — the server-side equivalent of the runner's `credentials.go`. Uses Alethia's PLATFORM
// IAM creds (ALETHIA_AWS_*) to assume the customer's cross-account role (zero customer secrets stored;
// the role + external id are metadata). The resulting short-lived session backs the health probe + the
// asset inventory sync, so a connection test no longer needs a runner. Self-managed has no equivalent —
// every connection is platform-managed (hosted = Alethia's account; OSS = the operator's).

import { STSClient } from "@aws-sdk/client-sts";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
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

/** Reads the platform AWS creds Alethia uses to assume customer roles, or throws a clear error. */
function platformCredentials() {
	const accessKeyId = process.env.ALETHIA_AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.ALETHIA_AWS_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(
			"Platform AWS credentials are not configured (ALETHIA_AWS_ACCESS_KEY_ID / ALETHIA_AWS_SECRET_ACCESS_KEY).",
		);
	}
	return { accessKeyId, secretAccessKey };
}

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
		credentials: platformCredentials(),
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
