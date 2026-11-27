// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A CLI request marked as made on behalf of an agent (lib/agents/cli-agent.ts, #7921): which headers
// mark it, that an unmarked request reaches no read, that a marked one is refused while the org's
// agent access is off and recorded either way, and that the gate never asks about an org the caller
// is not a member of.

import { describe, expect, it, vi } from "vitest";
import {
	type CliAgentCallRecord,
	type CliAgentGateDeps,
	cliAgentRefusal,
	readCliAgentMark,
} from "@/lib/agents/cli-agent";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000bb";

/** A CLI request carrying `headers`. */
function requestWith(headers: Record<string, string>): Request {
	return new Request("https://console.test/api/cli/projects", { headers });
}

const MARK = { "X-Alethia-Agent": "alethia-mcp", "X-Alethia-Agent-Tool": "projects_list" };

/** Stand-in reads: `enabled` is the switch, `members` the orgs the caller is an active member of. */
function fakeDeps(opts: { enabled?: boolean; members?: string[]; recordFails?: boolean } = {}) {
	const records: CliAgentCallRecord[] = [];
	const deps = {
		isActiveOrgMember: vi.fn(async (_userId: string, orgId: string) => (opts.members ?? [ORG]).includes(orgId)),
		defaultOrgId: vi.fn(async () => ORG),
		agentAccessEnabled: vi.fn(async () => opts.enabled ?? true),
		record: vi.fn(async (call: CliAgentCallRecord) => {
			if (opts.recordFails) throw new Error("insert failed");
			records.push(call);
		}),
	} satisfies CliAgentGateDeps;
	return { deps, records };
}

describe("readCliAgentMark", () => {
	it("reads no mark from a request with neither header", () => {
		expect(readCliAgentMark(new Headers())).toBeNull();
		expect(readCliAgentMark(new Headers({ "X-Alethia-Agent": "  " }))).toBeNull();
	});

	it("records the tool the request names", () => {
		expect(readCliAgentMark(new Headers(MARK))).toEqual({ tool: "cli:projects_list" });
	});

	it("reads either header alone as a mark, and a malformed tool name as unnamed", () => {
		expect(readCliAgentMark(new Headers({ "X-Alethia-Agent": "alethia-mcp" }))).toEqual({ tool: "cli:unnamed" });
		expect(readCliAgentMark(new Headers({ "X-Alethia-Agent-Tool": "deploy" }))).toEqual({ tool: "cli:deploy" });
		expect(readCliAgentMark(new Headers({ ...MARK, "X-Alethia-Agent-Tool": "x".repeat(200) }))).toEqual({
			tool: "cli:unnamed",
		});
		expect(readCliAgentMark(new Headers({ ...MARK, "X-Alethia-Agent-Tool": "a b" }))).toEqual({ tool: "cli:unnamed" });
	});
});

describe("cliAgentRefusal", () => {
	it("answers an unmarked request with nothing and reads nothing, whatever the switch says", async () => {
		const { deps } = fakeDeps({ enabled: false });
		await expect(cliAgentRefusal(requestWith({}), { sub: USER }, deps)).resolves.toBeNull();
		for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
	});

	it("refuses a marked request while the org's agent access is off, and records the refusal", async () => {
		const { deps, records } = fakeDeps({ enabled: false });
		const res = await cliAgentRefusal(requestWith(MARK), { sub: USER }, deps);
		expect(res?.status).toBe(403);
		expect(await res?.json()).toMatchObject({ code: "agent_access_disabled" });
		expect(records).toEqual([
			{ orgId: ORG, userId: USER, tool: "cli:projects_list", credential: "cli_session", errorClass: "agent_access_disabled" },
		]);
	});

	it("lets a marked request through while agent access is on, and records it", async () => {
		const { deps, records } = fakeDeps({ enabled: true });
		await expect(cliAgentRefusal(requestWith(MARK), { sub: USER }, deps)).resolves.toBeNull();
		expect(records).toEqual([
			{ orgId: ORG, userId: USER, tool: "cli:projects_list", credential: "cli_session", errorClass: null },
		]);
	});

	it("asks about the org the request names when the caller is an active member of it", async () => {
		const { deps } = fakeDeps({ members: [ORG, OTHER_ORG] });
		await cliAgentRefusal(requestWith({ ...MARK, "X-Alethia-Org": OTHER_ORG }), { sub: USER }, deps);
		expect(deps.agentAccessEnabled).toHaveBeenCalledWith(USER, OTHER_ORG);
		expect(deps.defaultOrgId).not.toHaveBeenCalled();
	});

	it("never reads the policy of an org the caller is not a member of; the route refuses that itself", async () => {
		const { deps, records } = fakeDeps({ enabled: false, members: [ORG] });
		await expect(
			cliAgentRefusal(requestWith({ ...MARK, "X-Alethia-Org": OTHER_ORG }), { sub: USER }, deps),
		).resolves.toBeNull();
		expect(deps.agentAccessEnabled).not.toHaveBeenCalled();
		expect(records).toEqual([]);
	});

	it("binds a service token to its pinned org and records it as a service token", async () => {
		const { deps, records } = fakeDeps({ enabled: false });
		const res = await cliAgentRefusal(requestWith(MARK), { sub: USER, service_token_org_id: OTHER_ORG }, deps);
		expect(res?.status).toBe(403);
		expect(deps.agentAccessEnabled).toHaveBeenCalledWith(USER, OTHER_ORG);
		expect(deps.isActiveOrgMember).not.toHaveBeenCalled();
		expect(records[0]).toMatchObject({ orgId: OTHER_ORG, credential: "service_token" });
	});

	it("answers one request once, however many times its bearer is verified", async () => {
		const { deps, records } = fakeDeps();
		const req = requestWith(MARK);
		await cliAgentRefusal(req, { sub: USER }, deps);
		await cliAgentRefusal(req, { sub: USER }, deps);
		expect(deps.agentAccessEnabled).toHaveBeenCalledTimes(1);
		expect(records).toHaveLength(1);
	});

	it("still refuses when the record cannot be written, and still lets through", async () => {
		const off = fakeDeps({ enabled: false, recordFails: true });
		expect((await cliAgentRefusal(requestWith(MARK), { sub: USER }, off.deps))?.status).toBe(403);
		const on = fakeDeps({ enabled: true, recordFails: true });
		await expect(cliAgentRefusal(requestWith(MARK), { sub: USER }, on.deps)).resolves.toBeNull();
	});
});
