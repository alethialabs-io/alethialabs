// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba keyless auth: the console assumes the customer RAM role via STS AssumeRoleWithOIDC with an
// assertion minted by the Alethia issuer — no Alibaba account, no AccessKey, no request signature.
// These tests pin that contract: the outgoing request is a bare AssumeRoleWithOIDC carrying a minted
// OIDCToken + the provider/role ARNs, and it fails closed when the issuer/ARNs aren't present.

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIssuerCache } from "@/lib/oidc/issuer";
import {
	assumeAlibabaRole,
	deriveOidcProviderArn,
} from "@/lib/cloud-providers/session/alibaba";

const saved: Record<string, string | undefined> = {};

function installKey() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
	process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
	__resetIssuerCache();
}

const identity = {
	credentials: {
		role_arn: "acs:ram::1234567890123456:role/AlethiaProvisioner",
		oidc_provider_arn: "acs:ram::1234567890123456:oidc-provider/alethia",
	},
};

beforeEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL"]) saved[k] = process.env[k];
	installKey();
});
afterEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL"]) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	__resetIssuerCache();
	vi.restoreAllMocks();
});

describe("assumeAlibabaRole (AssumeRoleWithOIDC)", () => {
	it("posts a bare AssumeRoleWithOIDC with a minted token and returns the account id + STS creds", async () => {
		let sentBody = "";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			sentBody = String((init as RequestInit).body);
			return new Response(
				JSON.stringify({
					Credentials: {
						AccessKeyId: "sts-ak",
						AccessKeySecret: "sts-secret",
						SecurityToken: "sts-token",
						Expiration: "2099-01-01T00:00:00Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const session = await assumeAlibabaRole(identity, { purpose: "health" });
		expect(session.accountId).toBe("1234567890123456");
		// The temporary STS creds are surfaced (used by inventory/regional API calls).
		expect(session.credentials).toEqual({
			accessKeyId: "sts-ak",
			accessKeySecret: "sts-secret",
			securityToken: "sts-token",
			expiration: "2099-01-01T00:00:00Z",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const params = new URLSearchParams(sentBody);
		expect(params.get("Action")).toBe("AssumeRoleWithOIDC");
		expect(params.get("RoleArn")).toBe(identity.credentials.role_arn);
		expect(params.get("OIDCProviderArn")).toBe(identity.credentials.oidc_provider_arn);
		expect(params.get("OIDCToken")).toBeTruthy();
		// Anonymous call — no AccessKey / signature, and none of the signature common-params either:
		// sending SignatureNonce/Timestamp on an UNSIGNED request makes the RPC gateway expect a
		// signature and reject the call.
		expect(params.get("AccessKeyId")).toBeNull();
		expect(params.get("Signature")).toBeNull();
		expect(params.get("SignatureNonce")).toBeNull();
		expect(params.get("SignatureMethod")).toBeNull();
		expect(params.get("Timestamp")).toBeNull();
		// Exactly the action-specific param set (plus Version/Format) — nothing signature-adjacent.
		expect([...params.keys()].sort()).toEqual(
			[
				"Action",
				"DurationSeconds",
				"Format",
				"OIDCProviderArn",
				"OIDCToken",
				"RoleArn",
				"RoleSessionName",
				"Version",
			].sort(),
		);
	});

	it("throws when the issuer is not configured", async () => {
		delete process.env.ALETHIA_OIDC_SIGNING_KEY;
		__resetIssuerCache();
		await expect(assumeAlibabaRole(identity)).rejects.toThrow(/issuer is not configured/i);
	});

	it("throws without a role ARN", async () => {
		await expect(
			assumeAlibabaRole({ credentials: { oidc_provider_arn: identity.credentials.oidc_provider_arn } }),
		).rejects.toThrow(/no role ARN/i);
	});

	it("throws without an OIDC provider ARN", async () => {
		await expect(
			assumeAlibabaRole({ credentials: { role_arn: identity.credentials.role_arn } }),
		).rejects.toThrow(/no OIDC provider ARN/i);
	});

	it("maps an STS error to a throw (DISCONNECTED)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ Code: "InvalidParameter.OIDCToken", Message: "bad token" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await expect(assumeAlibabaRole(identity)).rejects.toThrow(/bad token/i);
	});
});

describe("deriveOidcProviderArn", () => {
	it("derives the provider ARN from the role ARN's account id + fixed name", () => {
		expect(deriveOidcProviderArn("acs:ram::1234567890123456:role/AlethiaProvisioner")).toBe(
			"acs:ram::1234567890123456:oidc-provider/alethia",
		);
	});

	it("returns null when the account id can't be parsed", () => {
		expect(deriveOidcProviderArn("not-an-arn")).toBeNull();
		expect(deriveOidcProviderArn(null)).toBeNull();
	});
});
