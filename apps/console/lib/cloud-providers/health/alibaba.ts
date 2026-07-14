// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba health probe — server-side: assume the customer RAM role (auth), then a small capability probe
// (a representative VPC read) to surface DEGRADED when the role is too narrow, matching AWS/GCP/Azure. A
// successful assume proves access (CONNECTED); an assume failure = DISCONNECTED; a permission-denied on the
// read = DEGRADED with the missing permission. Replaces the runner's CONNECTION_TEST for Alibaba.

import VpcClient, { DescribeRegionsRequest } from "@alicloud/vpc20160428";
import * as $OpenApi from "@alicloud/openapi-client";
import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAlibabaRole } from "../session/alibaba";
import { type HealthResult, errorMessage } from "./types";

/** Alibaba surfaces a permission failure as a `Forbidden*` / `NoPermission` error code or message. */
function isAccessDenied(e: unknown): boolean {
	const s = errorMessage(e).toLowerCase();
	return s.includes("forbidden") || s.includes("nopermission") || s.includes("not authorized");
}

/**
 * True when an AssumeRoleWithOIDC failure looks like the OIDC provider can no longer validate the
 * issuer's TLS certificate — i.e. the pinned CA fingerprint(s) went stale after the issuer's cert
 * rotated (alethialabs.io is behind a rotating Cloudflare edge). The keyless console can't re-push
 * fingerprints itself (it has no standing Alibaba credential), so we turn this into an actionable
 * message telling the operator to re-run the idempotent setup script.
 */
function isFingerprintFailure(e: unknown): boolean {
	const s = errorMessage(e).toLowerCase();
	return (
		s.includes("fingerprint") ||
		s.includes("idtoken") ||
		s.includes("id token") ||
		s.includes("verify") ||
		s.includes("certificate") ||
		s.includes("oidcprovider")
	);
}

/** Probes one Alibaba cloud identity's health server-side. Never throws — failures map to a status. */
export async function probeAlibabaHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	let accountId: string | null = null;
	try {
		const session = await assumeAlibabaRole(identity, { purpose: "health" });
		accountId = session.accountId;
		if (!session.credentials) {
			// Assume succeeded but no creds returned — treat as connected (assume is the proof of access).
			return { status: "connected", accountId, error: null, missingPermissions: [] };
		}

		// Capability probe: a representative read. A too-narrow role surfaces DEGRADED, not a hard failure.
		const client = new VpcClient(
			new $OpenApi.Config({
				accessKeyId: session.credentials.accessKeyId,
				accessKeySecret: session.credentials.accessKeySecret,
				securityToken: session.credentials.securityToken,
				endpoint: "vpc.cn-hangzhou.aliyuncs.com",
			}),
		);
		const missingPermissions: string[] = [];
		try {
			await client.describeRegions(new DescribeRegionsRequest({}));
		} catch (e) {
			if (isAccessDenied(e)) missingPermissions.push("vpc:DescribeRegions");
			// A non-permission error (network/transient) shouldn't flip a verified connection — ignore.
		}

		return {
			status: missingPermissions.length > 0 ? "degraded" : "connected",
			accountId,
			error: null,
			missingPermissions,
		};
	} catch (e) {
		// A stale-fingerprint failure isn't recoverable keyless — guide the operator to re-run setup.
		const error = isFingerprintFailure(e)
			? `${errorMessage(e)} — the issuer's TLS certificate may have rotated. Re-run alethia-alibaba-setup.sh in your Alibaba Cloud Shell (or re-apply the Terraform module) to refresh the OIDC provider's CA fingerprints, then Re-verify.`
			: errorMessage(e);
		return {
			status: "disconnected",
			accountId,
			error,
			missingPermissions: [],
		};
	}
}
