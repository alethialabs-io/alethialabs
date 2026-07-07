// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The managed-cloud model hubs through ONE platform AWS identity: AWS assumes customer roles, and GCP
// federates through the SAME identity (its customer WIF pool trusts an AWS provider). So GCP
// availability must track the AWS platform creds — there is no separate GCP secret. These tests pin
// that contract so a future edit can't silently re-gate GCP on the (removed) WIF marker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: () => ({
		providers: { github: null, google: null, gitlab: null, bitbucket: null },
	}),
}));

import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";

const AWS_KEYS = ["ALETHIA_AWS_ACCESS_KEY_ID", "ALETHIA_AWS_SECRET_ACCESS_KEY"];

describe("computePlatformConfigured — GCP rides the AWS hub", () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of AWS_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of AWS_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("aws and gcp are BOTH false without the platform AWS creds", () => {
		const c = computePlatformConfigured();
		expect(c.aws).toBe(false);
		expect(c.gcp).toBe(false);
	});

	it("the AWS platform creds enable BOTH aws and gcp (no separate GCP secret)", () => {
		process.env.ALETHIA_AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
		process.env.ALETHIA_AWS_SECRET_ACCESS_KEY = "secret";
		const c = computePlatformConfigured();
		expect(c.aws).toBe(true);
		expect(c.gcp).toBe(true);
	});

	it("token clouds are always available (customer's own token)", () => {
		const c = computePlatformConfigured();
		expect(c.hetzner).toBe(true);
		expect(c.digitalocean).toBe(true);
		expect(c.civo).toBe(true);
	});
});
