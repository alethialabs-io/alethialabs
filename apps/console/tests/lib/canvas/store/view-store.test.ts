// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The view store (#6764): the inspector's subject, the legacy rail card it stays in step with, and
// what survives a change to the node set.

import { describe, expect, it } from "vitest";
import {
	cardOfSubject,
	createViewStore,
	keepCard,
	keepSubject,
	subjectOfCard,
	tabOfCard,
} from "@/lib/canvas/store/view-store";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { databaseNode, projectNode } from "@/tests/fixtures/canvas/nodes";

/** A secret named `name`: the collection kind. */
function secretNode(name: string): CanvasNode {
	return {
		id: `secret-${name}`,
		type: "secret",
		position: { x: 0, y: 0 },
		data: { kind: "secret", config: { name }, cloud_identity_id: null, provider: null },
	} as unknown as CanvasNode;
}

const SECRET: NodeKind = "secret";

describe("subject and card", () => {
	it("every legacy card maps onto a subject", () => {
		expect(subjectOfCard(null)).toBeNull();
		expect(subjectOfCard({ kind: "inspector", nodeId: "database-orders" })).toEqual({
			kind: "node",
			id: "database-orders",
		});
		expect(subjectOfCard({ kind: "inspector", nodeId: "collection:secret" })).toEqual({
			kind: "collection",
			nodeKind: "secret",
		});
		expect(subjectOfCard({ kind: "addon", itemId: "grafana" })).toEqual({
			kind: "node",
			id: "addon-grafana",
		});
		expect(subjectOfCard({ kind: "chart-scan", chartId: "pg" })).toEqual({ kind: "node", id: "chart-pg" });
		expect(subjectOfCard({ kind: "env-settings" })).toEqual({ kind: "environment" });
		expect(subjectOfCard({ kind: "activity" })).toEqual({ kind: "environment" });
		expect(subjectOfCard({ kind: "iac-scan" })).toEqual({ kind: "environment" });
	});

	it("a card that names a tab opens on it", () => {
		expect(tabOfCard({ kind: "activity" })).toBe("activity");
		expect(tabOfCard({ kind: "iac-scan" })).toBe("sources");
		expect(tabOfCard({ kind: "chart-scan", chartId: "pg" })).toBe("status");
		expect(tabOfCard({ kind: "env-settings" })).toBeNull();
		expect(tabOfCard(null)).toBeNull();
	});

	it("every subject maps onto the card that shows it", () => {
		expect(cardOfSubject(null, null)).toBeNull();
		expect(cardOfSubject({ kind: "node", id: "n" }, null)).toEqual({ kind: "inspector", nodeId: "n" });
		expect(cardOfSubject({ kind: "collection", nodeKind: SECRET }, null)).toEqual({
			kind: "inspector",
			nodeId: "collection:secret",
		});
		expect(cardOfSubject({ kind: "environment" }, null)).toEqual({ kind: "env-settings" });
		expect(cardOfSubject({ kind: "environment" }, "activity")).toEqual({ kind: "activity" });
		expect(cardOfSubject({ kind: "environment" }, "sources")).toEqual({ kind: "iac-scan" });
		expect(cardOfSubject({ kind: "selection", ids: ["a", "b"] }, null)).toBeNull();
	});

	it("setting a subject sets its card, and opening a card sets its subject", () => {
		const view = createViewStore();
		view.getState().setSubject({ kind: "environment" }, "activity");
		expect(view.getState().card).toEqual({ kind: "activity" });
		expect(view.getState().tab).toBe("activity");

		view.getState().openCard({ kind: "inspector", nodeId: "database-orders" });
		expect(view.getState().subject).toEqual({ kind: "node", id: "database-orders" });
		expect(view.getState().tab).toBeNull();

		view.getState().setSubject(null);
		expect(view.getState().card).toBeNull();
		expect(view.getState().subject).toBeNull();
	});

	it("a detour remembers the card it replaced, and going back returns to it", () => {
		const view = createViewStore();
		view.getState().openCard({ kind: "inspector", nodeId: "collection:secret" });
		view.getState().openCard({ kind: "env-settings" }, { back: true });
		expect(view.getState().cardBack).toEqual({ kind: "inspector", nodeId: "collection:secret" });

		view.getState().goBackCard();
		expect(view.getState().card).toEqual({ kind: "inspector", nodeId: "collection:secret" });
		expect(view.getState().subject).toEqual({ kind: "collection", nodeKind: "secret" });
		expect(view.getState().cardBack).toBeNull();

		// Nothing to go back to: nothing changes.
		view.getState().goBackCard();
		expect(view.getState().card).toEqual({ kind: "inspector", nodeId: "collection:secret" });
	});

	it("focusField opens the node's Configure tab with the field to focus", () => {
		const view = createViewStore();
		view.getState().focusField("database-orders", "port");
		expect(view.getState().subject).toEqual({ kind: "node", id: "database-orders" });
		expect(view.getState().tab).toBe("configure");
		expect(view.getState().focus).toEqual({ nodeId: "database-orders", path: "port" });
		view.getState().clearFocus();
		expect(view.getState().focus).toBeNull();
		view.getState().setTab("status");
		expect(view.getState().tab).toBe("status");
	});
});

describe("after the node set changed", () => {
	const nodes = [projectNode(), databaseNode("orders"), secretNode("a")];

	it("keepCard keeps a non-inspector card, and an inspector only while its node is there", () => {
		expect(keepCard({ kind: "activity" }, [])).toEqual({ kind: "activity" });
		expect(keepCard({ kind: "inspector", nodeId: "database-orders" }, nodes)).not.toBeNull();
		expect(keepCard({ kind: "inspector", nodeId: "database-gone" }, nodes)).toBeNull();
		expect(keepCard({ kind: "inspector", nodeId: "collection:secret" }, nodes)).not.toBeNull();
		expect(keepCard({ kind: "inspector", nodeId: "collection:secret" }, [projectNode()])).toBeNull();
	});

	it("keepSubject follows the same rule, and trims a multi-selection to what is left", () => {
		expect(keepSubject(null, nodes)).toBeNull();
		expect(keepSubject({ kind: "environment" }, [])).toEqual({ kind: "environment" });
		expect(keepSubject({ kind: "node", id: "database-gone" }, nodes)).toBeNull();
		expect(keepSubject({ kind: "collection", nodeKind: SECRET }, nodes)).not.toBeNull();
		expect(keepSubject({ kind: "collection", nodeKind: SECRET }, [projectNode()])).toBeNull();
		expect(keepSubject({ kind: "selection", ids: ["database-orders", "secret-a"] }, nodes)).toEqual({
			kind: "selection",
			ids: ["database-orders", "secret-a"],
		});
		expect(keepSubject({ kind: "selection", ids: ["database-orders", "gone"] }, nodes)).toEqual({
			kind: "selection",
			ids: ["database-orders"],
		});
		expect(keepSubject({ kind: "selection", ids: ["gone"] }, nodes)).toBeNull();
	});

	it("reconcile closes an inspector on a node that is gone and filters the selection", () => {
		const view = createViewStore();
		view.getState().openCard({ kind: "inspector", nodeId: "database-gone" });
		view.getState().setSelection(["database-orders", "database-gone"]);
		view.getState().reconcile(nodes);
		expect(view.getState().card).toBeNull();
		expect(view.getState().subject).toBeNull();
		expect(view.getState().selection).toEqual(["database-orders"]);

		view.getState().reconcile(nodes, { clearSelection: true });
		expect(view.getState().selection).toEqual([]);
	});

	it("reconcile keeps a multi-selection subject, which has no card", () => {
		const view = createViewStore();
		view.getState().setSubject({ kind: "selection", ids: ["database-orders", "gone"] });
		view.getState().reconcile(nodes);
		expect(view.getState().subject).toEqual({ kind: "selection", ids: ["database-orders"] });
	});
});

describe("view preferences and the review view", () => {
	it("toggle connections, hide and show a kind, and the hand tool", () => {
		const view = createViewStore();
		expect(view.getState().showConnections).toBe(true);
		view.getState().toggleConnections();
		expect(view.getState().showConnections).toBe(false);
		view.getState().toggleKindVisibility("database");
		expect(view.getState().hiddenKinds).toEqual(["database"]);
		view.getState().toggleKindVisibility("database");
		expect(view.getState().hiddenKinds).toEqual([]);
		view.getState().setHandTool(true);
		expect(view.getState().handTool).toBe(true);
	});

	it("the review view opens, closes, and keeps what a plan saved", () => {
		const view = createViewStore();
		view.getState().openReview();
		view.getState().setReviewSaved([{ id: "database-orders", op: "modified", kind: "database", name: "orders" }]);
		expect(view.getState().review.open).toBe(true);
		view.getState().closeReview();
		expect(view.getState().review).toEqual({
			open: false,
			saved: [{ id: "database-orders", op: "modified", kind: "database", name: "orders" }],
		});
	});

	it("reset closes the rail and keeps the preferences", () => {
		const view = createViewStore();
		view.getState().toggleConnections();
		view.getState().openCard({ kind: "activity" });
		view.getState().setSelection(["a"]);
		view.getState().setNodeView({ a: { selected: true } });
		view.getState().reset();
		expect(view.getState().card).toBeNull();
		expect(view.getState().selection).toEqual([]);
		expect(view.getState().nodeView).toEqual({});
		expect(view.getState().showConnections).toBe(false);
	});
});
