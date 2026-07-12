// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanvasContext } from "../canvas-context";
import { catalogTools, composeTools } from "./compose";
import { connectTools } from "./connect";
import { docsTools } from "./docs";
import { operationTools } from "./operations";
import { readTools } from "./read";
import { externalToolsOnly } from "./registry";
import { scannerTools } from "./scanner";
import { visualizeTools } from "./visualize";
import { widgetTools } from "./widgets";

/** Agent chat mode: Ask = read-only; Act = may propose plan/deploy operations. */
export type AgentMode = "ask" | "act";

/**
 * The PROJECT-PAGE assistant's tool SSOT — the full surface for driving the MVP "A"
 * loop on a single project: catalog lookups + the read surface + repo scanning +
 * canvas-bound design proposals (compose) + HITL plan/deploy proposals (operations).
 * Every tool is PDP-gated; all mutations are proposals (apply on the canvas / approve
 * to run). `ctx` is the live canvas snapshot when the canvas is active, else undefined
 * (compose tools degrade gracefully).
 */
export function buildProjectAgentTools(ctx: CanvasContext | undefined) {
	return {
		...catalogTools(),
		...readTools(),
		...docsTools(),
		...connectTools(),
		...scannerTools(),
		...composeTools(ctx),
		...operationTools(),
		...visualizeTools(),
		...widgetTools(),
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
		...docsTools(),
		...connectTools(),
		...scannerTools(),
		...(opts?.mode === "act" ? operationTools() : {}),
		...visualizeTools(),
		...widgetTools(),
	};
}

/**
 * The **external** tool projection for the MCP server: the same defs as the in-app
 * agent, filtered to the read-only / PDP-gated subset (audience external|both —
 * see `registry.ts`). HITL proposals, canvas tools, and job-queuing writes are
 * excluded — the MCP surface is read-only at launch. This is the single seam the
 * remote MCP route should call so the external surface can never drift from the
 * in-app tool definitions.
 */
export function buildExternalAgentTools() {
	return externalToolsOnly(buildAgentTools({ mode: "act" }));
}
