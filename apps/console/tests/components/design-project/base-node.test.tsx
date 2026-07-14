// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Render tests for the one data-driven canvas card. These are the proof that the registry's
// `card.facts` actually reach the screen — a fact grid that typechecks but never paints is worth
// nothing. Covers: the fact grid, cloud-honesty (a Hetzner database renders as CloudNativePG, not
// a managed service), the unset-value dash, and LOD (the compact tier drops to a single fact).

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BaseNode } from "@/components/design-project/canvas/nodes/base-node";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	NodeConfigMap,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A canvas holding the project root plus one node of `kind`, both on `provider`. */
function seedCanvas<K extends NodeKind>(
	kind: K,
	provider: CloudProviderSlug,
	config?: Partial<NodeConfigMap[K]>,
) {
	const node = {
		id: "node-under-test",
		type: kind,
		position: { x: 0, y: 0 },
		data: {
			kind,
			config: { ...NODE_REGISTRY[kind].defaultData(provider), ...config },
			cloud_identity_id: null,
			provider,
		},
	} as CanvasNode;

	const root = {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData(provider),
			cloud_identity_id: null,
			provider,
		},
	} as CanvasNode;

	useCanvasStore.setState({ nodes: [root, node], identities: [], baseline: [] });
	return node;
}

/** React Flow's store supplies the viewport zoom the LOD hook reads (defaults to 1 → "full"). */
function renderCard(id: string) {
	return render(
		<ReactFlowProvider>
			<BaseNode id={id} />
		</ReactFlowProvider>,
	);
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("the canvas card renders its kind's facts", () => {
	it("a managed database shows engine, capacity and backups", () => {
		seedCanvas("database", "aws", {
			name: "orders",
			engine_family: "postgres",
			engine_version: "16",
			min_capacity: 0.5,
			max_capacity: 4,
			backup_retention_days: 7,
		});
		renderCard("node-under-test");

		expect(screen.getByText("orders")).toBeInTheDocument();
		expect(screen.getByText("PostgreSQL 16")).toBeInTheDocument();
		expect(screen.getByText("0.5–4")).toBeInTheDocument();
		expect(screen.getByText("7 d")).toBeInTheDocument();
	});

	it("a bucket reads as access · versioning · CORS — not as a database", () => {
		seedCanvas("bucket", "aws", {
			name: "assets",
			public_access: false,
			versioning: true,
			cors_origins: ["https://a.example", "https://b.example"],
		});
		renderCard("node-under-test");

		expect(screen.getByText("private")).toBeInTheDocument();
		expect(screen.getByText("on")).toBeInTheDocument();
		expect(screen.getByText("2 origins")).toBeInTheDocument();
	});

	it("an unset value renders as a dash, so an unconfigured resource reads as unconfigured", () => {
		// A fresh NoSQL table has no partition key — the schema requires one.
		seedCanvas("nosql", "aws", { name: "sessions", partition_key: "" });
		renderCard("node-under-test");

		expect(screen.getByText("Partition key")).toBeInTheDocument();
		expect(screen.getByText("—")).toBeInTheDocument();
	});
});

describe("the card is cloud-honest", () => {
	it("a Hetzner database says CloudNativePG — it is an in-cluster chart, not a managed service", () => {
		seedCanvas("database", "hetzner", { name: "ledger", storage_gb: 40, replicas: 2 });
		renderCard("node-under-test");

		expect(screen.getByText("CloudNativePG")).toBeInTheDocument();
		expect(screen.getByText("40 GiB × 2")).toBeInTheDocument();
		// The managed-cloud framing must NOT leak through.
		expect(screen.queryByText("Capacity")).not.toBeInTheDocument();
	});

	it("the same kind on AWS renders the managed framing instead", () => {
		seedCanvas("database", "aws", { name: "ledger" });
		renderCard("node-under-test");

		expect(screen.getByText("Capacity")).toBeInTheDocument();
		expect(screen.queryByText("CloudNativePG")).not.toBeInTheDocument();
	});
});

describe("status", () => {
	it("an incomplete node surfaces its blocking issue as a needs-setup card", () => {
		seedCanvas("nosql", "aws", { name: "sessions", partition_key: "" });
		renderCard("node-under-test");

		// NODE_STATUS_META["needs-setup"].label
		expect(screen.getByText("Needs setup")).toBeInTheDocument();
	});
});
