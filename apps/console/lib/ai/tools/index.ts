// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanvasContext } from "../canvas-context";
import { catalogTools, composeTools } from "./compose";
import { operationTools } from "./operations";
import { readTools } from "./read";
import { scannerTools } from "./scanner";

/** Agent chat mode: Ask = read-only; Act = may propose plan/deploy operations. */
export type AgentMode = "ask" | "act";

/**
 * The design-project (canvas) assistant's tool SSOT — canvas-building tools
 * (compose.ts) + the read surface (read.ts). Every tool wraps a PDP-gated
 * capability; mutations are proposals only. Mutate-via-job tools
 * (plan/deploy/job-control) are deferred — see lib/ai/TOOLS.md.
 */
export function buildProjectAssistantTools(ctx: CanvasContext | undefined) {
	return {
		...composeTools(ctx),
		...readTools(),
	};
}

/**
 * The general Agent page's tool SSOT — the catalog (pure service/options/CIDR
 * lookups) + the full read surface, with NO canvas-bound tools (estimate_cost /
 * propose_changes need a canvas). In **Act** mode it also exposes `propose_operation`
 * (HITL plan/deploy). The same defs will later back an MCP server.
 */
export function buildAgentTools(opts?: { mode?: AgentMode }) {
	return {
		...catalogTools(),
		...readTools(),
		...scannerTools(),
		...(opts?.mode === "act" ? operationTools() : {}),
	};
}
