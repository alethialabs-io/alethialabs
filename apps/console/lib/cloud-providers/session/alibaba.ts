// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba session — KEYLESS and ACCOUNT-FREE. Alethia holds NO Alibaba account: instead of a platform
// RAM user's AccessKey, the console calls STS `AssumeRoleWithOIDC` with an assertion minted by the
// Alethia OIDC issuer (lib/oidc/issuer.ts). The customer registers a RAM OIDC IdP that trusts the
// issuer + a RAM role; both the provider ARN and role ARN are metadata on the identity (zero secrets
// stored). `AssumeRoleWithOIDC` is an anonymous STS action — authenticated by the OIDC token itself,
// so there is no AccessKey and no request signature. A successful assume is the proof of access.

import { randomUUID } from "node:crypto";
import { mintWorkloadToken, oidcIssuerConfigured } from "@/lib/oidc/issuer";
import type { CloudIdentity } from "@/lib/db/schema";

const STS_ENDPOINT = "https://sts.aliyuncs.com/";
const TIMEOUT_MS = 12_000;

/**
 * The audience the minted assertion carries. It must match a client-id (`aud`) configured on the
 * customer's RAM OIDC provider — the customer setup (Phase 3 Bit E) pins the provider to this value.
 */
export const ALIBABA_TOKEN_AUDIENCE = "sts.aliyuncs.com";

/**
 * The fixed name of the RAM OIDC provider the customer setup (`infra/connector/alibaba`) creates.
 * Because it's fixed, the console derives the provider ARN from the role ARN's account id instead of
 * asking the customer to paste it — so the connect form stays a single field. The IaC MUST use this
 * exact name (`oidc_provider_name = "alethia"`) or the derived ARN won't resolve.
 */
export const ALIBABA_OIDC_PROVIDER_NAME = "alethia";

/** Result of assuming the customer RAM role. */
export interface AlibabaSession {
	/** The account id we authenticated into (from the role ARN). */
	accountId: string | null;
}

/** acs:ram::<account>:role/Name → <account>. */
export function accountIdFromArn(roleArn: string | null | undefined): string | null {
	if (!roleArn) return null;
	const m = roleArn.match(/^acs:ram::(\d+):role\//);
	return m?.[1] ?? null;
}

/**
 * Derives the RAM OIDC provider ARN from a role ARN's account id + the fixed provider name — so the
 * connect flow only needs the role ARN. Returns null if the account id can't be parsed.
 */
export function deriveOidcProviderArn(roleArn: string | null | undefined): string | null {
	const accountId = accountIdFromArn(roleArn);
	return accountId ? `acs:ram::${accountId}:oidc-provider/${ALIBABA_OIDC_PROVIDER_NAME}` : null;
}

/**
 * Assumes the customer's RAM role for one Alibaba cloud identity via `AssumeRoleWithOIDC`. Throws when
 * the issuer isn't configured, the role/provider ARN is missing, or STS rejects the token (revoked
 * trust / wrong policy) — the caller maps that to DISCONNECTED. On success the assume itself is the
 * proof of access; we return the account id.
 */
export async function assumeAlibabaRole(
	identity: Pick<CloudIdentity, "credentials">,
	opts?: { purpose?: string },
): Promise<AlibabaSession> {
	if (!oidcIssuerConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}
	const roleArn = identity.credentials.role_arn ?? null;
	if (!roleArn) throw new Error("This Alibaba connection has no role ARN.");
	const oidcProviderArn = identity.credentials.oidc_provider_arn ?? null;
	if (!oidcProviderArn) {
		throw new Error("This Alibaba connection has no OIDC provider ARN.");
	}

	const oidcToken = await mintWorkloadToken({ audience: ALIBABA_TOKEN_AUDIENCE });

	// AssumeRoleWithOIDC is anonymous — the OIDC token authenticates the call, so there is no
	// AccessKeyId / SignatureMethod / Signature. Params go in a form-encoded POST body.
	const params: Record<string, string> = {
		Action: "AssumeRoleWithOIDC",
		OIDCProviderArn: oidcProviderArn,
		RoleArn: roleArn,
		OIDCToken: oidcToken,
		RoleSessionName: `alethia-${(opts?.purpose ?? "probe").slice(0, 24)}`,
		DurationSeconds: "3600",
		Version: "2015-04-01",
		Format: "JSON",
		SignatureNonce: randomUUID(),
		Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	};
	const body = new URLSearchParams(params).toString();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(STS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: controller.signal,
		});
		const resBody = (await res.json().catch(() => ({}))) as {
			Code?: string;
			Message?: string;
			Credentials?: { AccessKeyId?: string };
		};
		if (!res.ok || resBody.Code) {
			throw new Error(resBody.Message || resBody.Code || `Alibaba STS HTTP ${res.status}`);
		}
		if (!resBody.Credentials?.AccessKeyId) {
			throw new Error("Alibaba AssumeRoleWithOIDC returned no credentials.");
		}
		return { accountId: accountIdFromArn(roleArn) };
	} finally {
		clearTimeout(timer);
	}
}
