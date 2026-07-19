// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// MCP/AI compose tools (lib/ai/tools/compose.ts). Mocked boundary: the only impure dep is the
// pricing server action (getRegionPrices — fetch/cache). Everything else (cloud-provider data maps,
// cidrForHosts, computeCostItems, the proposal zod schema, node-registry) is kept REAL so the
// catalog/cost/proposal logic is exercised end-to-end through the real tool wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/pricing", () => ({ getRegionPrices: vi.fn() }));

import { catalogTools, composeTools } from "@/lib/ai/tools/compose";
import { getRegionPrices, type RegionPrices } from "@/app/server/actions/pricing";
import { ADDABLE_KINDS } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasContext } from "@/lib/ai/canvas-context";

/** Invoke a `tool()`'s execute with throwaway ToolCallOptions. */
const run = <T>(t: { execute?: unknown }, input: T) =>
	(t.execute as (input: T, opts: unknown) => Promise<unknown>)(input, {
		toolCallId: "call-1",
		messages: [],
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("catalogTools.list_services", () => {
	it("lists one entry per addable kind with label + classification", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; label: string; classification: string; serviceNames: unknown }>;
		};
		expect(out.services).toHaveLength(ADDABLE_KINDS.length);
		expect(out.services.map((s) => s.kind).sort()).toEqual([...ADDABLE_KINDS].sort());
		for (const s of out.services) {
			expect(typeof s.label).toBe("string");
			expect(s.label.length).toBeGreaterThan(0);
			expect(typeof s.classification).toBe("string");
		}
	});

	it("maps a kind with a service field to per-cloud concrete names (database → Aurora/…)", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; serviceNames: Record<string, string> | null }>;
		};
		const db = out.services.find((s) => s.kind === "database");
		expect(db?.serviceNames).toEqual({
			aws: "Aurora",
			gcp: expect.any(String),
			azure: expect.any(String),
			alibaba: expect.any(String),
			hetzner: expect.any(String),
		});
	});

	it("emits null serviceNames for a kind with no provider service field (repositories)", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{ kind: string; serviceNames: unknown }>;
		};
		expect(out.services.find((s) => s.kind === "repositories")?.serviceNames).toBeNull();
	});

	it("flags kinds Hetzner can't provision (unsupportedOn) so the agent won't propose them", async () => {
		const out = (await run(catalogTools().list_services, {})) as {
			services: Array<{
				kind: string;
				deployment: Record<string, string> | null;
				unsupportedOn: string[];
			}>;
		};
		const svc = (kind: string) => out.services.find((s) => s.kind === kind);
		// Every hidden Hetzner kind (UNSUPPORTED_KINDS_BY_PROVIDER) is listed on Hetzner —
		// including registry, which has no per-cloud service field. bucket is NATIVE on
		// Hetzner (Object Storage), so it is NOT flagged.
		for (const kind of ["topic", "nosql", "registry"]) {
			expect(svc(kind)?.unsupportedOn).toContain("hetzner");
			// …and on no managed cloud (they're all supported there).
			expect(svc(kind)?.unsupportedOn).not.toContain("aws");
		}
		expect(svc("bucket")?.unsupportedOn).not.toContain("hetzner");
		// Fielded unsupported kinds also report 'unsupported' as their Hetzner deployment mode…
		expect(svc("topic")?.deployment?.hetzner).toBe("unsupported");
		expect(svc("nosql")?.deployment?.aws).toBe("managed");
		// …while supported Hetzner kinds keep their real mode and an empty unsupportedOn there.
		// (cluster/network are no longer addable services — W2 made them env settings.)
		expect(svc("database")?.deployment?.hetzner).toBe("in-cluster-helm");
		expect(svc("database")?.unsupportedOn).not.toContain("hetzner");
		expect(svc("cluster")).toBeUndefined();
	});
});

describe("catalogTools.list_service_options", () => {
	it("returns the real per-provider catalog for aws", async () => {
		const out = (await run(catalogTools().list_service_options, { provider: "aws" as const })) as {
			provider: string;
			default_region: string;
			regions: Array<{ code: string; label: string; group: string }>;
			instance_types: string[];
			default_k8s_version: string;
			db_engines: unknown;
		};
		expect(out.provider).toBe("aws");
		expect(out.default_region).toBe("eu-west-1");
		expect(Array.isArray(out.instance_types)).toBe(true);
		expect(out.instance_types.length).toBeGreaterThan(0);
		expect(out.regions.length).toBeGreaterThan(0);
		expect(out.regions[0]).toEqual({
			code: expect.any(String),
			label: expect.any(String),
			group: expect.any(String),
		});
		expect(out.default_k8s_version).toBeTruthy();
	});

	it("switches the default region per provider (gcp)", async () => {
		const out = (await run(catalogTools().list_service_options, { provider: "gcp" as const })) as {
			provider: string;
			default_region: string;
		};
		expect(out.provider).toBe("gcp");
		expect(out.default_region).toBe("europe-west1");
	});
});

describe("catalogTools.cidr_for_hosts", () => {
	it("computes the smallest fitting CIDR via the real helper", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 511 })) as {
			cidr: string;
			prefix: number;
			usableHosts: number;
		};
		expect(out).toMatchObject({ cidr: "10.0.0.0/23", prefix: 23, usableHosts: 510 });
	});

	it("honors a custom base address", async () => {
		const out = (await run(catalogTools().cidr_for_hosts, { hosts: 10, base: "10.1.0.0" })) as {
			cidr: string;
		};
		expect(out.cidr.startsWith("10.1.0.0/")).toBe(true);
	});
});

describe("composeTools.estimate_cost", () => {
	it("returns an error and never prices when there is no canvas context", async () => {
		const out = (await run(composeTools(undefined).estimate_cost, {})) as { error?: string };
		expect(out.error).toBe("No canvas context available.");
		expect(getRegionPrices).not.toHaveBeenCalled();
	});

	it("estimates from fallback rates (no region) without calling the pricing action", async () => {
		const ctx: CanvasContext = { provider: "aws", form: {} };
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			region: string;
			currency: string;
			monthly_total: number;
			items: Array<{ label: string; monthly: number }>;
		};
		expect(getRegionPrices).not.toHaveBeenCalled();
		expect(out.region).toBe("(none selected)");
		expect(out.currency).toBe("USD");
		expect(out.items.some((i) => i.label === "EKS Control Plane")).toBe(true);
		// fallback EKS control plane = 0.1 * 730 = 73 → contributes to a positive total
		expect(out.monthly_total).toBeGreaterThan(0);
		expect(Number.isInteger(out.monthly_total)).toBe(true);
	});

	it("uses the provider's cluster label and includes database line items", async () => {
		const ctx: CanvasContext = {
			provider: "gcp",
			form: { databases: [{ name: "primary", min_capacity: 1, max_capacity: 8 }] },
		};
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			items: Array<{ label: string }>;
		};
		// getProvider("gcp").clusterService === "GKE"
		expect(out.items.some((i) => i.label === "GKE Control Plane")).toBe(true);
		expect(out.items.some((i) => i.label === "DB: primary")).toBe(true);
	});

	it("fetches live region prices when a region is set and rounds the total", async () => {
		const prices: RegionPrices = {
			eksControlPlane: 0.1,
			natGateway: 0.048,
			auroraACU: 0.14,
			wafWebACL: 5,
			ec2: { "t3.large": 0.0912 },
			cache: {},
			region: "us-east-1",
			fetchedAt: new Date().toISOString(),
		};
		vi.mocked(getRegionPrices).mockResolvedValue(prices);
		const ctx: CanvasContext = {
			provider: "aws",
			form: {
				project: { region: "us-east-1" },
				cluster: { instance_types: ["t3.large"], node_desired_size: 3 },
			},
		};
		const out = (await run(composeTools(ctx).estimate_cost, {})) as {
			region: string;
			monthly_total: number;
		};
		expect(getRegionPrices).toHaveBeenCalledTimes(1);
		expect(getRegionPrices).toHaveBeenCalledWith("us-east-1");
		expect(out.region).toBe("us-east-1");
		// nodes: 0.0912 * 3 * 730 ≈ 199.7 → present in a non-trivial rounded total
		expect(out.monthly_total).toBeGreaterThan(200);
	});
});

describe("composeTools.propose_changes", () => {
	it("is a HITL tool with NO execute (the user accepts client-side)", () => {
		// Removing execute makes the model's turn pause on the proposal until the user
		// accepts it on the canvas; the accepted outcome returns via addToolResult.
		expect(
			(composeTools(undefined).propose_changes as { execute?: unknown }).execute,
		).toBeUndefined();
	});

	it("wires the real proposal schema as its input contract (min 1 action)", () => {
		// inputSchema is typed as AI SDK FlexibleSchema, but at runtime it's the real zod schema.
		const schema = composeTools(undefined).propose_changes.inputSchema as unknown as {
			safeParse: (v: unknown) => { success: boolean };
		};
		expect(schema.safeParse({ label: "x", actions: [] }).success).toBe(false);
		expect(
			schema.safeParse({
				label: "x",
				actions: [{ kind: "add_node", nodeKind: "cluster" }],
			}).success,
		).toBe(true);
	});
});
