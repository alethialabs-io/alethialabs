"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useMemo } from "react";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import type { AssistantView } from "@/lib/ai/project-assistant-body";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID, selectInspectorNodeId, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { configName } from "@/components/design-project/canvas/graph/node-config";

/**
 * Reads the live canvas (shared global store) at SEND time so the assistant reasons
 * about the current design. Returns `undefined` when the canvas is empty (form-only
 * view) — the route degrades gracefully (summarizeCanvas(undefined) = "empty").
 */
export function snapshotCanvas(): CanvasContext | undefined {
	const store = useCanvasStore.getState();
	if (store.nodes.length === 0) return undefined;
	return {
		provider:
			store.getEffectiveProvider(PROJECT_NODE_ID) ?? "aws",
		form: graphToForm(store.nodes),
		nodes: store.nodes.map((n) => ({
			id: n.id,
			kind: n.data.kind,
			name: configName(n.data),
		})),
		// What the user is LOOKING AT. Without this, "make this bigger" is unresolvable — the
		// assistant could see the whole design but had no idea which node you had selected, so a
		// pronoun could only ever be guessed at.
		selectedIds: store.selectedIds,
		inspectorNodeId: selectInspectorNodeId(store),
	};
}

/**
 * The route surfaces `snapshotView` can name. Anything else (a settings sub-page, a route added
 * after this list) reports `other` — the full `path` rides along, so an unnamed surface degrades
 * to "the model sees the URL" rather than to a wrong answer.
 */
const SURFACES = [
	"architecture",
	"environments",
	"jobs",
	"clusters",
	"settings",
	"usage",
] as const;

/** Narrows a raw path segment to a known surface (`other` when it names none). */
function toSurface(segment: string | undefined): AssistantView["surface"] {
	return SURFACES.find((s) => s === segment) ?? "other";
}

/**
 * Reads WHERE THE USER IS at SEND time — the route path, the surface it lands on, and the card
 * open on the workspace rail. The canvas snapshot says what the design contains and which node is
 * selected; this says which page the question was asked from, so "what's going on here" can be
 * answered about the Jobs page as readily as about the board.
 *
 * A pure function (not a hook), like `snapshotCanvas` beside it, so `prepareBody` can call it as
 * the request body is built rather than closing over a value that went stale two navigations ago.
 * Returns `path: ""` outside the browser (SSR / a test with no DOM) rather than throwing.
 */
export function snapshotView(): AssistantView {
	const path = typeof window === "undefined" ? "" : window.location.pathname;
	const segments = path.split("/").filter(Boolean);
	const view: AssistantView = {
		path,
		surface: toSurface(segments.at(-1)),
	};
	// The card is only reported ON Architecture, and the gate is not tidiness. `useCanvasStore` is
	// a global store whose `reset()` runs only after a successful CREATE, so leaving the canvas
	// clears neither `card` nor `nodes`. A question asked from the Jobs page — or from an org route
	// with the project panel still open — shipped `openCard: {kind:"inspector", name:"prod-postgres"}`
	// for a card the user cannot see, possibly from a DIFFERENT project's board, since the store is
	// re-seeded only when a canvas mounts.
	//
	// The whole point of naming the node is pronoun resolution, so pointing "this database" at a
	// stale card is worse than omitting it: the model answers confidently about the wrong thing
	// instead of asking. Found in review.
	if (view.surface !== "architecture") return view;
	const card = useCanvasStore.getState().card;
	if (!card) return view;
	if (card.kind !== "inspector") return { ...view, openCard: { kind: card.kind } };
	// An inspector card is about ONE node — name it, so a pronoun ("this database") resolves to
	// the thing on the rail rather than to whatever the model guesses.
	const node = useCanvasStore
		.getState()
		.nodes.find((n) => n.id === card.nodeId);
	return {
		...view,
		openCard: {
			kind: card.kind,
			...(node ? { name: configName(node.data) } : {}),
		},
	};
}

/**
 * Stable `prepareBody` factory for a project's assistant transport — injects the
 * project id + a live canvas snapshot (read fresh at send time). A plain factory (not
 * a hook) so the shared Elench conversation can select it by context without breaking
 * the rules of hooks.
 */
export function projectPrepareBody(projectId: string) {
	return () => ({ projectId, canvas: snapshotCanvas() });
}

/**
 * The project-page assistant — the shared `useAgentChat` wired to the project's
 * assistant route. Each request injects the project id + a live canvas snapshot so
 * the model can read the design, scan repos, propose changes, and propose plan/deploy.
 */
export function useProjectAssistant(projectId: string) {
	const prepareBody = useMemo(
		() => () => ({ projectId, canvas: snapshotCanvas() }),
		[projectId],
	);
	return useAgentChat({
		api: `/api/projects/${projectId}/assistant`,
		prepareBody,
	});
}
