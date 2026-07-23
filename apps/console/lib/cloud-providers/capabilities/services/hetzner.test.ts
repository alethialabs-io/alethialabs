// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the Hetzner Wave-2 service normalizer (#976). Hetzner has no managed-service API to
// federate — its data services are in-cluster charts — so the "normalizer" records the STATIC platform
// offerings from the Catalog #2 Hetzner slices. These assert that exclusion-with-offerings contract:
// CloudNativePG Postgres + Valkey cache tiers + the pinned k8s version are launchable, and NoSQL is
// intentionally absent.

import { describe, expect, it } from "vitest";
import {
	CACHE_NODE_TYPES,
	DB_ENGINES,
	K8S_VERSIONS,
} from "@/lib/cloud-providers/generated/catalog";
import { type HetznerServiceCtx, normalizeHetznerServiceRows } from "./hetzner";

const ctx: HetznerServiceCtx = {
	cloudIdentityId: "ci-1",
	region: "fsn1",
	now: new Date("2026-01-01T00:00:00Z"),
};

describe("normalizeHetznerServiceRows", () => {
	const rows = normalizeHetznerServiceRows(ctx);

	it("records the CloudNativePG database engine from the catalog", () => {
		const db = rows.filter((r) => r.service_kind === "database");
		expect(db).toHaveLength(DB_ENGINES.hetzner.length);
		const pg = db.find((r) => r.native_id === "postgres");
		expect(pg?.engine).toBe("postgres");
		expect(pg?.name).toBe("PostgreSQL (CloudNativePG)");
		expect(pg?.version).toBe("16");
		expect(pg?.launchable).toBe("launchable");
		expect(pg?.launchable_reason).toBe("available");
	});

	it("records every in-cluster Valkey cache tier with memory from the catalog", () => {
		const cache = rows.filter((r) => r.service_kind === "cache");
		expect(cache.map((r) => r.native_id)).toEqual(
			CACHE_NODE_TYPES.hetzner.map((t) => t.value),
		);
		const oneGiB = cache.find((r) => r.native_id === "1");
		expect(oneGiB?.tier).toBe("1");
		expect(oneGiB?.mem_gb).toBe(1);
	});

	it("records the single pinned Talos-coupled k8s version", () => {
		const k8s = rows.filter((r) => r.service_kind === "kubernetes");
		expect(k8s.map((r) => r.native_id)).toEqual(K8S_VERSIONS.hetzner);
		expect(k8s[0]?.version).toBe(k8s[0]?.native_id);
	});

	it("records NO nosql row (Hetzner offers no managed NoSQL — the honest exclusion)", () => {
		expect(rows.some((r) => r.service_kind === "nosql")).toBe(false);
	});

	it("scopes every row to the identity + provider + region", () => {
		for (const r of rows) {
			expect(r.cloud_identity_id).toBe("ci-1");
			expect(r.provider).toBe("hetzner");
			expect(r.region).toBe("fsn1");
			expect(r.removed_at).toBeNull();
		}
	});
});
