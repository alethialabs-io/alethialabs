// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org's agent kill switch at the tool layer (lib/agent/kill-switch.ts, #7477 "off means off"):
// over EVERY tool any in-product route can build — reads, design tools, plan proposals, approval
// requests, support — and both agent credential kinds, off refuses and on runs. The tool sets are the
// real builders' output, so a tool added to any of them is in this table without editing it.

import { tool, type ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/aws/identities");
vi.mock("@/app/server/actions/cloud-resources");
vi.mock("@/app/server/actions/clusters");
vi.mock("@/app/server/actions/connectors");
vi.mock("@/app/server/actions/jobs");
vi.mock("@/lib/rpc/procedures/jobs");
vi.mock("@/lib/pricing/region-prices");
vi.mock("@/app/server/actions/projects");
vi.mock("@/app/server/actions/runners");
vi.mock("@/app/server/actions/scanner");
vi.mock("@/lib/rpc/procedures/projects");
// The production read: org_agent_policy through the actor's RLS scope.
const policyRead = vi.hoisted(() => ({ enabled: true, scopes: [] as Array<{ userId: string; orgId: string }> }));
vi.mock("@/lib/db", () => ({
	// Read at import by lib/auth (the server actions' module graph); never called by the guard.
	getServiceDb: () => ({}),
	withActorScope: async (actor: { userId: string; orgId: string }, fn: (tx: object) => Promise<unknown>) => {
		policyRead.scopes.push({ userId: actor.userId, orgId: actor.orgId });
		return fn({});
	},
}));
vi.mock("@/lib/approvals/context", () => ({
	readAgentPolicy: async () => ({ agentAccessEnabled: policyRead.enabled }),
}));

import { buildAgentTools, buildProjectAgentTools } from "@/lib/ai/tools";
import { buildSupportTools } from "@/lib/ai/tools/support";
import {
	AGENT_ACCESS_REFUSED_OUTPUT,
	agentAccessRefused,
	defaultKillSwitchDeps,
	guardAgentTools,
	type KillSwitchDeps,
} from "@/lib/agent/kill-switch";
import { AGENT_ACCESS_DISABLED_MESSAGE } from "@/lib/approvals/policy";
import type { Actor, CredentialKind } from "@/lib/authz/types";

/** An actor of `credential` in org-1. */
function actorOf(credential: CredentialKind): Actor {
	return { userId: "user-1", orgId: "org-1", credential, credentialRef: "thread-1" };
}

/** A switch that answers `answers` in order, then its last answer; records how often it was read. */
function switchOf(...answers: boolean[]): KillSwitchDeps & { reads: number } {
	const deps = {
		reads: 0,
		agentAccessEnabled: async () => {
			const answer = answers[Math.min(deps.reads, answers.length - 1)] ?? true;
			deps.reads++;
			return answer;
		},
	};
	return deps;
}

/** Every tool any in-product route builds, by name: the union of the three builders' sets. */
function everyTool(): ToolSet {
	return { ...buildAgentTools({ mode: "act" }), ...buildProjectAgentTools(undefined), ...buildSupportTools() };
}

/**
 * The real tool set with each server tool's execute replaced by a spy that records it ran. The spy
 * stands in for the real body (which reaches server actions); the names, and which tools are client
 * tools, are the real ones.
 */
function spiedTools(): { tools: ToolSet; ran: string[] } {
	const ran: string[] = [];
	const tools: ToolSet = {};
	for (const [name, def] of Object.entries(everyTool())) {
		tools[name] = def.execute
			? {
					...def,
					execute: async () => {
						ran.push(name);
						return { ran: name };
					},
				}
			: def;
	}
	return { tools, ran };
}

const ALL = everyTool();
const SERVER_TOOLS = Object.keys(ALL).filter((n) => ALL[n]?.execute);
const CLIENT_TOOLS = Object.keys(ALL).filter((n) => !ALL[n]?.execute);
const AGENT_KINDS = ["agent_in_app", "agent_oauth"] as const;
const OPTIONS = { toolCallId: "call-1", messages: [] };

/** Calls `name` in `tools`, failing when it has no execute. */
async function call(tools: ToolSet, name: string): Promise<unknown> {
	const run = tools[name]?.execute;
	if (!run) throw new Error(`${name} has no execute`);
	return run({}, OPTIONS);
}

beforeEach(() => {
	policyRead.enabled = true;
	policyRead.scopes = [];
});

describe("the table covers every tool class", () => {
	it("has reads, design tools, a plan proposal, approval requests and support among the tools", () => {
		for (const name of ["list_projects", "get_job", "search_docs", "estimate_cost", "scan_repo", "request_apply", "request_destroy"]) {
			expect(SERVER_TOOLS).toContain(name);
		}
		for (const name of ["propose_operation", "propose_changes", "create_support_case"]) {
			expect(CLIENT_TOOLS).toContain(name);
		}
	});
});

describe.each(AGENT_KINDS)("%s with agent access off", (credential) => {
	it.each(SERVER_TOOLS)("%s is refused and never runs", async (name) => {
		const { tools, ran } = spiedTools();
		const guarded = await guardAgentTools(tools, actorOf(credential), switchOf(false));
		expect(guarded.disabledAtStart).toBe(true);
		expect(await call(guarded.tools, name)).toEqual(AGENT_ACCESS_REFUSED_OUTPUT);
		expect(ran).toEqual([]);
	});

	it.each(CLIENT_TOOLS)("%s is not offered to the model", async (name) => {
		const guarded = await guardAgentTools(spiedTools().tools, actorOf(credential), switchOf(false));
		expect(guarded.tools[name]).toBeUndefined();
	});

	it("tells the model in one sentence an owner can act on", () => {
		expect(AGENT_ACCESS_REFUSED_OUTPUT).toEqual({
			status: "refused",
			code: "agent_access_disabled",
			reason: AGENT_ACCESS_DISABLED_MESSAGE,
		});
		expect(AGENT_ACCESS_DISABLED_MESSAGE).toMatch(/^Agent access is turned off for this organization\./);
	});
});

describe.each(AGENT_KINDS)("%s with agent access on", (credential) => {
	it.each(SERVER_TOOLS)("%s runs", async (name) => {
		const { tools, ran } = spiedTools();
		const guarded = await guardAgentTools(tools, actorOf(credential), switchOf(true));
		expect(guarded.disabledAtStart).toBe(false);
		expect(await call(guarded.tools, name)).toEqual({ ran: name });
		expect(ran).toEqual([name]);
	});

	it.each(CLIENT_TOOLS)("%s is offered unchanged", async (name) => {
		const { tools } = spiedTools();
		const guarded = await guardAgentTools(tools, actorOf(credential), switchOf(true));
		expect(guarded.tools[name]).toBe(tools[name]);
	});
});

describe("the switch is read at every call, not once per turn", () => {
	it("turned off mid-turn: the next call is refused, the one before it ran", async () => {
		const { tools, ran } = spiedTools();
		// Read 1: the turn starts on. Read 2: the first call, still on. Read 3: the second call, off.
		const deps = switchOf(true, true, false);
		const guarded = await guardAgentTools(tools, actorOf("agent_in_app"), deps);
		expect(await call(guarded.tools, "list_projects")).toEqual({ ran: "list_projects" });
		expect(await call(guarded.tools, "request_apply")).toEqual(AGENT_ACCESS_REFUSED_OUTPUT);
		expect(ran).toEqual(["list_projects"]);
		expect(deps.reads).toBe(3);
	});

	it("turned back on mid-turn: a server tool runs again", async () => {
		const { tools, ran } = spiedTools();
		const guarded = await guardAgentTools(tools, actorOf("agent_in_app"), switchOf(false, true));
		expect(await call(guarded.tools, "list_projects")).toEqual({ ran: "list_projects" });
		expect(ran).toEqual(["list_projects"]);
	});
});

describe.each(["session", "cli_session", "service_token"] as const)("%s is not bound by the switch", (credential) => {
	it("gets the tool set unchanged and never reads the switch", async () => {
		const { tools } = spiedTools();
		const deps = switchOf(false);
		const guarded = await guardAgentTools(tools, actorOf(credential), deps);
		expect(guarded).toEqual({ tools, disabledAtStart: false });
		expect(deps.reads).toBe(0);
		expect(await agentAccessRefused(actorOf(credential), deps)).toBe(false);
	});
});

describe("the production read", () => {
	it("reads org_agent_policy for the actor's own org, under its RLS scope", async () => {
		policyRead.enabled = false;
		expect(await defaultKillSwitchDeps.agentAccessEnabled(actorOf("agent_in_app"))).toBe(false);
		expect(policyRead.scopes).toEqual([{ userId: "user-1", orgId: "org-1" }]);
	});

	it("guards with it by default", async () => {
		policyRead.enabled = false;
		const echo = tool({ inputSchema: z.object({}), execute: async () => "ran" });
		const guarded = await guardAgentTools({ list_projects: echo }, actorOf("agent_oauth"));
		expect(await call(guarded.tools, "list_projects")).toEqual(AGENT_ACCESS_REFUSED_OUTPUT);
		policyRead.enabled = true;
		expect(await call(guarded.tools, "list_projects")).toBe("ran");
	});
});
