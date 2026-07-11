// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// externalAccountClientFromWif is direct-OIDC only: a DIRECT-OIDC config builds an IdentityPoolClient
// whose subject-token supplier mints a fresh Alethia assertion (no AWS hop). A retired AWS-hub config
// (aws4_request) is no longer supported → the function returns null so the caller reports "reconnect".

import { beforeEach, describe, expect, it, vi } from "vitest";

const { identityPoolCtor, mintFn } = vi.hoisted(() => ({
	identityPoolCtor: vi.fn(),
	mintFn: vi.fn(async () => "minted.jwt"),
}));

vi.mock("google-auth-library", () => ({
	IdentityPoolClient: class {
		constructor(opts: unknown) {
			identityPoolCtor(opts);
		}
	},
}));
vi.mock("@/lib/oidc/issuer", () => ({ mintWorkloadToken: mintFn }));

import {
	externalAccountClientFromWif,
	GCP_TOKEN_AUDIENCE,
} from "@/lib/cloud-providers/session/gcp";
import type { WifCredentialConfig } from "@/types/jsonb.types";

const oidcWif: WifCredentialConfig = {
	type: "external_account",
	audience:
		"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-oidc-provider",
	subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
	service_account_impersonation_url:
		"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/alethia-provisioner@p.iam.gserviceaccount.com:generateAccessToken",
	credential_source: { file: "/var/run/alethia/gcp-oidc-token", format: { type: "text" } },
};

const legacyWif: WifCredentialConfig = {
	type: "external_account",
	audience:
		"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-aws-provider",
	subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
	credential_source: { environment_id: "aws1", region_url: "http://169.254.169.254/…" },
};

beforeEach(() => {
	identityPoolCtor.mockReset();
	mintFn.mockClear();
});

describe("externalAccountClientFromWif", () => {
	it("builds an IdentityPoolClient with a minting supplier for a direct-OIDC config", async () => {
		externalAccountClientFromWif(oidcWif);
		expect(identityPoolCtor).toHaveBeenCalledOnce();

		const opts = identityPoolCtor.mock.calls[0][0] as {
			audience: string;
			subject_token_type: string;
			service_account_impersonation_url?: string;
			subject_token_supplier: { getSubjectToken: (c: unknown) => Promise<string> };
		};
		expect(opts.audience).toBe(oidcWif.audience);
		expect(opts.subject_token_type).toBe("urn:ietf:params:oauth:token-type:jwt");
		expect(opts.service_account_impersonation_url).toBe(oidcWif.service_account_impersonation_url);

		// The supplier mints a fresh Alethia assertion scoped to the fixed GCP audience.
		const tok = await opts.subject_token_supplier.getSubjectToken({});
		expect(tok).toBe("minted.jwt");
		expect(mintFn).toHaveBeenCalledWith({ audience: GCP_TOKEN_AUDIENCE });
	});

	it("returns null for a retired legacy AWS-hub config (no client built)", () => {
		expect(externalAccountClientFromWif(legacyWif)).toBeNull();
		expect(identityPoolCtor).not.toHaveBeenCalled();
		expect(mintFn).not.toHaveBeenCalled();
	});
});
