// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The internal GCP-token route makes DIRECT-OIDC GCP provisioning keyless: an authenticated runner gets a
// freshly-minted OIDC assertion it writes to a token file google-auth exchanges for a GCP token. These pin
// the contract: a real minted token that verifies against the JWKS (audience GCP_TOKEN_AUDIENCE), 501 when
// the issuer isn't configured, and 401 when the runner isn't authenticated.

import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIssuerCache, getPublicJwks } from "@/lib/oidc/issuer";
import { GCP_TOKEN_AUDIENCE } from "@/lib/cloud-providers/session/gcp";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

const APP_URL = "https://alethialabs.io";
const saved: Record<string, string | undefined> = {};

function installKey() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
	process.env.NEXT_PUBLIC_APP_URL = APP_URL;
	__resetIssuerCache();
}

beforeEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
		saved[k] = process.env[k];
	}
	verifyRunnerToken.mockReset();
	verifyRunnerToken.mockResolvedValue({ runnerId: "runner-1", tokenHash: "h", error: null });
});
afterEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	__resetIssuerCache();
});

async function post() {
	const { POST } = await import("@/app/api/runners/gcp-token/route");
	return POST(new Request("https://console.local/api/runners/gcp-token", { method: "POST" }));
}

describe("POST /api/runners/gcp-token", () => {
	it("mints a GCP assertion that verifies against the JWKS", async () => {
		installKey();
		const res = await post();
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };

		const jwks = jose.createLocalJWKSet((await getPublicJwks()) as unknown as jose.JSONWebKeySet);
		const { payload } = await jose.jwtVerify(token, jwks, {
			issuer: `${APP_URL}/api/oidc`,
			audience: GCP_TOKEN_AUDIENCE,
		});
		expect(payload.sub).toBe("alethia-connector");
	});

	it("is 501 when the issuer is not configured", async () => {
		delete process.env.ALETHIA_OIDC_SIGNING_KEY;
		__resetIssuerCache();
		expect((await post()).status).toBe(501);
	});

	it("propagates the 401 from runner auth", async () => {
		installKey();
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json({ error: "Invalid runner ID or token" }, { status: 401 }),
		});
		expect((await post()).status).toBe(401);
	});
});
