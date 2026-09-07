// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One tab, two environments, two drafts. The persisted draft used to live under ONE sessionStorage
// key regardless of project or environment, so switching the topbar env showed the previous env's
// unsaved design as if it were this one's. `switchDraftScope` gives each project:environment its own
// slot and refuses to show a slot seeded for another scope.

import { beforeEach, describe, expect, it } from "vitest";
import {
	draftStorageKey,
	PROJECT_NODE_ID,
	switchDraftScope,
	useCanvasStore,
} from "@/lib/stores/use-canvas-store";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

function projectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: { kind: "project", config: { project_name: "p" }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

function dbNode(name: string): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 0, y: 0 },
		data: { kind: "database", config: { name }, cloud_identity_id: null, provider: "aws" },
	} as unknown as CanvasNode;
}

const A = "proj-1:env-a";
const B = "proj-1:env-b";

beforeEach(() => {
	sessionStorage.clear();
	useCanvasStore.getState().reset();
});

describe("switchDraftScope", () => {
	it("an empty slot resets the store and reports nothing restored", async () => {
		useCanvasStore.getState().reseed({ nodes: [projectNode(), dbNode("x")] }, { scope: "old", revision: "1" });
		expect(await switchDraftScope(A)).toBe(false);
		expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
		expect(useCanvasStore.getState().seed).toBeNull();
	});

	it("each scope keeps its own draft, and switching back restores the edit", async () => {
		await switchDraftScope(A);
		useCanvasStore.getState().reseed({ nodes: [projectNode(), dbNode("a")] }, { scope: A, revision: "1" });
		useCanvasStore.getState().updateNodeConfig("database-a", { port: 6543 });

		await switchDraftScope(B);
		useCanvasStore.getState().reseed({ nodes: [projectNode(), dbNode("b")] }, { scope: B, revision: "1" });
		expect(useCanvasStore.getState().nodes.some((n) => n.id === "database-a")).toBe(false);

		expect(sessionStorage.getItem(draftStorageKey(A))).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey(B))).not.toBeNull();

		expect(await switchDraftScope(A)).toBe(true);
		const a = useCanvasStore.getState();
		expect(a.nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID, "database-a"]);
		const db = a.nodes.find((n) => n.id === "database-a");
		expect(db && "port" in db.data.config ? db.data.config.port : null).toBe(6543);
		expect(a.seed).toEqual({ scope: A, revision: "1" });
	});

	it("a slot holding another scope's draft is discarded, never shown", async () => {
		await switchDraftScope(A);
		useCanvasStore.getState().reseed({ nodes: [projectNode(), dbNode("a")] }, { scope: A, revision: "1" });
		// Corrupt: copy A's blob under B's key (what a stale or hand-edited slot looks like).
		const blob = sessionStorage.getItem(draftStorageKey(A));
		expect(blob).not.toBeNull();
		sessionStorage.setItem(draftStorageKey(B), blob ?? "");

		expect(await switchDraftScope(B)).toBe(false);
		expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
	});
});
