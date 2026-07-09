// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The managed-cloud model hubs through ONE platform AWS identity: AWS assumes customer roles, and GCP
// federates through the SAME identity (its customer WIF pool trusts an AWS provider). That identity is
// now KEYLESS — the console federates in via the OIDC issuer (AssumeRoleWithWebIdentity), so availability
// tracks the issuer + the platform role ARN, not a static key. These tests pin that contract, and that
// GCP still rides the same identity (no separate GCP secret).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { issuerState } = vi.hoisted(() => ({ issuerState: { on: false } }));

vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: () => ({
		providers: { github: null, google: null, gitlab: null, bitbucket: null },
	}),
}));
vi.mock("@/lib/oidc/issuer", () => ({
	oidcIssuerConfigured: () => issuerState.on,
	mintWorkloadToken: vi.fn(),
}));

import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";

const ROLE_ARN = "arn:aws:iam::270587882865:role/alethia-connector-assumer";

describe("computePlatformConfigured — keyless AWS hub (GCP rides it)", () => {
	const saved: string | undefined = process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
	beforeEach(() => {
		issuerState.on = false;
		delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN;
		else process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = saved;
	});

	it("aws and gcp are BOTH false without the platform identity", () => {
		const c = computePlatformConfigured();
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
	});

	it("the keyless platform identity (issuer + role ARN) enables BOTH aws and gcp", () => {
		issuerState.on = true;
		process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = ROLE_ARN;
		const c = computePlatformConfigured();
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
	});

	it("a role ARN without a configured issuer is not enough (both false)", () => {
		process.env.ALETHIA_AWS_PLATFORM_ROLE_ARN = ROLE_ARN;
		issuerState.on = false;
		const c = computePlatformConfigured();
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
	});

	it("token clouds are always available (customer's own token)", () => {
		const c = computePlatformConfigured();
		expect(c.hetzner).toBe(true);
		expect(c.digitalocean).toBe(true);
		expect(c.civo).toBe(true);
	});
});
