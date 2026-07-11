// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GCP has two WIF federation shapes: the new DIRECT-OIDC config (a minted Alethia JWT, no AWS hop) and
// the legacy AWS-hub config (aws4_request signed with platform AWS creds). isOidcWif selects the path so
// both keep working through the migration.

import { describe, expect, it } from "vitest";
import { isOidcWif, GCP_TOKEN_AUDIENCE } from "@/lib/cloud-providers/session/gcp";
import type { WifCredentialConfig } from "@/types/jsonb.types";

const oidc: WifCredentialConfig = {
	type: "external_account",
	audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-oidc-provider",
	subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
	credential_source: { file: "/var/run/alethia/gcp-oidc-token", format: { type: "text" } },
};

const legacyAws: WifCredentialConfig = {
	type: "external_account",
	audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-aws-provider",
	subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
	credential_source: { environment_id: "aws1", region_url: "http://169.254.169.254/…" },
};

describe("isOidcWif", () => {
	it("is true for a direct-OIDC (jwt) config", () => {
		expect(isOidcWif(oidc)).toBe(true);
	});
	it("is false for the legacy AWS-hub (aws4_request) config", () => {
		expect(isOidcWif(legacyAws)).toBe(false);
	});
	it("is false for null / missing subject_token_type", () => {
		expect(isOidcWif(null)).toBe(false);
		expect(isOidcWif({})).toBe(false);
	});
	it("pins a fixed audience constant (must match the setup script)", () => {
		expect(GCP_TOKEN_AUDIENCE).toBe("alethia-gcp-wif");
	});
});
