// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector on one design node. Pinned: it opens on Settings; a service also has Connections;
// every edit lands in the DOCUMENT as an undo step and nothing here is a commit button; Status is
// read-only; a member of a collection has a way back; and the review view's "Go to" puts the caret
// in the field it names.
//
// The field renderer and the bindings editor are stubbed: they are another unit's, and what is
// under test is what this subject hands them and what it does with what they hand back.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import { NodeSubject } from "@/components/design-project/canvas/inspector-shell/node-subject";
import type { NodeStatus } from "@/lib/canvas/node-status";
import { board } from "@/lib/canvas/store/board";
import { useNode } from "@/lib/canvas/store/use-board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const { nodeStatus } = vi.hoisted(() => ({
	nodeStatus: { current: null as NodeStatus | null },
}));

vi.mock("@/lib/canvas/node-status", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/canvas/node-status")>();
	return {
		...original,
		useNodeStatus: (id: string) => {
			const resolved = original.useNodeStatus(id);
			return nodeStatus.current ?? resolved;
		},
	};
});
vi.mock("@/components/design-project/canvas/inspector/use-node-capabilities", () => ({
	useNodeCapabilities: () => ({}),
}));
vi.mock("@/components/design-project/canvas/inspector/config-fields", () => ({
	ConfigFields: ({
		schema,
		onChange,
	}: {
		schema: { sections: { fields: { key: string; type: string }[] }[] };
		onChange: (patch: Record<string, unknown>) => void;
	}) => (
		<div>
			<p data-testid="field-keys">
				{schema.sections.flatMap((s) => s.fields.map((f) => f.key)).join(",")}
			</p>
			<input aria-label="First field" />
			<input aria-label="Port" data-field-key="port" />
			<button type="button" onClick={() => onChange({ backup_retention_days: 21 })}>
				Edit a field
			</button>
		</div>
	),
}));
vi.mock("@/components/design-project/canvas/inspector/bindings-field", () => ({
	BindingsField: ({
		value,
		onChange,
	}: {
		value: unknown[];
		onChange: (next: unknown[]) => void;
	}) => (
		<div>
			<p>bindings: {value.length}</p>
			<button
				type="button"
				onClick={() =>
					onChange([...value, { target: { kind: "database", name: "orders" }, inject: [] }])
				}
			>
				Add connection
			</button>
		</div>
	),
}));

/** A design node of `kind` named `name`. */
function designNode(kind: NodeKind, name: string): CanvasNode {
	return {
		id: `${kind}-${name}`,
		type: kind,
		position: { x: 0, y: 0 },
		data: {
			kind,
			config: { ...NODE_REGISTRY[kind].defaultData("aws"), name },
			cloud_identity_id: null,
			provider: "aws",
		},
	} as unknown as CanvasNode;
}

/** What the rail does for a design node: hand the subject the document's node, as it changes. */
function Host({ id }: { id: string }) {
	const node = useNode(id);
	return node ? <NodeSubject node={node} /> : null;
}

/** Seeds the board with `nodes` as the saved design and renders the subject for the first. */
function renderSubject(first: CanvasNode, ...rest: CanvasNode[]) {
	const nodes = [first, ...rest];
	useCanvasStore.setState({ nodes, baseline: nodes });
	return render(<Host id={first.id} />);
}

/** The saved-or-drafted config of a node in the document. */
function configOf(id: string): Record<string, unknown> {
	const node = board.document.getState().designNodes.find((n) => n.id === id);
	return { ...node?.data.config };
}

beforeEach(() => {
	nodeStatus.current = null;
	useCanvasStore.getState().reset();
});

describe("NodeSubject", () => {
	it("opens on Settings, with Status beside it, and says what the node is", () => {
		renderSubject(designNode("database", "orders"));
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Settings", "Status"]);
		expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("orders");
		expect(screen.getByText(NODE_REGISTRY.database.eyebrow)).toBeInTheDocument();
		expect(screen.getByTestId("field-keys")).toBeInTheDocument();
	});

	it("has no commit button: nothing is named Save, Install or Update", () => {
		renderSubject(designNode("database", "orders"));
		const names = screen
			.getAllByRole("button")
			.map((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim());
		expect(names.filter((name) => /^(save|install|update)\b/i.test(name))).toEqual([]);
	});

	it("a field edit is staged in the document, and is one undo step", async () => {
		const user = userEvent.setup();
		renderSubject(designNode("database", "orders"));
		const saved = configOf("database-orders").backup_retention_days;
		const steps = board.document.getState().history.past.length;

		await user.click(screen.getByRole("button", { name: "Edit a field" }));
		expect(configOf("database-orders")).toMatchObject({ backup_retention_days: 21 });
		expect(board.document.getState().history.past).toHaveLength(steps + 1);

		act(() => {
			board.document.getState().undo();
		});
		expect(configOf("database-orders").backup_retention_days).toBe(saved);
	});

	it("renaming writes the name to the document, lower-cased, as it is typed", async () => {
		const user = userEvent.setup();
		renderSubject(designNode("database", "orders"));
		await user.type(screen.getByRole("textbox", { name: "Name" }), "X");
		expect(configOf("database-orders")).toMatchObject({ name: "ordersx" });
	});

	it("gives a service a Connections view, and keeps its bindings out of Settings", async () => {
		const user = userEvent.setup();
		renderSubject(designNode("service", "api"), designNode("database", "orders"));
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
			"Settings",
			"Connections",
			"Status",
		]);
		expect(screen.getByTestId("field-keys").textContent?.split(",")).not.toContain("bindings");

		await user.click(screen.getByRole("tab", { name: "Connections" }));
		expect(screen.getByText("bindings: 0")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Add connection" }));

		expect(configOf("service-api")).toMatchObject({
			bindings: [{ target: { kind: "database", name: "orders" }, inject: [] }],
		});
		expect(screen.getByText("bindings: 1")).toBeInTheDocument();
	});

	it("opens on the tab the view store asks for", () => {
		const node = designNode("service", "api");
		useCanvasStore.setState({ nodes: [node], baseline: [node] });
		act(() => board.view.getState().setSubject({ kind: "node", id: node.id }, "connections"));
		renderSubject(node);
		expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
	});

	it("Status says the state, and says a resource is not priced rather than showing a zero", async () => {
		const user = userEvent.setup();
		renderSubject(designNode("database", "orders"));
		await user.click(screen.getByRole("tab", { name: "Status" }));
		expect(screen.getByRole("heading", { name: "State" })).toBeInTheDocument();
		expect(screen.getByText(/Not priced yet/)).toBeInTheDocument();
		expect(screen.queryByTestId("field-keys")).not.toBeInTheDocument();
	});

	it("Status lists what the deploy produced, what drifted and what it costs", async () => {
		nodeStatus.current = {
			state: "live",
			drift: [{ address: "aws_db_instance.orders", type: "aws_db_instance", kind: "modified" }],
			outputs: [{ label: "Endpoint", value: "orders.example.internal" }],
			monthlyCost: 12.4,
			costLines: [{ address: "aws_db_instance.orders", monthlyCost: 12.4 }],
			deployed: true,
		};
		const user = userEvent.setup();
		renderSubject(designNode("database", "orders"));
		expect(screen.getByText("1 drifted")).toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: "Status" }));
		expect(screen.getByText("orders.example.internal")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Drift" })).toBeInTheDocument();
		expect(screen.getAllByText("$12.40/mo").length).toBeGreaterThan(0);
	});

	it("a node that needs setup offers the way to its Settings from another view", async () => {
		nodeStatus.current = {
			state: "needs-setup",
			message: "Port is required",
			drift: [],
			outputs: [],
			monthlyCost: null,
			costLines: [],
			deployed: false,
		};
		const user = userEvent.setup();
		renderSubject(designNode("database", "orders"));
		expect(screen.getByText("Port is required")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: "Status" }));
		await user.click(screen.getByRole("button", { name: "Open settings" }));
		expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
	});

	it("a member of a collection has a way back to it", async () => {
		const user = userEvent.setup();
		renderSubject(designNode("secret", "api-key"));
		await user.click(screen.getByRole("button", { name: "Secrets" }));
		expect(board.view.getState().subject).toEqual({ kind: "collection", nodeKind: "secret" });
	});

	it("'Go to' puts the caret in the field it names, and is spent once", () => {
		const node = designNode("database", "orders");
		renderSubject(node);
		act(() => board.view.getState().focusField(node.id, "port"));
		expect(screen.getByLabelText("Port")).toHaveFocus();
		expect(board.view.getState().focus).toBeNull();
	});

	it("'Go to' a field the renderer does not mark lands on the first control of Settings", () => {
		const node = designNode("database", "orders");
		renderSubject(node);
		act(() => board.view.getState().focusField(node.id, "engine_version"));
		expect(screen.getByLabelText("First field")).toHaveFocus();
	});
});
