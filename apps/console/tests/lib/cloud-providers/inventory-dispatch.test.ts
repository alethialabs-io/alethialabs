// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba is now a server-side-inventory provider (regions/VPCs/VSwitches), alongside aws/gcp/azure and
// the token clouds. This pins that it's included in the capability gate the reconciliation sweep reads.

import { describe, expect, it } from "vitest";
import { hasServerSideInventory } from "@/lib/cloud-providers/inventory";

describe("hasServerSideInventory", () => {
	it("includes all four managed clouds", () => {
		for (const p of ["aws", "gcp", "azure", "alibaba"] as const) {
			expect(hasServerSideInventory(p)).toBe(true);
		}
	});

	it("includes the token clouds", () => {
		// The token-auth clouds also have inventory. The old "unknown provider → false" case is gone:
		// the CloudProvider enum makes an unknown provider unrepresentable at the type level.
		for (const p of ["hetzner", "digitalocean", "civo"] as const) {
			expect(hasServerSideInventory(p)).toBe(true);
		}
	});
});
