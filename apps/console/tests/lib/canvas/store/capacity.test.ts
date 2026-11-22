// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4320: Azure Cosmos DB is serverless only, and the Capacity mode card no longer offers
// `provisioned` there — so an Azure table saved as `provisioned` before the ruling could not be
// cleared by hand. The store normalises it the way it normalises a withdrawn WAF (#1841): the DESIRED
// graph is rewritten, the baseline is not, so the rewrite is a staged change the user can see and
// save. A project with nothing to rewrite must still open clean.

import { beforeEach, describe, expect, it } from "vitest";
import { board } from "@/lib/canvas/store/board";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { boardNodes, isBoardDirty, seedBoard } from "@/tests/fixtures/canvas/board";
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
	const n = boardNodes().find((x) => x.id === TABLE_ID);
	return n?.data.kind === "nosql" ? n.data.config.capacity_mode : undefined;
}

beforeEach(() => {
	seedBoard([]);
});

describe("capacity mode follows what the table's cloud can build", () => {
	it("rewrites a legacy Azure `provisioned` table at load, as a staged change", () => {
		board.load({ nodes: [projectNode("azure"), tableNode("provisioned")] });
		expect(heldMode()).toBe("on_demand");
		expect(isBoardDirty()).toBe(true);
		// The baseline still says what the server holds, so the pending-changes bar shows the rewrite.
		const base = board.document.getState().baseline.find((x) => x.id === TABLE_ID);
		expect(base?.data.kind === "nosql" ? base.data.config.capacity_mode : undefined).toBe("provisioned");
	});

	it("opens a project with nothing to rewrite clean", () => {
		board.load({ nodes: [projectNode("aws"), tableNode("provisioned")] });
		expect(heldMode()).toBe("provisioned");
		expect(isBoardDirty()).toBe(false);
	});
});
