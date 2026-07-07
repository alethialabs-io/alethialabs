// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces the deleted tests/lib/arn-validation.test.ts, which re-implemented the ARN regex inline
// and never imported real code. Drives the REAL parseAwsRoleArn extracted from saveAwsIdentity.

import { describe, expect, it } from "vitest";
import { parseAwsRoleArn } from "@/lib/cloud-providers/connections";

describe("parseAwsRoleArn", () => {
	it("extracts the 12-digit account id from a valid role ARN", () => {
		expect(parseAwsRoleArn("arn:aws:iam::123456789012:role/AlethiaProvisionerRole")).toEqual({
			accountId: "123456789012",
		});
		expect(parseAwsRoleArn("arn:aws:iam::787587782604:role/TestRole").accountId).toBe(
			"787587782604",
		);
	});

	it("accepts role names with the allowed special characters", () => {
		expect(
			parseAwsRoleArn("arn:aws:iam::999888777666:role/My-Role_Name.test+123").accountId,
		).toBe("999888777666");
	});

	it("rejects a non-role resource, wrong account length, or junk", () => {
		expect(() => parseAwsRoleArn("not-an-arn")).toThrow(/Invalid format/);
		expect(() => parseAwsRoleArn("")).toThrow();
		expect(() => parseAwsRoleArn("arn:aws:iam::12345:role/Short")).toThrow(); // <12 digits
		expect(() => parseAwsRoleArn("arn:aws:iam::123456789012:user/NotARole")).toThrow();
		// A CloudFormation stack ARN is not a role ARN.
		expect(() =>
			parseAwsRoleArn("arn:aws:cloudformation:us-east-1:123456789012:stack/X/abc"),
		).toThrow();
	});
});
