// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/cloud-providers/placement.ts → resolveComponentPlacement: coalesce(component identity,
// project identity) → that identity's provider. The config snapshot and getProject both place
// through it (#5361).

import { describe, expect, it } from "vitest";
import { resolveComponentPlacement } from "@/lib/cloud-providers/placement";

const core = { cloud_provider: "aws", cloud_identity_id: "ci-aws", region: "us-east-1" };
const providers = new Map([
	["ci-aws", "aws"],
	["ci-gcp", "gcp"],
]);

describe("resolveComponentPlacement", () => {
	it("a component on its own identity lands on that identity's cloud and region", () => {
		expect(
			resolveComponentPlacement(core, providers, {
				cloud_identity_id: "ci-gcp",
				region: "europe-west1",
			}),
		).toEqual({ cloud_provider: "gcp", cloud_identity_id: "ci-gcp", region: "europe-west1" });
	});

	it("a component without its own identity inherits the project's", () => {
		expect(resolveComponentPlacement(core, providers, { cloud_identity_id: null })).toEqual(core);
		expect(resolveComponentPlacement(core, providers, null)).toEqual(core);
	});

	it("an identity the caller could not resolve falls back to the project's provider", () => {
		expect(
			resolveComponentPlacement(core, providers, { cloud_identity_id: "ci-unknown" }).cloud_provider,
		).toBe("aws");
	});

	it("a project with no identity still places a component that has one", () => {
		const bare = { cloud_provider: "aws", cloud_identity_id: null, region: "x" };
		expect(resolveComponentPlacement(bare, providers, { cloud_identity_id: "ci-gcp" }).cloud_provider).toBe("gcp");
		expect(resolveComponentPlacement(bare, providers).cloud_identity_id).toBeNull();
	});
});
