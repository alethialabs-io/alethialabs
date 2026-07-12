// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Anti-drift tests for the tool audience registry (lib/ai/tools/registry.ts). The
// real value: (1) every tool the agent can build is classified, so a new tool can't
// ship without an explicit exposure decision, and (2) the external/MCP projection is
// read-only — HITL/canvas/job-queuing tools never leak to a customer's agent.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/aws/identities");
vi.mock("@/app/server/actions/cloud-resources");
vi.mock("@/app/server/actions/clusters");
vi.mock("@/app/server/actions/connectors");
vi.mock("@/app/server/actions/jobs");
vi.mock("@/app/server/actions/pricing");
vi.mock("@/app/server/actions/projects");
vi.mock("@/app/server/actions/runners");
vi.mock("@/app/server/actions/scanner");

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";

import { registerAiToolsOnMcp } from "@/lib/ai/mcp/adapter";
import {
	buildAgentTools,
	buildExternalAgentTools,
	buildProjectAgentTools,
} from "@/lib/ai/tools";
import {
	assertAudienceCoverage,
	externalToolsOnly,
	isExternalTool,
	TOOL_AUDIENCE,
} from "@/lib/ai/tools/registry";

// Tools that must NEVER be exposed externally (HITL proposals, canvas-context, or
// job-queuing writes).
const IN_APP_ONLY = [
	"estimate_cost",
	"propose_changes",
	"propose_operation",
	"scan_repo",
	"pin_widget",
];

// The read-only surface that SHOULD be externally projectable.
const READS = [
	"list_projects",
	"get_project",
	"list_jobs",
	"get_job",
	"get_plan_result",
	"list_runners",
	"list_clusters",
	"list_connectors",
	"list_cloud_identities",
	"get_cached_resources",
	"list_services",
	"list_service_options",
	"cidr_for_hosts",
	"get_scan_result",
	"compare_providers",
];

describe("tool audience registry", () => {
	it("classifies every buildable tool (anti-drift)", () => {
		const names = new Set<string>([
			...Object.keys(buildAgentTools({ mode: "act" })),
			...Object.keys(buildProjectAgentTools(undefined)),
		]);
		expect(() => assertAudienceCoverage([...names])).not.toThrow();
	});

	it("external projection is read-only — excludes HITL/canvas/write tools", () => {
		const ext = buildExternalAgentTools();
		for (const n of IN_APP_ONLY) {
			expect(n in ext).toBe(false);
		}
	});

	it("external projection includes the read surface", () => {
		const built = buildAgentTools({ mode: "act" });
		const ext = buildExternalAgentTools();
		const builtReads = READS.filter((n) => n in built);
		const missing = builtReads.filter((n) => !(n in ext));
		expect(missing).toEqual([]);
	});

	it("the external set equals exactly the audience-external built tools", () => {
		const built = buildAgentTools({ mode: "act" });
		const ext = new Set(Object.keys(buildExternalAgentTools()));
		const expected = new Set(
			Object.keys(built).filter((n) => isExternalTool(n)),
		);
		expect(ext).toEqual(expected);
	});

	it("no in-app-only tool is classified external", () => {
		for (const n of IN_APP_ONLY) {
			expect(TOOL_AUDIENCE[n]).toBe("in-app");
		}
	});

	it("isExternalTool is fail-safe for unknown tools", () => {
		expect(isExternalTool("totally_unknown_tool")).toBe(false);
	});

	it("the MCP route composition registers reads but not scan_repo (read-only surface)", () => {
		// Mirrors app/api/mcp/route.ts: registerAiToolsOnMcp(server, buildExternalAgentTools()).
		const registered: string[] = [];
		const server = {
			registerTool: (name: string) => registered.push(name),
		} as unknown as McpServer;
		registerAiToolsOnMcp(server, buildExternalAgentTools() as ToolSet);

		expect(registered).toContain("list_projects");
		expect(registered).toContain("get_scan_result");
		expect(registered).not.toContain("scan_repo");
		expect(registered).not.toContain("propose_operation");
	});

	it("externalToolsOnly filters a synthetic tool set", () => {
		const set = {
			list_projects: 1,
			propose_operation: 2,
			get_job: 3,
			scan_repo: 4,
		};
		expect(Object.keys(externalToolsOnly(set)).sort()).toEqual([
			"get_job",
			"list_projects",
		]);
	});
});
