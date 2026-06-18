// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	parseWifConfig,
	saveAwsIdentity,
	saveAzureIdentity,
} from "@/lib/cloud-providers/connections";

const validWif = {
	type: "external_account",
	audience:
		"//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/alethia-pool/providers/alethia-aws-provider",
	service_account_impersonation_url:
		"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/alethia-provisioner@my-project.iam.gserviceaccount.com:generateAccessToken",
	credential_source: { environment_id: "aws1" },
};

describe("parseWifConfig", () => {
	it("extracts project number, service account email, and project id", () => {
		const result = parseWifConfig(JSON.stringify(validWif));
		expect(result.projectNumber).toBe("123456789");
		expect(result.serviceAccountEmail).toBe(
			"alethia-provisioner@my-project.iam.gserviceaccount.com",
		);
		expect(result.projectId).toBe("my-project");
	});

	it("rejects invalid JSON", () => {
		expect(() => parseWifConfig("{ not json")).toThrow("Invalid JSON format");
	});

	it("rejects a non external_account credential type", () => {
		const cfg = { ...validWif, type: "service_account" };
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Invalid credential type",
		);
	});

	it("rejects a missing or non-WIF audience", () => {
		const cfg = { ...validWif, audience: "//iam.googleapis.com/projects/1/" };
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Missing or invalid audience field",
		);
	});

	it("rejects a missing service_account_impersonation_url", () => {
		const { service_account_impersonation_url, ...cfg } = validWif;
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Missing service_account_impersonation_url",
		);
	});

	it("rejects a missing credential_source", () => {
		const { credential_source, ...cfg } = validWif;
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Missing credential_source",
		);
	});

	it("rejects an audience without a project number", () => {
		const cfg = {
			...validWif,
			audience:
				"//iam.googleapis.com/workloadIdentityPools/alethia-pool/providers/x",
		};
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Could not extract project number",
		);
	});

	it("rejects an impersonation url without a service account", () => {
		const cfg = {
			...validWif,
			service_account_impersonation_url: "https://example.com/no-sa-here",
		};
		expect(() => parseWifConfig(JSON.stringify(cfg))).toThrow(
			"Could not extract service account email",
		);
	});
});

describe("saveAwsIdentity validation", () => {
	it("rejects a malformed role ARN before any DB access", async () => {
		await expect(
			saveAwsIdentity("user-1", "identity-1", "not-an-arn"),
		).rejects.toThrow("Invalid format");
	});
});

describe("saveAzureIdentity validation", () => {
	it("rejects a malformed tenant id before any DB access", async () => {
		await expect(
			saveAzureIdentity(
				"user-1",
				"identity-1",
				"not-a-guid",
				"22222222-2222-2222-2222-222222222222",
				"33333333-3333-3333-3333-333333333333",
			),
		).rejects.toThrow("Invalid Tenant ID format");
	});

	it("rejects a malformed subscription id before any DB access", async () => {
		await expect(
			saveAzureIdentity(
				"user-1",
				"identity-1",
				"11111111-1111-1111-1111-111111111111",
				"22222222-2222-2222-2222-222222222222",
				"bad-subscription",
			),
		).rejects.toThrow("Invalid Subscription ID format");
	});
});
