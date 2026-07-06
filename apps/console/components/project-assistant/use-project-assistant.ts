"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useMemo } from "react";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";

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
			(store.getEffectiveProvider(PROJECT_NODE_ID) as CloudProviderSlug) ?? "aws",
		form: graphToForm(store.nodes),
		nodes: store.nodes.map((n) => ({
			id: n.id,
			kind: n.data.kind,
			name: (n.data.config.name ?? n.data.config.project_name) as
				| string
				| undefined,
		})),
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
