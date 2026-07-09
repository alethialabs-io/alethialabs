// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The internal AWS-token route makes managed AWS provisioning keyless: an authenticated runner (which has
// no ambient AWS identity) gets a freshly-minted OIDC assertion + the platform role ARN, exchanges the
// assertion for the platform identity via AssumeRoleWithWebIdentity, then chains the customer role off it.
// These tests pin the contract — a real minted token that verifies against the JWKS (audience
// sts.amazonaws.com) plus the platform role ARN, 501 when the issuer or platform role ARN is missing, and
// 401 when the runner isn't authenticated.

import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIssuerCache, getPublicJwks } from "@/lib/oidc/issuer";
import { __resetPlatformAwsCache } from "@/lib/cloud-providers/session/aws-platform";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

const APP_URL = "https://alethialabs.io";
const PLATFORM_ROLE = "arn:aws:iam::270587882865:role/alethia-connector-assumer";
const ENV_KEYS = [
	"ALETHIA_OIDC_SIGNING_KEY",
	"ALETHIA_AWS_PLATFORM_ROLE_ARN",
	"AWS_REGION",
	"NEXT_PUBLIC_APP_URL",
	"BETTER_AUTH_URL",
];
const saved: Record<string, string | undefined> = {};

function installConfigured() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
	process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = PLATFORM_ROLE;
	process.env.AWS_REGION = "eu-central-1";
	process.env.NEXT_PUBLIC_APP_URL = APP_URL;
	__resetIssuerCache();
	__resetPlatformAwsCache();
}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	verifyRunnerToken.mockReset();
	verifyRunnerToken.mockResolvedValue({ runnerId: "runner-1", tokenHash: "h", error: null });
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	__resetIssuerCache();
	__resetPlatformAwsCache();
});

async function post() {
	const { POST } = await import("@/app/api/runners/aws-token/route");
	return POST(new Request("https://console.local/api/runners/aws-token", { method: "POST" }));
}

describe("POST /api/runners/aws-token", () => {
	it("mints an AWS assertion that verifies against the JWKS, with the platform role ARN", async () => {
		installConfigured();
		const res = await post();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: string; platform_role_arn: string; region: string };
		expect(body.platform_role_arn).toBe(PLATFORM_ROLE);
		expect(body.region).toBe("eu-central-1");

		const jwks = jose.createLocalJWKSet((await getPublicJwks()) as unknown as jose.JSONWebKeySet);
		const { payload } = await jose.jwtVerify(body.token, jwks, {
			issuer: `${APP_URL}/api/oidc`,
			audience: "sts.amazonaws.com",
		});
		expect(payload.sub).toBe("alethia-connector");
	});

	it("is 501 when the issuer is not configured", async () => {
		installConfigured();
		delete process.env.ALETHIA_OIDC_SIGNING_KEY;
		__resetIssuerCache();
		expect((await post()).status).toBe(501);
	});

	it("is 501 when the platform role ARN is not set", async () => {
		installConfigured();
		delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
		expect((await post()).status).toBe(501);
	});

	it("propagates the 401 from runner auth", async () => {
		installConfigured();
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json({ error: "Invalid runner ID or token" }, { status: 401 }),
		});
		expect((await post()).status).toBe(401);
	});
});
