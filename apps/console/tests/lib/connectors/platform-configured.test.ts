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
	// Loaded transitively through lib/auth; the sign-up challenge is off here.
	getSignupChallengeConfig: () => null,
}));
vi.mock("@/lib/oidc/issuer", () => ({
	oidcIssuerConfigured: () => issuerState.on,
	mintWorkloadToken: vi.fn(),
}));

import { withHiddenClouds } from "@/lib/cloud-providers/availability";
import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";

describe("computePlatformConfigured — issuer-direct keyless clouds", () => {
	beforeEach(() => {
		issuerState.on = false;
	});

	it("aws / gcp / azure / alibaba are all false without the issuer", async () => {
		const c = await withHiddenClouds(["alibaba"], () => computePlatformConfigured());
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
		expect(c.azure).toBe(false);
		expect(c.alibaba).toBe(false);
	});

	it("the issuer alone enables aws, gcp and azure, and alibaba where it is offered", async () => {
		issuerState.on = true;
		const c = await withHiddenClouds(["alibaba"], () => computePlatformConfigured());
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
		expect(c.azure).toBe(true);
		expect(c.alibaba).toBe(true);
	});

	it("an offered token cloud is always available (customer's own token)", async () => {
		expect(computePlatformConfigured().hetzner).toBe(true);
		const c = await withHiddenClouds(["digitalocean", "civo"], () => computePlatformConfigured());
		expect(c.hetzner).toBe(true);
		expect(c.digitalocean).toBe(true);
		expect(c.civo).toBe(true);
	});
});

describe("computePlatformConfigured — a cloud this deployment does not offer", () => {
	beforeEach(() => {
		issuerState.on = true;
	});

	it("is false for every hidden cloud, with the issuer configured", () => {
		const c = computePlatformConfigured();
		expect(c.alibaba).toBe(false);
		expect(c.digitalocean).toBe(false);
		expect(c.civo).toBe(false);
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
		expect(c.azure).toBe(true);
		expect(c.hetzner).toBe(true);
	});

	it("re-enabling one hidden cloud changes that cloud only", async () => {
		const c = await withHiddenClouds(["civo"], () => computePlatformConfigured());
		expect(c.civo).toBe(true);
		expect(c.alibaba).toBe(false);
		expect(c.digitalocean).toBe(false);
	});
});
