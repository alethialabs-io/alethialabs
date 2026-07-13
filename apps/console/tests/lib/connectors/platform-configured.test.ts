// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every managed cloud now federates KEYLESSLY off the Alethia OIDC issuer — no platform AWS account, and
// (since the Azure customer-side managed-identity rework) no platform Entra app either. So aws / gcp /
// azure / alibaba availability all track the issuer alone. These tests pin that contract (and that token
// clouds are always available — customer's own token).

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
	beforeEach(() => {
		issuerState.on = false;
	});

	it("aws / gcp / azure / alibaba are all false without the issuer", () => {
		const c = computePlatformConfigured();
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
		expect(c.azure).toBe(false);
		expect(c.alibaba).toBe(false);
	});

	it("the issuer alone enables aws, gcp, azure, and alibaba", () => {
		issuerState.on = true;
		const c = computePlatformConfigured();
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
		expect(c.azure).toBe(true);
		expect(c.alibaba).toBe(true);
	});

	it("token clouds are always available (customer's own token)", () => {
		const c = computePlatformConfigured();
		expect(c.hetzner).toBe(true);
		expect(c.digitalocean).toBe(true);
		expect(c.civo).toBe(true);
	});
});
