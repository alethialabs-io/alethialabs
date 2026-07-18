// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
	type AgentPersona,
	buildAgentSystemPrompt,
	scopeToolsToAgent,
} from "@/lib/agent/executor";

/** A minimal real AI-SDK tool — the scoping is value-agnostic, so one stub covers every slot. */
const stubTool = tool({
	description: "stub",
	inputSchema: z.object({}),
	execute: async () => ({}),
});

const persona: AgentPersona = {
	persona: "You are the prod auditor for acme.",
	mission: "Keep prod least-privilege and drift-free.",
	tool_scope: ["list_projects", "get_project"],
};

describe("buildAgentSystemPrompt", () => {
	it("includes persona and mission", () => {
		const p = buildAgentSystemPrompt(persona);
		expect(p).toContain("prod auditor for acme");
		expect(p).toContain("Mission: Keep prod least-privilege and drift-free.");
	});

	it("appends a memory summary when provided", () => {
		const p = buildAgentSystemPrompt(persona, "cluster arn is x");
		expect(p).toContain("What you remember");
		expect(p).toContain("cluster arn is x");
	});

	it("omits the memory section when empty", () => {
		expect(buildAgentSystemPrompt(persona, "   ")).not.toContain("What you remember");
	});
});

describe("scopeToolsToAgent", () => {
	const tools = {
		list_projects: stubTool,
		get_project: stubTool,
		propose_operation: stubTool,
	};

	it("narrows to the agent's allowed tools", () => {
		const scoped = scopeToolsToAgent(tools, ["list_projects", "get_project"]);
		expect(Object.keys(scoped).sort()).toEqual(["get_project", "list_projects"]);
		expect("propose_operation" in scoped).toBe(false);
	});

	it("empty scope means all granted tools", () => {
		expect(Object.keys(scopeToolsToAgent(tools, []))).toHaveLength(3);
	});

	it("ignores unknown tool names in scope", () => {
		const scoped = scopeToolsToAgent(tools, ["list_projects", "does_not_exist"]);
		expect(Object.keys(scoped)).toEqual(["list_projects"]);
	});
});
