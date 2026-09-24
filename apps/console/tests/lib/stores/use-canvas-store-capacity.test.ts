// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4320: Azure Cosmos DB is serverless only, and the Capacity mode card no longer offers
// `provisioned` there — so an Azure table saved as `provisioned` before the ruling could not be
// cleared by hand. The store normalises it the way it normalises a withdrawn WAF (#1841): the DESIRED
// graph is rewritten, the baseline is not, so the rewrite is a staged change the user can see and
// save. A project with nothing to rewrite must still open clean.

import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug, NosqlCapacityMode } from "@/lib/cloud-providers";

const TABLE_ID = "nosql-ledger";

/** The project root, carrying the cloud every node inherits. */
function projectNode(provider: CloudProviderSlug | null): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: { project_name: "p", region: "eastus", iac_version: "1", environment_stage: "development" },
			cloud_identity_id: null,
			provider,
		},
	};
}

/** One NoSQL table that inherits its cloud from the project. */
function tableNode(capacity_mode: NosqlCapacityMode): CanvasNode {
	return {
		id: TABLE_ID,
		type: "nosql",
		position: { x: 0, y: 0 },
		data: {
			kind: "nosql",
			config: { name: "ledger", partition_key: "id", capacity_mode },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** The table's capacity mode as the store holds it in the desired graph. */
function heldMode(): unknown {
	const n = useCanvasStore.getState().nodes.find((x) => x.id === TABLE_ID);
	return n?.data.kind === "nosql" ? n.data.config.capacity_mode : undefined;
}

beforeEach(() => {
	useCanvasStore.setState({ nodes: [], baseline: [], past: [], future: [], dirty: false });
});

describe("capacity mode follows what the table's cloud can build", () => {
	it("rewrites a legacy Azure `provisioned` table at load, as a staged change", () => {
		useCanvasStore.getState().setGraph({ nodes: [projectNode("azure"), tableNode("provisioned")] });
		const s = useCanvasStore.getState();
		expect(heldMode()).toBe("on_demand");
		expect(s.dirty).toBe(true);
		// The baseline still says what the server holds, so the pending-changes bar shows the rewrite.
		const base = s.baseline.find((x) => x.id === TABLE_ID);
		expect(base?.data.kind === "nosql" ? base.data.config.capacity_mode : undefined).toBe("provisioned");
	});

	it("opens a project with nothing to rewrite clean", () => {
		useCanvasStore.getState().setGraph({ nodes: [projectNode("aws"), tableNode("provisioned")] });
		expect(heldMode()).toBe("provisioned");
		expect(useCanvasStore.getState().dirty).toBe(false);
	});
});
