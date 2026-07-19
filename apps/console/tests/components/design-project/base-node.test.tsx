// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Render tests for the one data-driven canvas card. These are the proof that the registry's
// `card.facts` actually reach the screen — a fact grid that typechecks but never paints is worth
// nothing. Covers: the fact grid, cloud-honesty (a Hetzner database renders as CloudNativePG, not
// a managed service), the unset-value dash, and the dense tier (a card inside a container collapses
// its facts to one `cost · fact` footer line).

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dense tier is driven by zoom (useCanvasLod) since W2 removed the container regions that used to
// force it via a prop. Mock the LOD so a test can exercise the "compact" (dense) render directly.
const lodState = vi.hoisted(() => ({
	current: "full" as "glyph" | "compact" | "full",
}));
vi.mock("@/lib/canvas/use-canvas-lod", () => ({
	useCanvasLod: () => lodState.current,
	LOD_THRESHOLD: { glyph: 0.5, compact: 0.85 },
}));

import { BaseNode } from "@/components/design-project/canvas/nodes/base-node";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	NodeConfigMap,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type ComponentServerStatus,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import type { ComponentStatus } from "@/lib/db/schema/enums";
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

/**
 * React Flow's store supplies the viewport zoom the LOD hook reads (defaults to 1 → "full").
 * `env` seeds the environment's SERVER truth; omitted, the node falls back to design readiness —
 * which is exactly what happens in the create flow and before the first status fetch lands.
 */
function renderCard(id: string, env?: Partial<EnvironmentStatus>) {
	return render(
		<ReactFlowProvider>
			<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...env }}>
				<BaseNode id={id} />
			</EnvironmentStatusProvider>
		</ReactFlowProvider>,
	);
}

/** One component as `getEnvironmentComponentStatus` would return it. */
function serverStatus(
	lifecycle: ComponentStatus,
	overrides: Partial<ComponentServerStatus> = {},
): ComponentServerStatus {
	return { lifecycle, message: null, drift: [], ...overrides };
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	lodState.current = "full";
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

describe("the dense tier — a card inside a container", () => {
	it("collapses to the name + a `cost · primary fact` footer with a Drift chip", () => {
		seedCanvas("database", "aws", {
			name: "orders",
			engine_family: "postgres",
			engine_version: "16",
			min_capacity: 0.5,
			max_capacity: 4,
			backup_retention_days: 7,
		});
		lodState.current = "compact"; // zoomed out → the dense tier
		renderCard("node-under-test", {
			components: {
				"database:orders": serverStatus("ACTIVE", {
					monthlyCost: 61.32,
					drift: [
						{ address: "aws_db_instance.orders", type: "aws_db_instance", kind: "modified" },
					],
				}),
			},
		});

		expect(screen.getByText("orders")).toBeInTheDocument();
		expect(screen.getByText("$61.32/mo")).toBeInTheDocument();
		// The PRIMARY fact rides in the footer; the full grid (with its labels) is not rendered.
		expect(screen.getByText("PostgreSQL 16")).toBeInTheDocument();
		expect(screen.getByText("Drift")).toBeInTheDocument();
		expect(screen.queryByText("Capacity")).not.toBeInTheDocument();
		expect(screen.queryByText("Backups")).not.toBeInTheDocument();
	});

	it("shows no cost when the resource was never priced — an honest silence, not a fabricated $0", () => {
		seedCanvas("database", "aws", {
			name: "orders",
			engine_family: "postgres",
			engine_version: "16",
		});
		lodState.current = "compact"; // zoomed out → the dense tier
		renderCard("node-under-test", {});

		expect(screen.getByText("PostgreSQL 16")).toBeInTheDocument();
		expect(screen.queryByText(/\/mo/)).not.toBeInTheDocument();
		expect(screen.queryByText("Drift")).not.toBeInTheDocument();
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

describe("design status (no server truth yet)", () => {
	it("an incomplete node surfaces its blocking issue as a needs-setup card", () => {
		seedCanvas("nosql", "aws", { name: "sessions", partition_key: "" });
		renderCard("node-under-test");

		expect(screen.getByText("Needs setup")).toBeInTheDocument();
	});

	it("a valid, never-provisioned node is simply Ready (no label — the canvas stays calm)", () => {
		seedCanvas("bucket", "aws", { name: "assets" });
		renderCard("node-under-test");

		// "ready" is nominal: the dot shows, the label is hidden.
		expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});
});

// The states below all EXISTED in the database and reached nothing before W3. These are the proof
// they now reach the card.
describe("server status reaches the card", () => {
	it("a provisioned component renders Live", () => {
		seedCanvas("database", "aws", { name: "orders" });
		renderCard("node-under-test", {
			components: { "database:orders": serverStatus("ACTIVE") },
		});
		// "live" is nominal, so its label is hidden on the canvas — but the failure states aren't.
		expect(screen.queryByText("Needs setup")).not.toBeInTheDocument();
	});

	it("a failed apply renders Failed", () => {
		seedCanvas("database", "aws", { name: "orders" });
		renderCard("node-under-test", {
			components: {
				"database:orders": serverStatus("FAILED", { message: "bad engine version" }),
			},
		});
		expect(screen.getByText("Failed")).toBeInTheDocument();
	});

	it("an in-flight apply renders Applying", () => {
		seedCanvas("database", "aws", { name: "orders" });
		renderCard("node-under-test", {
			components: { "database:orders": serverStatus("CREATING") },
			activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" },
		});
		expect(screen.getByText("Applying")).toBeInTheDocument();
	});

	it("a live component whose design moved ahead renders Update pending", () => {
		seedCanvas("database", "aws", { name: "orders" });
		renderCard("node-under-test", {
			components: { "database:orders": serverStatus("ACTIVE") },
			updatePending: true,
		});
		expect(screen.getByText("Update pending")).toBeInTheDocument();
	});

	it("an unreachable cluster renders Unreachable", () => {
		seedCanvas("cluster", "aws");
		renderCard("node-under-test", {
			components: { cluster: serverStatus("ACTIVE") },
			probe: { reachable: false, message: "i/o timeout" },
		});
		expect(screen.getByText("Unreachable")).toBeInTheDocument();
	});

	it("keys off nodeStatusKey — a name mismatch means no server status, not a wrong one", () => {
		seedCanvas("database", "aws", { name: "orders" });
		renderCard("node-under-test", {
			// status for a DIFFERENT database
			components: { "database:analytics": serverStatus("FAILED") },
		});
		expect(screen.queryByText("Failed")).not.toBeInTheDocument();
	});
});
