// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every managed cloud now federates KEYLESSLY off the Alethia OIDC issuer — no platform AWS account. So
// aws / gcp / alibaba availability tracks the issuer alone; azure additionally needs its platform app id.
// These tests pin that contract (and that token clouds are always available — customer's own token).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { issuerState } = vi.hoisted(() => ({ issuerState: { on: false } }));

vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: () => ({
		providers: { github: null, google: null, gitlab: null, bitbucket: null },
	}),
	getAuthRateLimit: () => ({ enabled: false }),
}));
vi.mock("@/lib/oidc/issuer", () => ({
	oidcIssuerConfigured: () => issuerState.on,
	mintWorkloadToken: vi.fn(),
}));

import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";

describe("computePlatformConfigured — issuer-direct keyless clouds", () => {
	const savedAzure: string | undefined = process.env.ALETHIA_AZURE_CLIENT_ID;
	beforeEach(() => {
		issuerState.on = false;
		delete process.env.ALETHIA_AZURE_CLIENT_ID;
	});
	afterEach(() => {
		if (savedAzure === undefined) delete process.env.ALETHIA_AZURE_CLIENT_ID;
		else process.env.ALETHIA_AZURE_CLIENT_ID = savedAzure;
	});

	it("aws / gcp / alibaba are all false without the issuer", () => {
		const c = computePlatformConfigured();
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
		expect(c.alibaba).toBe(false);
	});

	it("the issuer alone enables aws, gcp, and alibaba", () => {
		issuerState.on = true;
		const c = computePlatformConfigured();
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
		expect(c.alibaba).toBe(true);
	});

	it("azure additionally needs the platform app id", () => {
		issuerState.on = true;
		let c = computePlatformConfigured();
		expect(c.azure).toBe(false);
		process.env.ALETHIA_AZURE_CLIENT_ID = "00000000-0000-0000-0000-000000000000";
		c = computePlatformConfigured();
		expect(c.azure).toBe(true);
	});

	it("token clouds are always available (customer's own token)", () => {
		const c = computePlatformConfigured();
		expect(c.hetzner).toBe(true);
		expect(c.digitalocean).toBe(true);
		expect(c.civo).toBe(true);
	});
});
