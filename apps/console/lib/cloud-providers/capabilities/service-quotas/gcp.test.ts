// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GCP service-quota lane (#981): the pure normalizer over a Compute quotas[] array. GCP reports usage, so
// used/available are populated. Regional metrics carry a real region; global metrics use "global".

import { describe, expect, it } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";
import {
	normalizeGcpQuotas,
	syncGcpQuotaCapabilities,
} from "@/lib/cloud-providers/capabilities/service-quotas/gcp";

const REGIONAL = { STATIC_ADDRESSES: "elastic_ip" } as const;
const GLOBAL = { FIREWALLS: "security_group", FORWARDING_RULES: "load_balancer" } as const;

describe("normalizeGcpQuotas", () => {
	it("maps regional STATIC_ADDRESSES to elastic_ip with available = limit - usage", () => {
		const rows = normalizeGcpQuotas(
			"us-central1",
			[
				{ metric: "STATIC_ADDRESSES", limit: 8, usage: 3 },
				{ metric: "CPUS", limit: 100, usage: 10 }, // unrelated → ignored
			],
			REGIONAL,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].quota_kind).toBe("elastic_ip");
		expect(rows[0].native_id).toBe("STATIC_ADDRESSES");
		expect(rows[0].region).toBe("us-central1");
		expect(rows[0].quota_limit).toBe(8);
		expect(rows[0].used).toBe(3);
		expect(rows[0].available).toBe(5);
	});

	it("maps global FIREWALLS/FORWARDING_RULES to security_group/load_balancer", () => {
		const rows = normalizeGcpQuotas(
			"global",
			[
				{ metric: "FIREWALLS", limit: 100, usage: 12 },
				{ metric: "FORWARDING_RULES", limit: 15, usage: 4 },
			],
			GLOBAL,
		);
		expect(rows.find((r) => r.quota_kind === "security_group")?.native_id).toBe("FIREWALLS");
		expect(rows.find((r) => r.quota_kind === "load_balancer")?.available).toBe(11);
		expect(rows.every((r) => r.region === "global")).toBe(true);
	});

	it("keeps figures NULL when the provider omits limit/usage", () => {
		const rows = normalizeGcpQuotas("us-central1", [{ metric: "STATIC_ADDRESSES" }], REGIONAL);
		expect(rows[0].quota_limit).toBeNull();
		expect(rows[0].used).toBeNull();
		expect(rows[0].available).toBeNull();
	});
});

describe("syncGcpQuotaCapabilities (best-effort guard)", () => {
	it("returns without throwing when project_id is absent", async () => {
		const identity: CapabilityIdentity = {
			id: "id-1",
			provider: "gcp",
			credentials: {},
		};
		await expect(syncGcpQuotaCapabilities(identity)).resolves.toBeUndefined();
	});
});
