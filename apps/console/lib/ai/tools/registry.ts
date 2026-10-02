// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolSet } from "ai";

/**
 * The tool registry's exposure SSOT (elench A2/A5).
 *
 * Every agent tool is classified by **audience**: which consumers may see it.
 * - `in-app`   — dashboard agent only. HITL proposals (client-applied), canvas-
 *                context tools, and job-queuing writes live here — they do not
 *                project cleanly onto a single stateless MCP `tools/call`.
 * - `external` — safe to expose to a customer's own agent over MCP.
 * - `both`     — read-only, PDP-gated, stateless: usable everywhere.
 * - `support`  — in-app support (Ask-AI) surface only. HITL escalation proposals
 *                (client-applied via `submitCase`) live here, like other in-app
 *                proposals — never projected onto the read-only external MCP surface.
 *
 * The external projection is **read-only at launch** (see the plan's A5): the MCP
 * surface is a remote, authenticated, internet-facing endpoint, so we expose only
 * the read/both tools until an approval-over-MCP design exists for writes. Auth is
 * NOT re-implemented here — each tool's `execute` still resolves the actor and
 * enforces its PDP verb; this map only decides *visibility*. The anti-drift test
 * (`assertAudienceCoverage`) guarantees no tool ships unclassified.
 */

export type ToolAudience = "in-app" | "external" | "both" | "support";

/** Audience classification for every tool the agent harness can expose. */
export const TOOL_AUDIENCE: Record<string, ToolAudience> = {
	// Catalog — pure, provider-neutral lookups (no account data, no writes).
	list_services: "both",
	list_service_options: "both",
	cidr_for_hosts: "both",

	// Canvas-bound — need live canvas context / apply changes client-side.
	estimate_cost: "in-app",
	propose_changes: "in-app",

	// Read surface — PDP-gated, secret-free reads of the actor's account.
	get_project: "both",
	list_projects: "both",
	list_jobs: "both",
	get_job: "both",
	get_plan_result: "both",
	get_drift_posture: "both",
	list_runners: "both",
	list_clusters: "both",
	list_connectors: "both",
	list_cloud_identities: "both",
	get_cached_resources: "both",
	// Docs retrieval — read-only, stateless: usable everywhere (incl. MCP).
	search_docs: "both",
	// Connect action — opens the in-app connect sheet, so dashboard-only (no MCP surface can open UI).
	connect_cloud: "in-app",
	// Metrics reads — usage/billing standing for dashboards (secret-free, PDP-gated).
	get_org_usage: "both",
	get_ai_usage: "both",
	get_billing_summary: "both",

	// Generative dashboard — client-rendered viz (spec passthrough), in-app only.
	build_dashboard: "in-app",

	// Widget grid — client-placed pin (spec passthrough), in-app only (no MCP UI).
	pin_widget: "in-app",

	// Saved artifacts — named widget/dashboard specs; grid-bound UI, in-app only.
	list_artifacts: "in-app",
	get_artifact: "in-app",
	update_artifact: "in-app",

	// Operations — HITL plan/deploy proposals (multi-turn approval).
	propose_operation: "in-app",

	// Support (Ask-AI) — HITL escalation: proposes a case the user submits client-side.
	create_support_case: "support",

	// Scanner — scan_repo QUEUES a runner job (a write) so it stays in-app for the
	// read-only launch; its results are reads and are externally safe.
	scan_repo: "in-app",
	audit_infrastructure: "in-app",
	get_scan_result: "both",
	compare_providers: "both",
};

/**
 * The AI tool-scope DENYLIST: code no agent tool — in-app, external or support — may ever reach.
 *
 * Audience decides who may SEE a tool. This decides what no tool may DO at all, whatever its
 * audience and whatever PDP verb it checks: each entry issues a credential that carries the caller's
 * access somewhere they might not be watching, so an agent must never be the thing that asks for it
 * (#5250 §5 "ReBAC": "No AI tool may call the mint"). A person runs `alethia cluster kubeconfig`;
 * a model does not.
 *
 * Paths are console-root-relative prefixes — a directory (ending in `/`) or one file. `tests/kubeconfig-mint/ai-tool-denylist.test.ts` walks
 * the import graph of every agent entry point (lib/ai, lib/agent, the agent and MCP routes) and fails
 * if any file reaches one of them, and fails if one of them stops existing — a prefix that matches
 * nothing denies nothing. Add the module here BEFORE adding the capability anywhere else.
 */
export const AI_TOOL_DENIED_MODULES: readonly string[] = [
	// Kubeconfig mint (#5281): the request/poll/runner logic and the routes that expose it.
	"lib/kubeconfig-mint/",
	"app/api/cli/clusters/[id]/kubeconfig/",
	"app/api/jobs/[id]/kubeconfig-mint/",
	// The console's download (#5285): the server actions that request and collect a mint for the
	// session, and the browser code that opens the seal and saves the file.
	"app/server/actions/kubeconfig-download.ts",
	"components/clusters/kubeconfig-download/",
];

/** Tool names no tool may be registered under, for the same reason (#5281). Matched as a substring,
 *  case-insensitively: `get_kubeconfig`, `mintKubeconfig` and `cluster_kubeconfig` are all refused. */
export const AI_TOOL_DENIED_NAME_PARTS: readonly string[] = ["kubeconfig"];

/** Whether `name` is a tool name the denylist refuses. */
export function isDeniedToolName(name: string): boolean {
	const lower = name.toLowerCase();
	return AI_TOOL_DENIED_NAME_PARTS.some((part) => lower.includes(part));
}

/** Whether a tool is part of the external (read-only) MCP projection. */
export function isExternalTool(name: string): boolean {
	if (isDeniedToolName(name)) return false;
	const a = TOOL_AUDIENCE[name];
	return a === "external" || a === "both";
}

/**
 * Projects an AI-SDK tool set to the external/read-only subset for MCP. Unknown
 * tools (no audience entry) are EXCLUDED fail-safe — an unclassified tool must
 * never leak externally; `assertAudienceCoverage` catches the misclassification
 * in tests/CI.
 */
export function externalToolsOnly(tools: ToolSet): ToolSet {
	// ToolSet is a concrete Record<string, Tool>, so a string-keyed write is allowed (no generic
	// TS2862) and entries carry the value type — the projection stays cast-free.
	const out: ToolSet = {};
	for (const [name, tool] of Object.entries(tools)) {
		if (isExternalTool(name)) out[name] = tool;
	}
	return out;
}

/**
 * Anti-drift guard: throws if any provided tool name lacks an audience
 * classification. Call it from a test/CI with the full set of buildable tools so
 * a newly added tool cannot ship without an explicit exposure decision.
 */
export function assertAudienceCoverage(toolNames: string[]): void {
	const denied = toolNames.filter(isDeniedToolName);
	if (denied.length > 0) {
		throw new Error(
			`tool(s) on the AI tool-scope denylist: ${denied.join(", ")}. ` +
				`A tool may not issue a cluster credential (lib/ai/tools/registry.ts AI_TOOL_DENIED_NAME_PARTS).`,
		);
	}
	const missing = toolNames.filter((n) => !(n in TOOL_AUDIENCE));
	if (missing.length > 0) {
		throw new Error(
			`tool(s) missing an audience classification in TOOL_AUDIENCE: ${missing.join(", ")}. ` +
				`Add each to lib/ai/tools/registry.ts (in-app for HITL/canvas/writes; both for read-only).`,
		);
	}
}
