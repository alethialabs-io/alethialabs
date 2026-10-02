// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5371: the control plane is priced from the catalog's entry for the CLUSTER's cloud and tier, not
// at the EKS rate for every cloud. The fees below are written out by decision, as read from each
// provider's pricing page on the catalog's `as_of` date; recomputing them from CATALOG would pass
// on any value.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, type ControlPlanePricing } from "@/lib/cloud-providers/generated/catalog";
import {
	type CostInput,
	type CostMeta,
	computeCostItems,
	pickControlPlaneTier,
} from "@/lib/cost/compute-cost-items";
import type { RegionPrices } from "@/lib/pricing/region-prices";

const HOURS = 730;
const REPO_ROOT = resolve(__dirname, "../../../../..");

/** Minimal valid input; override per case. */
function input(over: Partial<CostInput> = {}): CostInput {
	return {
		instanceTypes: [],
		nodeDesiredSize: 2,
		singleNatGateway: true,
		databases: [],
		caches: [],
		cloudfrontWaf: false,
		applicationWaf: false,
		nosqlCount: 0,
		secretsCount: 0,
		...over,
	};
}

/** Labels as each cloud's provider metadata names its cluster service. */
const META: Record<CostMeta["provider"], CostMeta> = {
	aws: { clusterService: "EKS", secretsService: "Secrets Manager", provider: "aws" },
	gcp: { clusterService: "GKE", secretsService: "Secret Manager", provider: "gcp" },
	azure: { clusterService: "AKS", secretsService: "Key Vault", provider: "azure" },
	alibaba: { clusterService: "ACK", secretsService: "KMS", provider: "alibaba" },
	hetzner: { clusterService: "Talos Kubernetes", secretsService: "Secrets", provider: "hetzner" },
};

/** The control-plane lines of an estimate. */
function controlPlaneLines(provider: CostMeta["provider"], over: Partial<CostInput> = {}, prices: RegionPrices | null = null) {
	return computeCostItems(input(over), prices, META[provider]).items.filter((i) =>
		i.label.endsWith(" Control Plane"),
	);
}

describe("control-plane pricing per cloud, at the tier the template deploys (#5371)", () => {
	it("aws: EKS standard support, $0.10 per cluster-hour", () => {
		const [line, ...rest] = controlPlaneLines("aws");
		expect(rest).toHaveLength(0);
		expect(line?.label).toBe("EKS Control Plane");
		expect(line?.cost).toBeCloseTo(0.1 * HOURS, 5);
		expect(line?.detail).toBe("Standard support");
	});

	it("aws: the live regional price wins over the catalog's standard rate", () => {
		const prices: RegionPrices = {
			eksControlPlane: 0.2,
			ec2: {},
			natGateway: 0.048,
			auroraACU: 0.14,
			cache: {},
			wafWebACL: 5,
			region: "us-east-1",
			fetchedAt: "2026-10-01T00:00:00Z",
		};
		expect(controlPlaneLines("aws", {}, prices)[0]?.cost).toBeCloseTo(0.2 * HOURS, 5);
		// The live table carries the standard rate only; extended support is never read from it.
		const extended = controlPlaneLines("aws", { controlPlaneTier: "extended" }, prices)[0];
		expect(extended?.cost).toBeCloseTo(0.6 * HOURS, 5);
		expect(extended?.detail).toMatch(/^Extended support · /);
	});

	it("gcp: the GKE cluster fee, with the free-tier credit stated and NOT deducted", () => {
		const [line, ...rest] = controlPlaneLines("gcp");
		expect(rest).toHaveLength(0);
		expect(line?.label).toBe("GKE Control Plane");
		expect(line?.cost).toBeCloseTo(0.1 * HOURS, 5);
		expect(line?.detail).toContain("free-tier credit");
		expect(line?.detail).toContain("not deducted");
	});

	it("azure: the Free tier has no fee, so there is NO line", () => {
		expect(controlPlaneLines("azure")).toEqual([]);
	});

	it("azure: the Standard tier is $0.10 per cluster-hour", () => {
		const [line] = controlPlaneLines("azure", { controlPlaneTier: "standard" });
		expect(line?.cost).toBeCloseTo(0.1 * HOURS, 5);
		expect(line?.detail).toBe("Standard tier · uptime SLA");
	});

	it("alibaba: ACK managed Pro, $0.09 per cluster-hour", () => {
		const [line, ...rest] = controlPlaneLines("alibaba");
		expect(rest).toHaveLength(0);
		expect(line?.label).toBe("ACK Control Plane");
		expect(line?.cost).toBeCloseTo(0.09 * HOURS, 5);
	});

	it("alibaba: ACK managed Basic has no fee, so there is NO line", () => {
		expect(controlPlaneLines("alibaba", { controlPlaneTier: "basic" })).toEqual([]);
	});

	it("hetzner: no managed fee, but the control-plane server the template orders is priced as a server", () => {
		// The node line counts workers only; ProviderTfvars orders one more server of the worker type
		// for the control plane (TestHetznerControlPlaneServersMatchTheCatalog holds the count).
		const [line, ...rest] = controlPlaneLines("hetzner");
		expect(rest).toHaveLength(0);
		expect(line?.label).toBe("Talos Kubernetes Control Plane");
		expect(line?.cost).toBeCloseTo((19 / 730) * HOURS, 5); // cpx22 ~€19/mo, the template default
		expect(line?.detail).toBe("1x cpx22 · Talos on Hetzner servers, no managed fee");
		// A pinned worker type moves the control-plane server with it.
		const pinned = controlPlaneLines("hetzner", { instanceTypes: ["cpx32"] })[0];
		expect(pinned?.detail).toMatch(/^1x cpx32 · /);
		expect(pinned?.cost).toBeGreaterThan(line?.cost ?? Number.POSITIVE_INFINITY);
	});

	it("an unknown tier falls back to the tier the template deploys", () => {
		expect(controlPlaneLines("aws", { controlPlaneTier: "platinum" })[0]?.detail).toBe("Standard support");
	});

	it("the control plane stays the first line of the estimate", () => {
		const { items } = computeCostItems(input(), null, META.gcp);
		expect(items[0]?.label).toBe("GKE Control Plane");
	});
});

describe("the catalog's control-plane entries", () => {
	it("every catalog cloud has an entry: a fee, or an explicit no-fee tier", () => {
		for (const p of CATALOG.providers) {
			const slug = p.slug;
			expect(slug in CATALOG.control_plane, `control_plane.${slug}`).toBe(true);
		}
	});

	it("no tier is priced at zero; a tier without a fee is null and produces no line", () => {
		for (const [slug, cp] of Object.entries(CATALOG.control_plane)) {
			for (const t of cp.tiers) {
				expect(t.hourly_usd === null || t.hourly_usd > 0, `${slug}/${t.tier}`).toBe(true);
				expect(t.source, `${slug}/${t.tier}`).toMatch(/^https:\/\//);
				expect(t.as_of, `${slug}/${t.tier}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
		}
	});

	it("the generated TS mirror is in sync with catalog.json", () => {
		const json: { control_plane: unknown } = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "packages/core/catalog/catalog.json"), "utf8"),
		);
		expect(CATALOG.control_plane).toEqual(json.control_plane);
	});
});

describe("pickControlPlaneTier", () => {
	it("refuses an entry whose default tier is not one of its tiers", () => {
		const broken: ControlPlanePricing = { default_tier: "gone", self_hosted_servers: 0, tiers: [] };
		expect(() => pickControlPlaneTier(broken)).toThrow(/gone/);
	});
});
