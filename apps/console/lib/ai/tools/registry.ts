// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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

/** Whether a tool is part of the external (read-only) MCP projection. */
export function isExternalTool(name: string): boolean {
	const a = TOOL_AUDIENCE[name];
	return a === "external" || a === "both";
}

/**
 * Projects an AI-SDK tool set to the external/read-only subset for MCP. Unknown
 * tools (no audience entry) are EXCLUDED fail-safe — an unclassified tool must
 * never leak externally; `assertAudienceCoverage` catches the misclassification
 * in tests/CI.
 */
export function externalToolsOnly<T extends Record<string, unknown>>(
	tools: T,
): Partial<T> {
	const out: Partial<T> = {};
	for (const name of Object.keys(tools) as (keyof T & string)[]) {
		if (isExternalTool(name)) out[name] = tools[name];
	}
	return out;
}

/**
 * Anti-drift guard: throws if any provided tool name lacks an audience
 * classification. Call it from a test/CI with the full set of buildable tools so
 * a newly added tool cannot ship without an explicit exposure decision.
 */
export function assertAudienceCoverage(toolNames: string[]): void {
	const missing = toolNames.filter((n) => !(n in TOOL_AUDIENCE));
	if (missing.length > 0) {
		throw new Error(
			`tool(s) missing an audience classification in TOOL_AUDIENCE: ${missing.join(", ")}. ` +
				`Add each to lib/ai/tools/registry.ts (in-app for HITL/canvas/writes; both for read-only).`,
		);
	}
}
