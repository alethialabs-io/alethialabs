// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A bring-your-own IaC module, RENDERED. The old surface was a takeover: a backdrop-blur sheet over
// the whole graph with one card in the middle. These tests assert the thing that replaced it —
// that the module's resources become real cards, wearing the kind they map to, landing in the right
// zone, priced and drifted by exact address, and read-only.

import { render, screen, within } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BaseNode } from "@/components/design-project/canvas/nodes/base-node";
import { ExternalPanel } from "@/components/design-project/canvas/inspector/external-panel";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { buildIacInventory, parsePlanInventory } from "@/lib/canvas/iac-inventory";
import { zoneForNode } from "@/lib/canvas/zones";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
	type IacEnvironment,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	diffNodes,
	PROJECT_NODE_ID,
	useCanvasStore,
} from "@/lib/stores/use-canvas-store";

/** A plan_result exactly as the runner posts it. */
const PLAN = {
	resource_changes: [
		{
			address: "module.vpc.aws_vpc.this",
			type: "aws_vpc",
			name: "this",
			module_address: "module.vpc",
			change: { actions: ["no-op"] },
		},
		{
			address: "module.vpc.aws_subnet.a",
			type: "aws_subnet",
			name: "a",
			module_address: "module.vpc",
			change: { actions: ["no-op"] },
		},
		{
			address: "module.eks.aws_eks_cluster.main",
			type: "aws_eks_cluster",
			name: "main",
			module_address: "module.eks",
			change: { actions: ["no-op"] },
		},
		// Maps to `secret` — the drift map already knows random_password is how Terraform makes one.
		{
			address: "random_password.db",
			type: "random_password",
			name: "db",
			change: { actions: ["no-op"] },
		},
		// Maps to nothing. Must NOT be dropped: it goes in the honest `Other` card.
		{
			address: "null_resource.hook",
			type: "null_resource",
			name: "hook",
			change: { actions: ["no-op"] },
		},
	],
};

const SOURCE: IacEnvironment["source"] = {
	repoUrl: "https://github.com/acme/infra",
	ref: "main",
	path: "",
	commitSha: "abc123",
	deployedCommitSha: "abc123",
	scanStatus: "done",
	scanOk: true,
	status: "ACTIVE",
	statusMessage: null,
};

const groups = buildIacInventory({ planMembers: parsePlanInventory(PLAN) });

/** Seed the store with the project root + the module's external cards (as setIacNodes would). */
function seed() {
	const root = {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;

	useCanvasStore.setState({ nodes: [root], identities: [], baseline: [] });
	useCanvasStore.getState().setIacNodes(groups);
}

/** The env status the server would return for this module. */
function envStatus(overrides: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
	const components: EnvironmentStatus["components"] = {};
	for (const g of groups) {
		components[`external:${g.key}`] = {
			lifecycle: "ACTIVE",
			message: null,
			drift: [],
		};
	}
	return {
		...EMPTY_ENVIRONMENT_STATUS,
		components,
		iac: { source: SOURCE, groups, costByAddress: {} },
		...overrides,
	};
}

/** The card, as React Flow renders it. `ServiceNode` is a thin wrapper that forwards exactly these
 * two props to `BaseNode` — the ONE data-driven card every registry kind renders through. */
function renderNode(id: string, env: EnvironmentStatus = envStatus()) {
	return render(
		<EnvironmentStatusProvider value={env}>
			<ReactFlowProvider>
				<BaseNode id={id} selected={false} />
			</ReactFlowProvider>
		</EnvironmentStatusProvider>,
	);
}

beforeEach(() => {
	seed();
});

describe("a BYO IaC module becomes cards", () => {
	it("groups the module's resources by kind and module — not one card per resource", () => {
		// Five resources → four cards, and `Other` sorts last. A real module is 50–200 resources; one
		// card each would bury the architecture, which is the whole reason collections exist.
		expect(groups.map((g) => [g.kind, g.module, g.members.length])).toEqual([
			["cluster", "module.eks", 1],
			["network", "module.vpc", 2],
			["secret", "", 1],
			[null, "", 1],
		]);
	});

	it("puts the cards in the SAME zones a template env uses — no new zone logic", () => {
		// This is what makes a BYO env read as an architecture: the customer's own aws_vpc draws
		// itself into the VPC region and their aws_eks_* inside the cluster.
		expect(zoneForNode("network", "aws")).toBe("network");
		expect(zoneForNode("cluster", "aws")).toBe("cluster");
		// The `Other` bucket maps to no kind, so it has no zone — it sits outside both regions rather
		// than being placed somewhere it may not belong.
		const other = groups.find((g) => g.kind === null);
		expect(other).toBeDefined();
	});

	it("renders each group as a card wearing its MAPPED kind's face", () => {
		const network = groups.find((g) => g.kind === "network");
		renderNode(`external-${network!.key}`);
		// The eyebrow is the kind's, not a generic "External" — that is what makes it read as an
		// architecture. The dashed rule (asserted below) is what keeps it honest about ownership.
		expect(screen.getByText("Network")).toBeInTheDocument();
		// Title = the Terraform module the resources live in.
		expect(screen.getByText("module.vpc")).toBeInTheDocument();
	});

	it("draws the card DASHED — Alethia does not own its definition", () => {
		const network = groups.find((g) => g.kind === "network");
		const { container } = renderNode(`external-${network!.key}`);
		expect(container.querySelector(".border-dashed")).not.toBeNull();
	});

	it("says whether the addresses are exact (planned) or merely declared", () => {
		// The honesty fact. A `count = 3` block is one row in a scan and three in a plan.
		const network = groups.find((g) => g.kind === "network");
		renderNode(`external-${network!.key}`);
		expect(screen.getByText("planned")).toBeInTheDocument();
	});

	it("gives unrecognised types an honest Other card rather than dropping them", () => {
		const other = groups.find((g) => g.kind === null);
		renderNode(`external-${other!.key}`);
		expect(screen.getByText("External")).toBeInTheDocument();
		expect(screen.getByText("root module")).toBeInTheDocument();
	});
});

describe("the card's panel — read-only, and joined by exact address", () => {
	function renderPanel(env: EnvironmentStatus) {
		const network = groups.find((g) => g.kind === "network");
		return render(
			<EnvironmentStatusProvider value={env}>
				<ExternalPanel nodeId={`external-${network!.key}`} />
			</EnvironmentStatusProvider>,
		);
	}

	it("lists every resource by its Terraform address — collapsing hides clutter, never content", () => {
		renderPanel(envStatus());
		expect(screen.getByText("module.vpc.aws_vpc.this")).toBeInTheDocument();
		expect(screen.getByText("module.vpc.aws_subnet.a")).toBeInTheDocument();
	});

	it("offers NO editable fields — changing one means editing the customer's Terraform", () => {
		const { container } = renderPanel(envStatus());
		expect(container.querySelector("input")).toBeNull();
		expect(container.querySelector("select")).toBeNull();
	});

	it("prices a resource by its EXACT address", () => {
		renderPanel(
			envStatus({
				iac: {
					source: SOURCE,
					groups,
					costByAddress: { "module.vpc.aws_vpc.this": 12.4 },
				},
			}),
		);
		expect(screen.getByText("$12.40/mo")).toBeInTheDocument();
		// The subnet was never priced. It reads as NOTHING — not $0.00. A fabricated zero is worse
		// than an admitted unknown, because you'd believe it.
		expect(screen.queryByText("$0.00/mo")).toBeNull();
	});

	it("badges drift on the exact resource that drifted", () => {
		// The bug this replaced: drift was attributed through a fuzzy type→kind + name heuristic onto
		// the INERT design rows, so a BYO module's aws_eks_* drift badged a design cluster node that
		// does not exist in the customer's cloud.
		const env = envStatus();
		const network = groups.find((g) => g.kind === "network");
		env.components[`external:${network!.key}`].drift = [
			{ address: "module.vpc.aws_vpc.this", type: "aws_vpc", kind: "modified" },
		];
		renderPanel(env);

		const vpcRow = screen.getByText("module.vpc.aws_vpc.this").closest("li");
		const subnetRow = screen.getByText("module.vpc.aws_subnet.a").closest("li");
		expect(within(vpcRow!).getByText("drifted")).toBeInTheDocument();
		expect(within(subnetRow!).queryByText("drifted")).toBeNull();
	});
});

describe("external cards are out-of-band", () => {
	it("never enter the Deploy diff — the design does not own them", () => {
		// If a card the design doesn't own showed up as a staged change, the Deploy button would lie:
		// it would offer to deploy resources whose definition lives in the customer's repo.
		const { baseline, nodes } = useCanvasStore.getState();
		const changes = diffNodes(baseline, nodes);
		expect(changes.filter((c) => c.kind === "external")).toHaveLength(0);
	});

	it("are not deletable — a stray Backspace must not pretend to remove a customer's resource", () => {
		const nodes = useCanvasStore.getState().nodes.filter((n) => n.data.kind === "external");
		expect(nodes).toHaveLength(4);
		expect(nodes.every((n) => n.deletable === false)).toBe(true);
	});

	it("keep their position across a status poll — a dragged card must not snap back", () => {
		// setIacNodes is driven by the environment-status query, which POLLS (every 30s; every 4s
		// mid-deploy). Rebuilding the nodes from scratch each time yanked every card back to the
		// default grid — repeatedly, while the user was trying to arrange the board.
		const id = `external-${groups[0].key}`;
		const moved = { x: 1234, y: 567 };
		useCanvasStore.setState({
			nodes: useCanvasStore
				.getState()
				.nodes.map((n) => (n.id === id ? { ...n, position: moved } : n)),
		});

		// The next poll delivers the same groups (nothing changed server-side).
		useCanvasStore.getState().setIacNodes(groups);

		expect(useCanvasStore.getState().nodes.find((n) => n.id === id)?.position).toEqual(moved);
	});

	it("still refresh their CONTENT on a poll — the position is remembered, the data is not", () => {
		// The other half of the contract: remembering positions must not freeze the card's facts, or a
		// new plan's resources would never reach the board.
		const id = `external-${groups[0].key}`;
		useCanvasStore
			.getState()
			.setIacNodes(groups.map((g) => (g.key === groups[0].key ? { ...g, members: [] } : g)));
		const after = useCanvasStore.getState().nodes.find((n) => n.id === id);
		expect((after?.data.config as { members: unknown[] }).members).toHaveLength(0);
	});
});
