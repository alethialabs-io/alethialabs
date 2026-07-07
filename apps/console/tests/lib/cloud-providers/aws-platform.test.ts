// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Keyless platform AWS: the console federates into the platform AWS account via STS
// AssumeRoleWithWebIdentity with a minted assertion — no static key. These tests pin the contract:
// mint → assume → cache/refresh, and (critically for GCP) that ensurePlatformAwsEnv writes ALL THREE
// AWS_* env names incl. the session token that a static key never carried.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, mintMock, state } = vi.hoisted(() => ({
	sendMock: vi.fn(),
	mintMock: vi.fn(async () => "fake.web.identity.token"),
	state: { issuerConfigured: true },
}));

vi.mock("@aws-sdk/client-sts", () => ({
	STSClient: vi.fn(() => ({ send: sendMock })),
	AssumeRoleWithWebIdentityCommand: vi.fn((input) => ({ input })),
}));
vi.mock("@/lib/oidc/issuer", () => ({
	mintWorkloadToken: mintMock,
	oidcIssuerConfigured: () => state.issuerConfigured,
}));

import {
	__resetPlatformAwsCache,
	awsPlatformConfigured,
	ensurePlatformAwsEnv,
	getPlatformAwsCredentials,
} from "@/lib/cloud-providers/session/aws-platform";

const ROLE_ARN = "arn:aws:iam::270587882865:role/alethia-connector-assumer";

/** An STS response whose temp creds expire `ms` from now. */
const stsResponse = (ms: number) => ({
	Credentials: {
		AccessKeyId: "AKIA_TMP",
		SecretAccessKey: "tmp-secret",
		SessionToken: "tmp-session-token",
		Expiration: new Date(Date.now() + ms),
	},
});

beforeEach(() => {
	process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = ROLE_ARN;
	state.issuerConfigured = true;
	sendMock.mockReset();
	mintMock.mockClear();
	__resetPlatformAwsCache();
	for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) delete process.env[k];
});
afterEach(() => {
	delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
});

describe("aws-platform (keyless AssumeRoleWithWebIdentity)", () => {
	it("mints an assertion, assumes the role, and caches the result", async () => {
		sendMock.mockResolvedValue(stsResponse(3_600_000));
		const c = await getPlatformAwsCredentials();
		expect(mintMock).toHaveBeenCalledOnce();
		expect(c.accessKeyId).toBe("AKIA_TMP");
		expect(c.sessionToken).toBe("tmp-session-token");
		// A second call inside the expiry window is served from cache — no new mint.
		await getPlatformAwsCredentials();
		expect(mintMock).toHaveBeenCalledOnce();
	});

	it("refreshes when the cached creds are within the expiry skew", async () => {
		sendMock.mockResolvedValue(stsResponse(60_000)); // 1 min < 5 min skew → always stale
		await getPlatformAwsCredentials();
		await getPlatformAwsCredentials();
		expect(mintMock).toHaveBeenCalledTimes(2);
	});

	it("ensurePlatformAwsEnv writes all three AWS_* names incl. the session token", async () => {
		sendMock.mockResolvedValue(stsResponse(3_600_000));
		await ensurePlatformAwsEnv();
		expect(process.env.AWS_ACCESS_KEY_ID).toBe("AKIA_TMP");
		expect(process.env.AWS_SECRET_ACCESS_KEY).toBe("tmp-secret");
		expect(process.env.AWS_SESSION_TOKEN).toBe("tmp-session-token");
	});

	it("awsPlatformConfigured tracks the issuer + role ARN", () => {
		expect(awsPlatformConfigured()).toBe(true);
		delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
		expect(awsPlatformConfigured()).toBe(false);
		process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = ROLE_ARN;
		state.issuerConfigured = false;
		expect(awsPlatformConfigured()).toBe(false);
	});

	it("throws a clear error without the role ARN", async () => {
		delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
		await expect(getPlatformAwsCredentials()).rejects.toThrow(/role is not configured/i);
	});

	it("throws when STS returns no credentials", async () => {
		sendMock.mockResolvedValue({});
		await expect(getPlatformAwsCredentials()).rejects.toThrow(/no credentials/i);
	});
});
