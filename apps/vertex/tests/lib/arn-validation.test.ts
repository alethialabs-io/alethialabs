import { describe, expect, it } from "vitest";

const arnRegex = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]+$/;

function validateRoleArn(
	arn: string,
): { valid: true; accountId: string } | { valid: false; error: string } {
	if (arn.startsWith("arn:aws:cloudformation:")) {
		return {
			valid: false,
			error: "CloudFormation Stack ARN pasted. Copy the RoleArn from the Outputs tab.",
		};
	}

	const match = arn.match(arnRegex);
	if (!match) {
		return {
			valid: false,
			error: "Invalid IAM Role ARN format. Example: arn:aws:iam::123456789012:role/GrapeProvisionerRole",
		};
	}

	return { valid: true, accountId: match[1] };
}

describe("ARN validation", () => {
	it("accepts valid IAM role ARN", () => {
		const result = validateRoleArn(
			"arn:aws:iam::123456789012:role/GrapeProvisionerRole",
		);
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.accountId).toBe("123456789012");
	});

	it("accepts ARN with special characters", () => {
		const result = validateRoleArn(
			"arn:aws:iam::999888777666:role/My-Role_Name.test+123",
		);
		expect(result.valid).toBe(true);
	});

	it("rejects CloudFormation ARN with helpful message", () => {
		const result = validateRoleArn(
			"arn:aws:cloudformation:us-east-1:123456789012:stack/GrapeConnect/abc",
		);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toContain("CloudFormation");
	});

	it("rejects invalid format", () => {
		expect(validateRoleArn("not-an-arn").valid).toBe(false);
		expect(validateRoleArn("arn:aws:iam::12345:role/Short").valid).toBe(
			false,
		);
		expect(validateRoleArn("arn:aws:iam::123456789012:user/NotARole").valid).toBe(
			false,
		);
	});

	it("rejects empty string", () => {
		expect(validateRoleArn("").valid).toBe(false);
	});

	it("extracts 12-digit account ID", () => {
		const result = validateRoleArn(
			"arn:aws:iam::787587782604:role/TestRole",
		);
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.accountId).toBe("787587782604");
	});
});
