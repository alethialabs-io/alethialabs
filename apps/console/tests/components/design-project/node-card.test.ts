// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guards for the registry-driven canvas card. The design system is grayscale — a service can't be
// told apart by hue — so the FACTS are the differentiator, and they must be (a) present for every
// kind, (b) bounded (the card renders at most 3), and (c) cloud-HONEST: on a compute-only cloud a
// database is an in-cluster CloudNativePG chart, not a managed service, and the card has to say so.

import { describe, expect, it } from "vitest";
import {
	NODE_REGISTRY,
	type NodeFact,
} from "@/components/design-project/canvas/graph/node-registry";
import type {
	NodeConfig,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { lodForZoom, LOD_THRESHOLD } from "@/lib/canvas/use-canvas-lod";

const KINDS = Object.keys(NODE_REGISTRY) as NodeKind[];

/** Run a kind's fact builder against its own default config for the given provider. */
function factsFor(kind: NodeKind, provider: CloudProviderSlug): NodeFact[] {
	const def = NODE_REGISTRY[kind];
	const config = def.defaultData(provider) as NodeConfig;
	const build = def.card.facts as (ctx: {
		config: NodeConfig;
		provider: CloudProviderSlug | null;
	}) => NodeFact[];
	return build({ config, provider });
}

describe("NODE_REGISTRY card spec", () => {
	it("every kind declares a card with a fact builder", () => {
		for (const kind of KINDS) {
			expect(NODE_REGISTRY[kind].card, `${kind} has no card spec`).toBeDefined();
			expect(
				typeof NODE_REGISTRY[kind].card.facts,
				`${kind} has no fact builder`,
			).toBe("function");
		}
	});

	it("facts stay within the card's budget (the renderer shows at most 3)", () => {
		for (const kind of KINDS) {
			for (const provider of ["aws", "gcp", "azure", "alibaba", "hetzner"] as const) {
				const facts = factsFor(kind, provider);
				expect(
					facts.length,
					`${kind} on ${provider} emits ${facts.length} facts; the card renders at most 3`,
				).toBeLessThanOrEqual(3);
			}
		}
	});

	it("every fact carries a label (an unset value is allowed — it renders as a dash)", () => {
		for (const kind of KINDS) {
			for (const fact of factsFor(kind, "aws")) {
				expect(fact.label, `${kind} emitted a fact with no label`).toBeTruthy();
				expect(typeof fact.value).toBe("string");
			}
		}
	});
});

describe("cards are cloud-honest", () => {
	it("a Hetzner database says it runs as CloudNativePG, not a managed service", () => {
		const values = factsFor("database", "hetzner").map((f) => f.value);
		expect(values).toContain("CloudNativePG");
	});

	it("a Hetzner cache is Valkey whatever engine the config carries", () => {
		// The in-cluster chart is Valkey-only; the default config still says "redis".
		expect(NODE_REGISTRY.cache.defaultData("hetzner").engine).toBe("redis");
		const engine = factsFor("cache", "hetzner").find((f) => f.label === "Engine");
		expect(engine?.value).toBe("Valkey");
	});

	it("a Hetzner queue says it runs as RabbitMQ", () => {
		const values = factsFor("queue", "hetzner").map((f) => f.value);
		expect(values).toContain("RabbitMQ");
	});

	it("a managed-cloud database shows capacity, not an in-cluster chart", () => {
		const facts = factsFor("database", "aws");
		expect(facts.map((f) => f.label)).toContain("Capacity");
		expect(facts.map((f) => f.value)).not.toContain("CloudNativePG");
	});
});

describe("card handles mirror the derived edge topology", () => {
	// deriveEdges (use-canvas-store) links network → cluster → every leaf. The nubs a card draws
	// must match, or an edge lands on a node with nowhere to attach.
	it("the network sources only", () => {
		expect(NODE_REGISTRY.network.card.handles).toEqual({ source: true });
	});

	it("the cluster both sources and targets", () => {
		expect(NODE_REGISTRY.cluster.card.handles).toEqual({ source: true, target: true });
	});

	it("leaves declare no handles and fall back to target-only", () => {
		for (const kind of ["database", "cache", "queue", "topic", "nosql", "bucket"] as const) {
			expect(
				NODE_REGISTRY[kind].card.handles,
				`${kind} should inherit the target-only default`,
			).toBeUndefined();
		}
	});
});

describe("classification drives the card's rule", () => {
	it("BYO charts are external (drawn dashed — not owned by the design)", () => {
		expect(NODE_REGISTRY.chart.classification).toBe("external");
	});

	it("the project is the root anchor", () => {
		expect(NODE_REGISTRY.project.classification).toBe("root");
	});
});

describe("lodForZoom", () => {
	it("sheds detail as the viewport zooms out", () => {
		expect(lodForZoom(0.3)).toBe("glyph");
		expect(lodForZoom(0.7)).toBe("compact");
		expect(lodForZoom(1.2)).toBe("full");
	});

	it("is half-open at each threshold (a boundary zoom picks the richer tier)", () => {
		expect(lodForZoom(LOD_THRESHOLD.glyph - 0.001)).toBe("glyph");
		expect(lodForZoom(LOD_THRESHOLD.glyph)).toBe("compact");
		expect(lodForZoom(LOD_THRESHOLD.compact - 0.001)).toBe("compact");
		expect(lodForZoom(LOD_THRESHOLD.compact)).toBe("full");
	});
});
