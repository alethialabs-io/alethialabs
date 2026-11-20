// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marks a card carries and the sentence a screen reader hears for it (#6835). The design system
// is grayscale, so each mark is asserted as a SHAPE and a WORD — a flag with its text, a triangle
// with its sentence — and the spoken description is asserted to say the same things.

import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lodState = vi.hoisted(() => ({
	current: "full" as "glyph" | "compact" | "full",
}));
vi.mock("@/lib/canvas/use-canvas-lod", () => ({
	useCanvasLod: () => lodState.current,
	LOD_THRESHOLD: { glyph: 0.5, compact: 0.85 },
}));

import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { BaseNode } from "@/components/design-project/canvas/nodes/base-node";
import {
	BoardMarksContext,
	describeCard,
	pendingSummary,
	type BoardMarks,
	type PendingMarkOp,
} from "@/components/design-project/canvas/nodes/card-marks";
import { CollectionNode } from "@/components/design-project/canvas/nodes/collection-node";
import {
	boardCardName,
	cardDescriptionId,
} from "@/components/design-project/canvas/nodes/node-name";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { buildRenderNodes, collectionNodeId } from "@/lib/canvas/collections";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	chartNode,
	databaseNode,
	externalNode,
	projectNode,
	serviceNode,
} from "@/tests/fixtures/canvas/nodes";
import { awsDatabaseNode, awsProjectNode, secretNode } from "./fixtures";

const ORDERS = "database-orders";

/** The board's marks, as `CanvasFlow` would publish them. */
function marksOf(
	pending: [string, PendingMarkOp][] = [],
	connections: [string, string[]][] = [],
): BoardMarks {
	return { pending: new Map(pending), connections: new Map(connections) };
}

/** One card on a board that holds `nodes`, with `marks` in scope. */
function renderCard(
	nodes: CanvasNode[],
	id: string,
	marks: BoardMarks = marksOf(),
	env: Partial<EnvironmentStatus> = {},
) {
	useCanvasStore.setState({ nodes, identities: [], baseline: [] });
	return render(
		<ReactFlowProvider>
			<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...env }}>
				<BoardMarksContext.Provider value={marks}>
					<BaseNode id={id} />
				</BoardMarksContext.Provider>
			</EnvironmentStatusProvider>
		</ReactFlowProvider>,
	);
}

/** The text of the element a card's wrapper points at with `aria-describedby`. */
function descriptionOf(id: string): string {
	return document.getElementById(cardDescriptionId(id))?.textContent ?? "";
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	lodState.current = "full";
});

describe("the pending-change mark", () => {
	it("a new card wears a flag reading New, and says so", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS, marksOf([[ORDERS, "new"]]));

		const flag = screen.getByTestId("pending-mark");
		expect(flag).toHaveAttribute("data-op", "new");
		expect(flag).toHaveTextContent("+New");
		expect(descriptionOf(ORDERS)).toContain("New, not saved yet.");
	});

	it("an edited card wears a flag reading Edited, and says so", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS, marksOf([[ORDERS, "modified"]]));

		expect(screen.getByTestId("pending-mark")).toHaveTextContent("~Edited");
		expect(descriptionOf(ORDERS)).toContain("Edited, not saved yet.");
	});

	it("a card with nothing pending wears no flag and says nothing about one", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS);

		expect(screen.queryByTestId("pending-mark")).not.toBeInTheDocument();
		expect(descriptionOf(ORDERS)).not.toContain("not saved");
	});

	it.each(["compact", "glyph"] as const)("keeps the flag at the %s tier", (tier) => {
		lodState.current = tier;
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS, marksOf([[ORDERS, "new"]]));

		// The word is still there as text at every tier; only its drawing changes.
		expect(screen.getByTestId("pending-mark")).toHaveTextContent("New");
		expect(descriptionOf(ORDERS)).toContain("New, not saved yet.");
	});

	it("pendingSummary counts each kind of change in words", () => {
		expect(pendingSummary(["new", "modified", "new"])).toBe("2 new, 1 edited");
		expect(pendingSummary(["modified"])).toBe("1 edited");
		expect(pendingSummary([])).toBe("");
	});
});

describe("the validation problem mark", () => {
	/** A service bound to a database that is not on the board: the fail-closed binding problem. */
	const dangling = () => [
		projectNode(),
		serviceNode("api", [{ target: { kind: "database", name: "gone" }, inject: [] }]),
	];
	const PROBLEM = `Binds to database "gone", which isn't on the canvas. Add it or remove the binding.`;

	it("shows the problem in its own words beside a triangle, and says it", () => {
		renderCard(dangling(), "service-api");

		const mark = screen.getByTestId("problem-mark");
		expect(mark).toHaveTextContent(`Problem: ${PROBLEM}`);
		expect(mark.querySelector("svg")).not.toBeNull();
		expect(descriptionOf("service-api")).toContain(
			`Problem: Binds to database "gone", which isn't on the canvas. Add it or remove the binding.`,
		);
	});

	it.each(["compact", "glyph"] as const)("keeps the triangle and the sentence at the %s tier", (tier) => {
		lodState.current = tier;
		renderCard(dangling(), "service-api");

		const mark = screen.getByTestId("problem-mark");
		expect(mark).toHaveAttribute("title", PROBLEM);
		expect(mark).toHaveTextContent(PROBLEM);
	});

	it("a complete card shows no problem", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS);

		expect(screen.queryByTestId("problem-mark")).not.toBeInTheDocument();
		expect(descriptionOf(ORDERS)).not.toContain("Problem");
	});
});

describe("what a screen reader hears for a card", () => {
	it("says the status, and what the card is connected to", () => {
		renderCard(
			[awsProjectNode(), awsDatabaseNode("orders")],
			ORDERS,
			marksOf([], [[ORDERS, ["Service api", "Service worker"]]]),
			{ components: { "database:orders": { lifecycle: "ACTIVE", message: null, drift: [] } } },
		);

		expect(descriptionOf(ORDERS)).toBe(
			"Status: Live. Connected to Service api and Service worker.",
		);
	});

	it("says a card with no connection is not connected", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS);

		expect(descriptionOf(ORDERS)).toBe("Status: Ready. Not connected.");
	});

	it("a deployed card shows the word Live beside its dot", () => {
		renderCard([awsProjectNode(), awsDatabaseNode("orders")], ORDERS, marksOf(), {
			components: { "database:orders": { lifecycle: "ACTIVE", message: null, drift: [] } },
		});

		// Visible, not only present: "deployed" and "never deployed" are not the same silent dot.
		const label = screen.getByText("Live");
		expect(label.parentElement?.className ?? "").not.toContain(":hidden");
	});

	it("describeCard puts the facts in one order and ends each as a sentence", () => {
		expect(
			describeCard({
				status: "Failed",
				pending: "Edited, not saved yet",
				problem: "Port is required.",
				notes: ["", "2 drifted"],
				connections: ["Service api"],
			}),
		).toBe(
			"Status: Failed. Edited, not saved yet. Problem: Port is required. 2 drifted. Connected to Service api.",
		);
	});
});

describe("the name the focused element carries", () => {
	it("is the card's kind and name for a design node", () => {
		expect(boardCardName(databaseNode("orders"))).toBe("Database orders");
		expect(boardCardName(serviceNode("api", []))).toBe("Service api");
	});

	it("is `Helm chart <release>` for a chart", () => {
		expect(boardCardName(chartNode("web"))).toBe("Helm chart web");
	});

	it("reads an external card through the kind its resources map to and the module they live in", () => {
		expect(boardCardName(externalNode("database|"))).toBe("Database root module");
	});

	it("is the plural title and the count for the vault", () => {
		const [vault] = buildRenderNodes([secretNode("a"), secretNode("b"), secretNode("c")], {});
		expect(boardCardName(vault)).toBe("Secrets 3");
	});

	it("a description id is safe to use in an id list whatever the node id holds", () => {
		expect(cardDescriptionId("external-database|module.vpc")).toBe(
			"board-card-description-external-database_module_vpc",
		);
		expect(cardDescriptionId(collectionNodeId("secret"))).not.toContain(":");
	});
});

describe("the vault card's marks", () => {
	/** The vault for `members`, with `marks` in scope. */
	function renderVault(members: CanvasNode[], marks: BoardMarks) {
		useCanvasStore.setState({
			nodes: [awsProjectNode(), ...members],
			identities: [],
			baseline: [],
		});
		return render(
			<ReactFlowProvider>
				<EnvironmentStatusProvider value={EMPTY_ENVIRONMENT_STATUS}>
					<BoardMarksContext.Provider value={marks}>
						<CollectionNode
							id={collectionNodeId("secret")}
							type="collection"
							data={{ kind: "secret", memberIds: members.map((m) => m.id) }}
							selected={false}
							dragging={false}
							draggable
							selectable
							deletable={false}
							zIndex={0}
							isConnectable
							positionAbsoluteX={0}
							positionAbsoluteY={0}
						/>
					</BoardMarksContext.Provider>
				</EnvironmentStatusProvider>
			</ReactFlowProvider>,
		);
	}

	it("counts its members' pending changes on its flag and in its description", () => {
		const members = [secretNode("a"), secretNode("b"), secretNode("c")];
		renderVault(
			members,
			marksOf(
				[
					["secret-a", "new"],
					["secret-b", "modified"],
				],
				[[collectionNodeId("secret"), ["Service api"]]],
			),
		);

		expect(screen.getByTestId("pending-mark")).toHaveTextContent("1 new, 1 edited");
		expect(descriptionOf(collectionNodeId("secret"))).toBe(
			"Status: Ready. 1 new, 1 edited, not saved yet. Connected to Service api.",
		);
	});

	it("carries no group role of its own", () => {
		renderVault([secretNode("a")], marksOf());

		expect(screen.queryByRole("group")).not.toBeInTheDocument();
	});
});
