"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useAgentChat } from "@/components/agent/use-agent-chat";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { graphToForm } from "../graph/graph-to-form";

/**
 * Module-stable body builder — reads the live canvas (core provider + graph→form
 * snapshot + node ids) from the global store at SEND time. Stable identity keeps
 * the transport memo from rebuilding each render.
 */
function prepareCanvasBody() {
	const store = useCanvasStore.getState();
	const canvas: CanvasContext = {
		provider:
			(store.getEffectiveProvider(PROJECT_NODE_ID) as CloudProviderSlug) ??
			"aws",
		form: graphToForm(store.nodes),
		nodes: store.nodes.map((n) => ({
			id: n.id,
			kind: n.data.kind,
			name: (n.data.config.name ?? n.data.config.project_name) as
				| string
				| undefined,
		})),
	};
	return { canvas };
}

/**
 * Ask AI chat — the canvas surface of the shared `useAgentChat`. Each request
 * injects the live canvas so the model reasons about current state, estimates
 * cost, and targets existing nodes.
 */
export function useAskAi() {
	return useAgentChat({
		api: "/api/design-spec/ask-ai",
		prepareBody: prepareCanvasBody,
	});
}
