// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS health probe — server-side, sub-second-ish: assume the customer role (auth), confirm the caller
// identity, then a small capability probe (representative read calls) to surface DEGRADED when
// provisioning permissions are missing. Replaces the runner's CONNECTION_TEST for AWS. A fuller
// least-privilege check (IAM SimulatePrincipalPolicy over the exact provisioning action set) can refine
// the capability step later; the read probes already catch a too-narrow role.

import {
	DescribeRegionsCommand,
	DescribeVpcsCommand,
	EC2Client,
} from "@aws-sdk/client-ec2";
import { errorName } from "@/lib/errors";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAwsRole } from "../session/aws";
import { type HealthResult, errorMessage } from "./types";

const TIMEOUT_MS = 12_000;

/** True when an AWS SDK error is an authorization denial (vs a transient/network error). */
function isAccessDenied(e: unknown): boolean {
	const name = errorName(e) ?? "";
	return /AccessDenied|UnauthorizedOperation|Forbidden/i.test(name);
}

/** Representative reads that prove the role can see the resources we provision into. */
const CAPABILITY_PROBES: { permission: string; run: (ec2: EC2Client) => Promise<unknown> }[] = [
	{ permission: "ec2:DescribeRegions", run: (ec2) => ec2.send(new DescribeRegionsCommand({})) },
	{ permission: "ec2:DescribeVpcs", run: (ec2) => ec2.send(new DescribeVpcsCommand({})) },
];

/** Probes one AWS cloud identity's health server-side. Never throws — failures map to a status. */
export async function probeAwsHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	// 1) Auth: assume the customer role. A failure here = we've lost access.
	let session: Awaited<ReturnType<typeof assumeAwsRole>>;
	try {
		session = await assumeAwsRole(identity, { purpose: "health" });
	} catch (e) {
		return {
			status: "disconnected",
			accountId: null,
			error: errorMessage(e),
			missingPermissions: [],
		};
	}

	// 2) Confirm the caller identity (cheap proof + authoritative account id).
	let accountId = session.accountId;
	try {
		const sts = new STSClient({
			region: session.region,
			credentials: session.credentials,
			requestHandler: { requestTimeout: TIMEOUT_MS },
			maxAttempts: 2,
		});
		const id = await sts.send(new GetCallerIdentityCommand({}));
		accountId = id.Account ?? accountId;
	} catch (e) {
		return {
			status: "disconnected",
			accountId,
			error: errorMessage(e),
			missingPermissions: [],
		};
	}

	// 3) Capability probe → DEGRADED when a representative read is denied.
	const ec2 = new EC2Client({
		region: session.region,
		credentials: session.credentials,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
	const missingPermissions: string[] = [];
	for (const probe of CAPABILITY_PROBES) {
		try {
			await probe.run(ec2);
		} catch (e) {
			// Only a denial counts as "missing permission"; transient/network errors are ignored so a
			// blip doesn't flap the connection to DEGRADED.
			if (isAccessDenied(e)) missingPermissions.push(probe.permission);
		}
	}

	return {
		status: missingPermissions.length > 0 ? "degraded" : "connected",
		accountId,
		error: null,
		missingPermissions,
	};
}
