// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A CLI request made on behalf of a coding agent (#7921). `alethia mcp` serves the CLI's commands to
// a local agent over stdio and runs each tool call as a child CLI process, under the person's own
// CLI credential. That child marks every request it sends with two headers
// (packages/core/api/transport.go `AgentHeader`, `AgentToolHeader`). A marked request is agent work,
// and is held to the org's agent policy as a connected agent is:
//
//   · the agent access switch: while it is off, a marked request is refused before any route runs
//     (`cliAgentRefusal`, asked by `verifyCliToken` in lib/cli/auth.ts, which every CLI bearer
//     passes through);
//   · "keep agents off production": a deploy or destroy the request queues is refused on a
//     production environment (the actor carries `onBehalfOfAgent`, app/api/jobs/route.ts, and the
//     approvals table answers it, lib/approvals/policy.ts);
//   · each marked request is recorded in `agent_tool_calls` with the tool it names.
//
// THE MARK ONLY NARROWS. It is a statement the client makes about itself, so it is not a security
// boundary: a client can always leave it out, and is then treated exactly as an unmarked CLI request
// is. That is acceptable because the mark exists so the org's policy binds agents that identify
// themselves; nothing here grants a marked request anything an unmarked one would not get, and a
// request without the mark does not reach any read in this file.

import "server-only";
import { and, eq } from "drizzle-orm";
import { readAgentPolicy } from "@/lib/approvals/context";
import { AGENT_ACCESS_DISABLED_MESSAGE } from "@/lib/approvals/policy";
import { getActiveScope } from "@/lib/auth/scope";
import type { CredentialKind } from "@/lib/authz/types";
import { getServiceDb, withScope } from "@/lib/db";
import { agentToolCalls, member } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";

/** The header that marks a request as made on behalf of an agent; its value names the client. */
const CLI_AGENT_HEADER = "X-Alethia-Agent";
/** The header naming the agent tool the request is made for. */
const CLI_AGENT_TOOL_HEADER = "X-Alethia-Agent-Tool";

/** A tool name as `alethia mcp` builds one (command words joined by `_`), bounded for the record. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** The `agent_tool_calls.tool` prefix of a call made through the CLI rather than the remote server. */
const RECORDED_TOOL_PREFIX = "cli:";

/** What a marked request says about itself. */
export interface CliAgentMark {
	/** The tool as recorded: `cli:<tool name>`, or `cli:unnamed` when the name is missing or malformed. */
	tool: string;
}

/**
 * The agent mark `headers` carry, or null when they carry none. Either header marks the request: a
 * mark can only narrow, so a partial one is read as a mark rather than ignored.
 */
export function readCliAgentMark(headers: Headers): CliAgentMark | null {
	const agent = headers.get(CLI_AGENT_HEADER)?.trim() ?? "";
	const tool = headers.get(CLI_AGENT_TOOL_HEADER)?.trim() ?? "";
	if (agent === "" && tool === "") return null;
	return { tool: RECORDED_TOOL_PREFIX + (TOOL_NAME.test(tool) ? tool : "unnamed") };
}

/** The parts of a verified CLI credential the gate reads (lib/cli/auth.ts `CliTokenPayload`). */
export interface CliAgentCaller {
	sub?: string;
	service_token_org_id?: string;
}

/** One marked request, as `agent_tool_calls` records it. */
export interface CliAgentCallRecord {
	orgId: string;
	userId: string;
	tool: string;
	credential: Extract<CredentialKind, "cli_session" | "service_token">;
	/** Null when the request was let through; the refusal's code otherwise. */
	errorClass: string | null;
}

/** What the gate reads and writes, so tests can stand each one in. */
export interface CliAgentGateDeps {
	/** True when `userId` is an active member of `orgId` (or it is their personal org). */
	isActiveOrgMember(userId: string, orgId: string): Promise<boolean>;
	/** The org `userId`'s request is scoped to when it names none. */
	defaultOrgId(userId: string): Promise<string>;
	/** False while `orgId`'s agent access switch is off. */
	agentAccessEnabled(userId: string, orgId: string): Promise<boolean>;
	/** Records the request in `agent_tool_calls`. */
	record(call: CliAgentCallRecord): Promise<void>;
}

/** The default reads, and the record in `agent_tool_calls`. */
const defaultCliAgentGateDeps: CliAgentGateDeps = {
	isActiveOrgMember: async (userId, orgId) => {
		if (orgId === userId) return true;
		const [row] = await getServiceDb()
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.userId, userId), eq(member.organizationId, orgId), eq(member.status, "active")))
			.limit(1);
		return Boolean(row);
	},
	defaultOrgId: async (userId) => (await getActiveScope(userId)).orgId,
	agentAccessEnabled: async (userId, orgId) =>
		(await withScope({ ownerId: userId, orgId }, (tx) => readAgentPolicy(tx, orgId))).agentAccessEnabled,
	record: async (call) => {
		await withScope({ ownerId: call.userId, orgId: call.orgId }, (tx) =>
			tx.insert(agentToolCalls).values({
				org_id: call.orgId,
				user_id: call.userId,
				tool: call.tool,
				client_id: null,
				credential: call.credential,
				// Recorded before the route runs, where how long it will take is not known yet.
				latency_ms: 0,
				error_class: call.errorClass,
			}),
		);
	},
};

/** The answer to a marked request while the org's agent access is off. */
function agentAccessDisabledResponse(): Response {
	return new Response(JSON.stringify({ error: AGENT_ACCESS_DISABLED_MESSAGE, code: "agent_access_disabled" }), {
		status: 403,
		headers: { "Content-Type": "application/json" },
	});
}

/** The org a marked request acts in, or null when the gate has no org it may ask about. */
async function orgOfRequest(req: Request, caller: CliAgentCaller, userId: string, deps: CliAgentGateDeps) {
	// A service token's org is its pin; verifyCliToken has already refused a header naming another.
	if (caller.service_token_org_id) return caller.service_token_org_id;
	const headerOrg = req.headers.get("X-Alethia-Org")?.trim();
	if (!headerOrg) return deps.defaultOrgId(userId);
	// An org the caller is not an active member of is refused by the route itself. The gate does not
	// read its policy, so a marked request cannot learn another org's setting from the answer.
	return (await deps.isActiveOrgMember(userId, headerOrg)) ? headerOrg : null;
}

/** One gate answer per request, however many times a route verifies its bearer. */
const answered = new WeakMap<Request, Promise<Response | null>>();

/**
 * The refusal a CLI request with a verified credential `caller` gets for being agent work, or null.
 * An unmarked request is null without a read. A marked one is refused while its org's agent access is
 * off, and recorded in `agent_tool_calls` either way; a failure to record never fails the request.
 */
export function cliAgentRefusal(
	req: Request,
	caller: CliAgentCaller,
	deps: CliAgentGateDeps = defaultCliAgentGateDeps,
): Promise<Response | null> {
	const mark = readCliAgentMark(req.headers);
	if (!mark) return Promise.resolve(null);
	const earlier = answered.get(req);
	if (earlier) return earlier;
	const answer = decide(req, caller, mark, deps);
	answered.set(req, answer);
	return answer;
}

/** The gate's decision for a marked request. */
async function decide(
	req: Request,
	caller: CliAgentCaller,
	mark: CliAgentMark,
	deps: CliAgentGateDeps,
): Promise<Response | null> {
	const userId = caller.sub;
	// No subject: the route refuses the payload itself, and there is nobody to record.
	if (!userId) return null;
	const orgId = await orgOfRequest(req, caller, userId, deps);
	if (orgId === null) return null;
	const enabled = await deps.agentAccessEnabled(userId, orgId);
	await deps
		.record({
			orgId,
			userId,
			tool: mark.tool,
			credential: caller.service_token_org_id ? "service_token" : "cli_session",
			errorClass: enabled ? null : "agent_access_disabled",
		})
		.catch((err: unknown) => log.error("[cli-agent] could not record a tool call", { err }));
	return enabled ? null : agentAccessDisabledResponse();
}
