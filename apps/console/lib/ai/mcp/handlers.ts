// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The handlers behind the declared external tools (lib/ai/mcp/surface.ts) that the MCP server serves
// under their own names: the operations a connected agent runs — plan, apply, destroy — and the job
// tools it follows them with.
//
// HOW AN APPLY OR A DESTROY RUNS. `request_apply` / `request_destroy` are the only tools that can
// lead to a DEPLOY or a DESTROY, and they lead to one only through a person:
//
//   1. The first call records a pending approval (lib/approvals/request.ts) bound to the plan, its
//      digest, the environment and this exact credential, and returns `pending` with the console link.
//      Nothing is queued.
//   2. A person opens the link in the console and approves (lib/approvals/decide.ts). No tool and no
//      token can do this step: deciding needs a console browser session.
//   3. The agent calls the same tool again for the same plan (or environment). Only now, and only
//      because its OWN approval of that SAME plan reads `approved`, the job is queued through the
//      ordinary server action, which hands the approval to `requireApplyAuthorization`. The queue gate
//      re-checks everything (credential, org, project, environment, operation, digest, still current)
//      and consumes the approval with a compare-and-set, so one approval queues one job once.
//   4. Any later call for that plan returns the job the approval started, and queues nothing.
//
// So text an agent reads from a tool result, a log or a repository can make it call a write tool,
// and the most that call produces is a pending request a person still has to approve.

import "server-only";
import { z } from "zod";
import { destroyProject, planProject, provisionProject } from "@/app/server/actions/projects";
import { cancelJob } from "@/app/server/actions/jobs";
import type { ActionResult } from "@/lib/actions/result";
import { approvePath } from "@/lib/approvals/http";
import type { ApprovalView } from "@/lib/approvals/read";
import type { AgentScope, ApplyOperation } from "@/lib/approvals/types";
import type { Actor } from "@/lib/authz/types";
import { isEnumMember } from "@/lib/coerce";
import { readJobStatus } from "@/lib/rpc/procedures/jobs";
import { appliedPlanFor, findOwnApproval, readOwnOrgApproval, requestOwnApproval } from "./approval-store";
import { readJobLogPage, type JobLogPage } from "./job-logs";
import { EXTERNAL_TOOLS, type ExternalToolName } from "./surface";

/** Who is calling, and where the console a person approves in lives. */
export interface HandlerContext {
	actor: Actor;
	/** The console's origin, e.g. `https://alethialabs.io`; approval links are built on it. */
	appOrigin: string;
}

/** Everything the handlers reach outside themselves, so tests can stand each one in. */
export interface HandlerDeps {
	queuePlan(input: { projectId: string; environmentId: string; key: string }): Promise<{ jobId: string }>;
	queueDeploy(input: {
		projectId: string;
		environmentId: string;
		planJobId: string;
		approvalId: string;
	}): Promise<{ jobId: string }>;
	queueDestroy(input: { projectId: string; environmentId: string; approvalId: string }): Promise<{ jobId: string }>;
	findOwnApproval(actor: Actor, planJobId: string, operation: ApplyOperation): Promise<ApprovalView | null>;
	requestApproval(
		actor: Actor,
		input: { planJobId: string; operation: ApplyOperation; reason?: string | null },
	): Promise<ApprovalView>;
	readApproval(actor: Actor, approvalId: string): Promise<ApprovalView>;
	appliedPlanFor(actor: Actor, projectId: string, environmentId: string): Promise<string>;
	jobStatus(jobId: string): Promise<{ status: string; error_message: string | null }>;
	jobLogPage(jobId: string, afterId: number, limit: number): Promise<JobLogPage>;
	cancelJob(jobId: string): Promise<ActionResult<null>>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/** A refusal a tool answers with: a machine-readable code and a sentence for the person. */
export class McpToolRefusal extends Error {
	/** The machine-readable reason. */
	readonly code: string;

	/** Builds the refusal from its reason and the sentence to show. */
	constructor(code: string, message: string) {
		super(message);
		this.name = "McpToolRefusal";
		this.code = code;
	}
}

/** The statuses after which a job changes no more. */
const FINISHED_JOB_STATUSES: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/** How often `wait_for_job` re-reads what it waits on. */
const WAIT_POLL_MS = 2_000;

/** What `wait_for_job` waits when the caller names no timeout. */
const DEFAULT_WAIT_S = 30;

/** What `wait_for_job` tells a caller to wait before asking again. */
const NEXT_POLL_S = 5;

/** The most log lines one `get_job_logs` call returns. */
const LOG_PAGE_LINES = 500;

/** The prefix that keeps an MCP idempotency key apart from the in-app agent's approval keys. */
const MCP_KEY_PREFIX = "mcp:";

/** The default dependencies: the server actions and reads every other surface uses. */
export const defaultHandlerDeps: HandlerDeps = {
	queuePlan: ({ projectId, environmentId, key }) => planProject(projectId, null, environmentId, key),
	queueDeploy: async ({ projectId, environmentId, planJobId, approvalId }) => {
		const { jobId } = await provisionProject(projectId, planJobId, null, environmentId, null, approvalId);
		return { jobId };
	},
	queueDestroy: async ({ projectId, environmentId, approvalId }) => {
		const { jobId } = await destroyProject(projectId, environmentId, null, { approvalId });
		return { jobId };
	},
	findOwnApproval,
	requestApproval: requestOwnApproval,
	readApproval: readOwnOrgApproval,
	appliedPlanFor,
	jobStatus: readJobStatus,
	jobLogPage: readJobLogPage,
	cancelJob: (jobId) => cancelJob({ jobId }),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

/** The output `request_apply` / `request_destroy` answer for `view`. */
type ApprovalRequestResult = z.input<(typeof EXTERNAL_TOOLS)["request_apply"]["outputSchema"]>;

/** `view` as the approval tools answer it, with the job it started when there is one. */
function approvalResult(view: ApprovalView, ctx: HandlerContext, jobId: string | null): ApprovalRequestResult {
	return {
		approval_id: view.id,
		status: jobId ? "consumed" : view.status,
		approve_url: new URL(approvePath(view.id), ctx.appOrigin).toString(),
		digest_prefix: view.digest_prefix,
		expires_at: view.expires_at,
		job_id: jobId,
	};
}

/**
 * Requests, or completes, `operation` of plan `planJobId` for the caller (steps 1, 3 and 4 in the
 * header). `queue` queues the job for an approved approval; it is handed the approval's own project,
 * environment and plan, read from the record, never from the caller's input.
 */
async function requestOrComplete(
	deps: HandlerDeps,
	ctx: HandlerContext,
	operation: ApplyOperation,
	planJobId: string,
	reason: string | undefined,
	queue: (approval: ApprovalView) => Promise<{ jobId: string }>,
): Promise<ApprovalRequestResult> {
	const own = await deps.findOwnApproval(ctx.actor, planJobId, operation);
	if (own?.status === "consumed" && own.consumed_job_id) {
		return approvalResult(own, ctx, own.consumed_job_id);
	}
	const view =
		own?.status === "approved"
			? own
			: await deps.requestApproval(ctx.actor, { planJobId, operation, reason: reason ?? null });
	if (view.status !== "approved") return approvalResult(view, ctx, null);
	const { jobId } = await queue(view);
	return approvalResult(view, ctx, jobId);
}

/** The schemas of one declared tool. */
interface ToolSchemas<I extends z.ZodObject, O extends z.ZodObject> {
	scope: AgentScope | null;
	inputSchema: I;
	outputSchema: O;
}

/** One served tool: the scope it needs and the call that validates, runs and validates again. */
export interface HandledTool {
	scope: AgentScope | null;
	call(rawInput: unknown, ctx: HandlerContext): Promise<Record<string, unknown>>;
}

/**
 * Pairs a declared tool's schemas with its handler. The input is parsed by the tool's own schema and
 * the result by its own output schema, so a handler can return neither more nor other than the
 * contract says.
 */
function served<I extends z.ZodObject, O extends z.ZodObject>(
	contract: ToolSchemas<I, O>,
	run: (input: z.output<I>, ctx: HandlerContext) => Promise<z.input<O>>,
): HandledTool {
	const output: z.ZodObject = contract.outputSchema;
	return {
		scope: contract.scope,
		call: async (rawInput, ctx) => output.parse(await run(contract.inputSchema.parse(rawInput), ctx)),
	};
}

/** The declared tools this module serves. Every other declared tool is not listed yet. */
export const HANDLED_TOOL_NAMES = [
	"plan",
	"request_apply",
	"request_destroy",
	"wait_for_job",
	"get_job_logs",
	"cancel_job",
] as const satisfies readonly ExternalToolName[];

/** One of {@link HANDLED_TOOL_NAMES}. */
export type HandledToolName = (typeof HANDLED_TOOL_NAMES)[number];

/** True when `name` is a declared tool this module serves. */
export function isHandledToolName(name: string): name is HandledToolName {
	return isEnumMember(name, HANDLED_TOOL_NAMES);
}

/** The handlers, over `deps`. */
export function createHandlers(deps: HandlerDeps = defaultHandlerDeps): Record<HandledToolName, HandledTool> {
	return {
		plan: served(EXTERNAL_TOOLS.plan, async (input) => {
			const { jobId } = await deps.queuePlan({
				projectId: input.project_id,
				environmentId: input.environment_id,
				key: `${MCP_KEY_PREFIX}${input.idempotency_key}`,
			});
			return { job_id: jobId };
		}),

		request_apply: served(EXTERNAL_TOOLS.request_apply, (input, ctx) =>
			requestOrComplete(deps, ctx, "deploy", input.plan_job_id, input.reason, (approval) =>
				deps.queueDeploy({
					projectId: approval.project_id,
					environmentId: approval.environment_id,
					planJobId: approval.plan_job_id,
					approvalId: approval.id,
				}),
			),
		),

		request_destroy: served(EXTERNAL_TOOLS.request_destroy, async (input, ctx) => {
			const planJobId = await deps.appliedPlanFor(ctx.actor, input.project_id, input.environment_id);
			return requestOrComplete(deps, ctx, "destroy", planJobId, input.reason, (approval) =>
				deps.queueDestroy({
					projectId: approval.project_id,
					environmentId: approval.environment_id,
					approvalId: approval.id,
				}),
			);
		}),

		wait_for_job: served(EXTERNAL_TOOLS.wait_for_job, async (input, ctx) => {
			const deadline = deps.now() + (input.timeout_s ?? DEFAULT_WAIT_S) * 1000;
			const { job_id: jobId, approval_id: approvalId } = input;
			for (;;) {
				if (jobId !== undefined) {
					const job = await deps.jobStatus(jobId);
					const done = FINISHED_JOB_STATUSES.has(job.status);
					if (done || deps.now() + WAIT_POLL_MS > deadline) {
						return {
							subject: "job" as const,
							status: job.status,
							stage: null,
							done,
							job_id: jobId,
							next_poll_s: done ? null : NEXT_POLL_S,
						};
					}
				} else {
					// The input schema admits exactly one of job_id and approval_id, so this is the
					// approval; an empty id would read as not found, never as some other approval.
					const approval = await deps.readApproval(ctx.actor, approvalId ?? "");
					const done = approval.status !== "pending";
					if (done || deps.now() + WAIT_POLL_MS > deadline) {
						return {
							subject: "approval" as const,
							status: approval.status,
							stage: null,
							done,
							job_id: approval.consumed_job_id,
							next_poll_s: done ? null : NEXT_POLL_S,
						};
					}
				}
				await deps.sleep(WAIT_POLL_MS);
			}
		}),

		get_job_logs: served(EXTERNAL_TOOLS.get_job_logs, async (input) => {
			const afterId = input.cursor === undefined ? 0 : Number(input.cursor);
			if (!Number.isSafeInteger(afterId) || afterId < 0) {
				throw new McpToolRefusal("invalid_input", "cursor must be the next_cursor a previous call returned.");
			}
			const page = await deps.jobLogPage(input.job_id, afterId, LOG_PAGE_LINES);
			const last = page.lines.at(-1);
			const done = page.settled && page.lines.length < LOG_PAGE_LINES;
			return {
				untrusted_output: page.lines.map((line) => line.log_chunk).join("\n"),
				next_cursor: last ? String(last.id) : input.cursor ?? null,
				done,
			};
		}),

		cancel_job: served(EXTERNAL_TOOLS.cancel_job, async (input) => {
			const result = await deps.cancelJob(input.job_id);
			// A finished or already cancelled job is not an error: cancelling it changes nothing.
			if (!result.ok && result.error.kind !== "conflict") {
				throw new McpToolRefusal(
					result.error.kind,
					"message" in result.error ? result.error.message : "The job could not be cancelled.",
				);
			}
			const { status } = await deps.jobStatus(input.job_id);
			return { job_id: input.job_id, status };
		}),
	};
}
