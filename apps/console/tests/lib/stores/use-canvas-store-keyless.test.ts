// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas gate is a RENDER filter and nothing more, so on its own it is a display trick: enable
// keyless on AWS, re-place the node on Hetzner, and `iam_auth: true` used to survive into the
// persisted draft, the saved row and the deployed config snapshot — with a disabled toggle reading
// "off" above it. These pin the store keeping the value and the display in step (#1510).
//
// The deploy gate in buildConfigSnapshot is still the authority, and it THROWS. This layer is what
// stops an honest user reaching it by accident.

import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

const DB_ID = "database-orders";

function projectNode(provider: CloudProviderSlug | null): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: { project_name: "p" },
			cloud_identity_id: null,
			provider,
		},
	} as unknown as CanvasNode;
}

function dbNode(
	provider: CloudProviderSlug | null,
	config: Record<string, unknown>,
): CanvasNode {
	return {
		id: DB_ID,
		type: "database",
		position: { x: 0, y: 0 },
		data: {
			kind: "database",
			config: { name: "orders", ...config },
			cloud_identity_id: null,
			provider,
		},
	} as unknown as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
	useCanvasStore.setState({
		nodes,
		baseline: structuredClone(nodes),
		past: [],
		future: [],
		dirty: false,
	});
}

/** The database node's `iam_auth` as the store currently holds it. */
const iamAuth = () => {
	const node = useCanvasStore.getState().nodes.find((n) => n.id === DB_ID);
	return node?.data.kind === "database" ? node.data.config.iam_auth : undefined;
};

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("keyless auth follows the cell the database sits on", () => {
	it("clears iam_auth when the node is re-placed on a cloud that can't honor it", () => {
		seed([
			projectNode("aws"),
			dbNode("aws", { engine_family: "postgres", iam_auth: true }),
		]);
		useCanvasStore.getState().setNodeIdentity(DB_ID, null, "hetzner");
		expect(iamAuth()).toBe(false);
	});

	it("clears it when the PROJECT moves and the database inherits the placement", () => {
		// The node's own provider is null, so its effective cloud is the project's. Normalizing only
		// the node that changed would miss every database on the canvas.
		seed([
			projectNode("aws"),
			dbNode(null, { engine_family: "mysql", iam_auth: true }),
		]);
		useCanvasStore.getState().setNodeIdentity(PROJECT_NODE_ID, null, "alibaba");
		expect(iamAuth()).toBe(false);
	});

	it("leaves it alone when the new cloud can honor it", () => {
		seed([
			projectNode("aws"),
			dbNode("aws", { engine_family: "postgres", iam_auth: true }),
		]);
		useCanvasStore.getState().setNodeIdentity(DB_ID, null, "gcp");
		expect(iamAuth()).toBe(true);
	});

	it("clears it on an engine switch, not only a cloud switch", () => {
		// No engine-axis case is reachable today — all three honoring clouds are live on both
		// engines — so this drives the engine leg through the cloud that has only one honorable
		// engine at all. The pure-function coverage is in tests/lib/cloud-providers/keyless.test.ts.
		seed([
			projectNode("hetzner"),
			dbNode("hetzner", { engine_family: "postgres", iam_auth: false }),
		]);
		useCanvasStore.getState().updateNodeConfig(DB_ID, { iam_auth: true });
		expect(iamAuth()).toBe(false);
	});

	it("does not touch a database that never asked for keyless", () => {
		seed([
			projectNode("aws"),
			dbNode("aws", { engine_family: "postgres", iam_auth: false }),
		]);
		useCanvasStore.getState().setNodeIdentity(DB_ID, null, "hetzner");
		expect(iamAuth()).toBe(false);
	});
});
