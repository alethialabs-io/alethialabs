// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
} from "ai";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { AGENT_STEP_PART_TYPE, agentStepMarker } from "@/lib/ai/agent-steps";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import { summarizeCanvas } from "@/lib/ai/canvas-context";
import {
	buildEnvironmentKnowledge,
	type EnvironmentKnowledge,
} from "@/lib/ai/environment-knowledge";
import { formatMentionsForPrompt } from "@/lib/ai/mentions";
import {
	type AssistantView,
	parseProjectAssistantBody,
} from "@/lib/ai/project-assistant-body";
import {
	buildProjectKnowledge,
	formatContextBlock,
	readAgentContext,
} from "@/lib/ai/project-knowledge";
import {
	cachedSystemMessage,
	thinkingOptions,
} from "@/lib/ai/provider-options";
import { buildProjectAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import {
	AiBudgetError,
	type AiHoldContext,
	assertAiAllowed,
	releaseAiHold,
} from "@/lib/billing/ai-guard";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import { getAdvisorModel, getExecutorModel, isAiConfigured } from "@/lib/config/ai";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * What the conversation is scoped to: the resolved environment (null when the project has none
 * the caller can see), its name for the model to use in prose, and where the user is looking.
 */
interface PromptScope {
	environmentId: string | null;
	environmentName: string | null;
	view: AssistantView | undefined;
}

/**
 * The Scope paragraph: which environment the conversation is about, and the rule that every
 * proposal must name it. Before this existed the assistant never knew which environment the
 * user was looking at, so its plan/deploy proposals — and the approval card that ran them —
 * targeted the project's DEFAULT environment whatever the topbar switcher said.
 */
function scopeParagraph(scope: PromptScope): string[] {
	const lines = ["SCOPE:"];
	if (scope.environmentId) {
		const name = scope.environmentName ? `"${scope.environmentName}"` : "(name not visible)";
		lines.push(
			`- This conversation is scoped to environment ${name} (id: ${scope.environmentId}) of this project.`,
			`  Every \`propose_operation\` MUST carry \`environmentId: ${scope.environmentId}\` — an omitted id`,
			"  targets the project's DEFAULT environment, which may not be the one the user is looking at.",
		);
	} else {
		// NOT "the default environment will be used". The resolver already falls back to the default
		// and even repairs a foreign id, so reaching this branch means the project has no environment
		// at all — promising a default here describes one that does not exist, and the model would go
		// on to propose a deploy that cannot run and report it as queued.
		lines.push(
			"- This project has NO environment yet, so there is nothing to plan or deploy against.",
			"  Do not propose an operation: say that an environment has to be created first.",
		);
	}
	if (scope.view) {
		const card = scope.view.openCard
			? ` with the ${scope.view.openCard.kind} card${scope.view.openCard.name ? ` "${scope.view.openCard.name}"` : ""} open`
			: "";
		lines.push(`- The user is on the ${scope.view.surface} surface (${scope.view.path})${card}.`);
	}
	lines.push(
		"- The thread is project-scoped and the environment can change between turns: if earlier",
		"  turns in this thread discussed a different environment, say so before acting.",
	);
	return lines;
}

/** Project-page assistant system prompt — drives the "A" loop for one project. */
function systemPrompt(
	projectId: string,
	canvas: CanvasContext | undefined,
	scope: PromptScope,
): string {
	return [
		`You are Alethia's project assistant for this project (id: ${projectId}).`,
		"Alethia provisions a Kubernetes cluster + ArgoCD on the user's cloud and wires GitOps to deploy",
		"their apps. You help the user understand & edit this project's infrastructure, scan their repos to",
		"infer what to provision, review the verification gate, provision (plan → deploy), and answer day-2",
		"questions. You PROPOSE; the user approves — you never apply anything yourself.",
		"",
		"Always start by calling `get_project` with this project's id to ground yourself in its current design.",
		"",
		"SCAN A REPO → INFER INFRA:",
		"- `scan_repo(repoUrl)` queues a scan; poll `get_scan_result(jobId)` for the inferred stack + a",
		"  proposed project, and `compare_providers(jobId)` for per-cloud cost. Summarize the inferred needs",
		"  and rationale; when ready, point the user to review it (the result includes an openInCanvasUrl).",
		"",
		"EDIT THE DESIGN:",
		"- Emit ONE `propose_changes` (set_identity on `project-root` / add_node / update_config /",
		"  remove_node) to add, reconfigure, or REMOVE resources. A proposal is applied only when the user",
		"  accepts it, and they are shown the EXACT actions first — so say what you mean plainly.",
		"  Resolve \"this\" / \"it\" / \"that\" to the node the user is focused on (marked SELECTED or OPEN",
		"  in the node list above) unless they name a different one.",
		"  The user accepts them onto the canvas. Use `list_service_options(provider)` to map",
		"  vague sizes onto real instance types / capacities, `cidr_for_hosts` for a network (pass this",
		"  project's `cloud` — the per-cloud subnet floors differ and the apply gate enforces them), `estimate_cost`",
		"  for price. If a singleton already exists, `update_config` its id instead of `add_node`.",
		"  add_node config keys by kind:",
		"  - cluster: cluster_version, instance_types (string[]), node_min_size, node_desired_size,",
		"    node_max_size, provider_config ({enable_karpenter|enable_autopilot|enable_cluster_autoscaler:true})",
		"  - network: provision_network (true), cidr_block, single_nat_gateway",
		"  - database: name, engine, engine_version, min_capacity, max_capacity, port (5432), iam_auth",
		'  - cache: name, engine ("redis"|"valkey"), node_type, num_cache_nodes, multi_az',
		"  - queue: name, ordered, visibility_timeout · topic: name",
		'  - nosql: name, partition_key, partition_key_type ("S"|"N"|"B"), capacity_mode, point_in_time_recovery',
		"  - dns: enabled, domain_name, managed_certificate, waf_enabled · secret: name, generate, length",
		'  - repositories: apps_destination_repo, apps_path (repo-relative overlay subpath, e.g. "overlays/dev"; empty = repo root; read on EVERY placement — on a dedicated cluster an empty value also enables overlays/* discovery, which naming a path replaces)',
		"",
		"PROVISION (plan → deploy) WITH PROOF:",
		"- To plan or deploy, call `propose_operation` to ask the user to APPROVE (never run it yourself).",
		"  plan_project queues a PLAN job; after it succeeds (`get_plan_result`), the elench verification gate's",
		"  verdict + signed receipt are in the result — review them with the user. Then propose provision_project",
		"  with the planJobId + add/change/destroy + monthly stats so they review the proof before deploying.",
		"  Approval + the deploy happen on the user's click — state that you're proposing, not that it's done.",
		"",
		"DAY-2: use read tools for status — `list_jobs`/`get_job` (job status + errors), `list_clusters` (live",
		"endpoints/dbs/caches), `list_runners`, `list_connectors`, `list_cloud_identities`, `get_cached_resources(id)`.",
		"`search_docs` — the Alethia docs; GROUND how-to / how-it-works answers (connectors, keyless auth,",
		"architecture) with it instead of guessing. Cloud connectors are KEYLESS (OIDC federation, no stored",
		"keys); if the user needs a cloud that isn't connected, point them to the Connectors page to connect it.",
		"",
		"Rules: CORE resources (cluster, network, database, cache, queue, topic, nosql) all run on the project's",
		"single cloud; periphery (dns, secret, repositories) may diverge — never place a core resource on a",
		"different cloud than the cluster. Use real values from tools; never invent ids, regions, instance types,",
		"or credentials. Be terse, concrete, grayscale in tone. No emoji.",
		"",
		...scopeParagraph(scope),
		"",
		"Current canvas:",
		summarizeCanvas(canvas),
	].join("\n");
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response(
			"AI is not configured. Set ANTHROPIC_API_KEY to enable the assistant.",
			{ status: 503 },
		);
	}

	const { projectId } = await params;
	const actor = await currentActor();
	// The body shape is shared with the client's `prepareBody` (lib/ai/project-assistant-body.ts),
	// so the two cannot drift. It degrades rather than throws — a shape this route used to accept
	// must not become a 500, and this runs BEFORE the AI budget hold, so a rejection here costs
	// nothing. Only `messages` is genuinely required. `environmentId` is the environment the user
	// is looking at (a malformed one degrades to null) and `view` is where in the product they are.
	const body = parseProjectAssistantBody(await req.json().catch(() => null));
	if (!body.ok) return new Response(body.message, { status: 400 });
	const {
		messages,
		canvas,
		threadId,
		mentions,
		deepReasoning,
		environmentId: requestedEnvironmentId,
		view,
	} = body.value;

	// Metered turn: gate on headroom (the real cost-of-serve is settled after it runs). The
	// deep-reasoning flag no longer affects the charge — Opus just settles its own real cost.
	const charge = await assertAiAllowed(actor.orgId, "agent", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) return e;
		throw e;
	});
	if (charge instanceof AiBudgetError) {
		return new Response(
			JSON.stringify({
				error: charge.message,
				reason: charge.reason,
				resetAt: charge.resetAt,
				upgradable: charge.upgradable,
			}),
			{ status: 402, headers: { "content-type": "application/json" } },
		);
	}

	// Everything from here through the streamText registration runs AFTER the hold was reserved; a
	// throw in this window (tier/mentions resolution, message conversion, tool build) would strand
	// the ≈$0.10 hold — nothing downstream releases it — so release it in the catch.
	const holdCtx: AiHoldContext = {
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "agent",
		refId: threadId ?? projectId,
	};
	try {
		// Cost-optimized orchestration: a tier-derived ADVISOR plans step 0, then a cheap Haiku
		// EXECUTOR runs the tool loop (ai_free = Haiku throughout — no distinct advisor). The advisor
		// is Sonnet by default; on ai_max the per-message `deepReasoning` opt-in upgrades it to Opus.
		const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
		const executor = getExecutorModel();
		const advisor = getAdvisorModel(tier, { deepReasoning });
		/** The canonical key metered for a given step (step 0 = advisor; the rest = executor). */
		const modelForStep = (stepNumber: number): string =>
			stepNumber === 0 ? advisor.key : executor.key;

		// No second validation here. `mentions` has already been through the SAME `mentionsSchema` in
		// the body parser, so this `safeParse` could not fail and its `: ""` fallback was
		// unreachable — dead code that read as a safety net. The behaviour it looked like it was
		// protecting is intact and lives at the schema instead: the field is
		// `mentionsSchema.catch(undefined)`, so an over-long or malformed list degrades to no
		// mentions rather than rejecting the turn. Losing the @-mentions is a smaller failure than
		// losing the message, which is why that field catches and `messages` does not. Found in
		// review.
		const mentionBlock = mentions ? formatMentionsForPrompt(mentions) : "";

		// The Claude-Projects model: this chat lives inside an infra project, so it inherits that
		// project's pinned instructions + knowledge — layered UNDER the org-level ones (org policy
		// first, project specifics second) — plus a derived block of the project's live state, so
		// the very first answer is grounded without a tool round-trip. A project's context never
		// leaks out to org chats.
		// Pass the actor (not just owner): the agent-context reads are scope-flag-aware — off, they
		// read under the user id (unchanged); on, org/project rows are org-shared. See
		// lib/ai/org-agent-context-flag.ts.
		// The environment this turn is about. `resolveActiveEnvironmentId` validates the requested
		// id belongs to THIS project under the caller's org and falls back to the project's default
		// — so a foreign or stale id from the client can never scope the prompt to another tenant's
		// environment. A project with no visible default resolves to null and the prompt says so.
		const environmentId = await resolveActiveEnvironmentId(
			projectId,
			requestedEnvironmentId ?? undefined,
		).catch(() => null);
		const noEnvironment: EnvironmentKnowledge = { name: null, block: "" };

		const [orgCtx, projectCtx, derived, environment] = await Promise.all([
			readAgentContext(actor, null).catch(() => null),
			readAgentContext(actor, projectId).catch(() => null),
			buildProjectKnowledge(actor, projectId, environmentId).catch(() => ""),
			environmentId
				? buildEnvironmentKnowledge(actor, projectId, environmentId).catch(
						() => noEnvironment,
					)
				: Promise.resolve(noEnvironment),
		]);

		const system = [
			systemPrompt(projectId, canvas, {
				environmentId,
				environmentName: environment.name,
				view,
			}),
			formatContextBlock("Organization", orgCtx),
			formatContextBlock("Project", projectCtx),
			derived,
			environment.block,
			mentionBlock,
		]
			.filter(Boolean)
			.join("\n\n");

		const modelMessages = await convertToModelMessages(messages);

		// Wrap streamText in a UI message stream so orchestration markers (`data-agent-step`
		// parts) interleave with the model's own parts (PLAN/EXECUTE separators).
		const stream = createUIMessageStream({
			originalMessages: messages,
			execute: ({ writer }) => {
				const result = streamText({
					model: executor.model,
					// Cache the (stable) system prompt so repeated turns read it from cache.
					messages: [cachedSystemMessage(system), ...modelMessages],
					// Our own system prompt (cached) is intentionally a system message; user turns are
					// never system-role, so this is not a prompt-injection surface.
					allowSystemInMessages: true,
					// Wire the request's abort signal so a client disconnect aborts generation (and fires
					// onAbort) instead of streaming — and paying — into the void with the hold left open.
					abortSignal: req.signal,
					tools: buildProjectAgentTools(canvas, { environmentId }),
					stopWhen: stepCountIs(8),
					// Step 0 runs on the advisor; the rest use the executor. The planning step gets
					// extended thinking on EVERY tier so reasoning streams to the transcript.
					prepareStep: ({ stepNumber }) => {
						const marker = agentStepMarker({
							stepNumber,
							clientPick: false,
							advisorKey: advisor.key,
							executorKey: executor.key,
							baseKey: executor.key,
						});
						if (marker) {
							writer.write({
								type: AGENT_STEP_PART_TYPE,
								id: `step-${stepNumber}`,
								data: marker,
							});
						}
						return stepNumber === 0
							? { model: advisor.model, providerOptions: thinkingOptions(advisor) }
							: {};
					},
					// Meter PER MODEL: advisor + executor tokens are ledgered separately (correct cost_micros).
					onFinish: ({ steps }) => {
						void recordAgentTurnUsage({
							orgId: actor.orgId,
							userId: actor.userId,
							kind: "agent",
							charge,
							refId: threadId ?? projectId,
							steps: steps.map((s, i) => ({
								model: modelForStep(i),
								usage: {
									inputTokens: s.usage.inputTokens,
									outputTokens: s.usage.outputTokens,
									cachedInputTokens: s.usage.cachedInputTokens,
								},
							})),
						});
					},
					// A failed turn RELEASES its reserved hold (reconciled to 0) so it never leaks headroom.
					onError: ({ error }) => {
						void recordAiUsage({
							orgId: actor.orgId,
							userId: actor.userId,
							kind: "agent",
							source: charge.source,
							holdId: charge.settle ? charge.holdId : undefined,
							refId: threadId ?? projectId,
							model: executor.key,
							isError: true,
							error: error instanceof Error ? error.message : String(error),
						}).catch(meteringFailed(actor.orgId));
					},
					// Client disconnect mid-stream: onFinish/onError won't fire, so RELEASE the hold here
					// (mutually exclusive with them) — otherwise an abandoned turn leaks its ≈$0.10 hold.
					onAbort: () => {
						void releaseAiHold(charge, holdCtx);
					},
				});
				writer.merge(result.toUIMessageStream());
			},
			onFinish: ({ messages: finished }) => {
				if (threadId) void saveThreadMessages(threadId, finished);
			},
		});

		return createUIMessageStreamResponse({ stream });
	} catch (e) {
		// A throw between the gate and stream registration strands the hold — release it before rethrow.
		await releaseAiHold(charge, holdCtx);
		throw e;
	}
}
