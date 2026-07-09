// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { z } from "zod";
import { saveThreadMessages } from "@/app/server/actions/agent";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import { summarizeCanvas } from "@/lib/ai/canvas-context";
import {
	formatMentionsForPrompt,
	type Mention,
	mentionsSchema,
} from "@/lib/ai/mentions";
import {
	advisorThinkingOptions,
	cachedSystemMessage,
} from "@/lib/ai/provider-options";
import { buildProjectAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import { getAdvisorModel, getExecutorModel, isAiConfigured } from "@/lib/config/ai";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ProjectAssistantBody {
	messages: UIMessage[];
	/** Live canvas snapshot when the canvas is active (undefined on the form view). */
	canvas?: CanvasContext;
	/** When set, the transcript is persisted to this (project-scoped) thread on finish. */
	threadId?: string;
	/** Resources the user @-referenced in the latest message. */
	mentions?: Mention[];
	/**
	 * Per-message opt-in to the Opus advisor ("deep reasoning"). Only effective on `ai_max`
	 * (the advisor selection guards it); ignored on every other tier.
	 */
	deepReasoning?: boolean;
}

/** Parse the optional `deepReasoning` flag from a request body — defaults to false. */
const deepReasoningSchema = z.boolean().catch(false);

/** Project-page assistant system prompt — drives the "A" loop for one project. */
function systemPrompt(projectId: string, canvas: CanvasContext | undefined): string {
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
		"- Emit ONE `propose_changes` (set_identity on `project-root` / add_node / update_config) to add or",
		"  change resources; the user accepts them onto the canvas. Use `list_service_options(provider)` to map",
		"  vague sizes onto real instance types / capacities, `cidr_for_hosts` for a network, `estimate_cost`",
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
		"  - repositories: apps_destination_repo",
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
		"",
		"Rules: CORE resources (cluster, network, database, cache, queue, topic, nosql) all run on the project's",
		"single cloud; periphery (dns, secret, repositories) may diverge — never place a core resource on a",
		"different cloud than the cluster. Use real values from tools; never invent ids, regions, instance types,",
		"or credentials. Be terse, concrete, grayscale in tone. No emoji.",
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
	const {
		messages,
		canvas,
		threadId,
		mentions,
		deepReasoning: deepReasoningRaw,
	}: ProjectAssistantBody = await req.json();
	const deepReasoning = deepReasoningSchema.parse(deepReasoningRaw);

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

	// Cost-optimized orchestration: a tier-derived ADVISOR plans step 0, then a cheap Haiku
	// EXECUTOR runs the tool loop (ai_free = Haiku throughout — no distinct advisor). The advisor
	// is Sonnet by default; on ai_max the per-message `deepReasoning` opt-in upgrades it to Opus.
	const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
	const executor = getExecutorModel();
	const advisor = getAdvisorModel(tier, { deepReasoning });
	/** The canonical key metered for a given step (step 0 = advisor; the rest = executor). */
	const modelForStep = (stepNumber: number): string =>
		stepNumber === 0 ? advisor.key : executor.key;

	const parsedMentions = mentionsSchema.safeParse(mentions);
	const mentionBlock = parsedMentions.success
		? formatMentionsForPrompt(parsedMentions.data)
		: "";
	const system = mentionBlock
		? `${systemPrompt(projectId, canvas)}\n\n${mentionBlock}`
		: systemPrompt(projectId, canvas);

	const result = streamText({
		model: executor.model,
		// Cache the (stable) system prompt so repeated turns read it from cache.
		messages: [
			cachedSystemMessage(system),
			...(await convertToModelMessages(messages)),
		],
		// Our own system prompt (cached) is intentionally a system message; user turns are
		// never system-role, so this is not a prompt-injection surface.
		allowSystemInMessages: true,
		tools: buildProjectAgentTools(canvas),
		stopWhen: stepCountIs(8),
		// Step 0 runs on the advisor; the rest use the executor. A distinct Anthropic advisor
		// also gets adaptive extended thinking for the planning step.
		prepareStep: ({ stepNumber }) =>
			stepNumber === 0
				? {
						model: advisor.model,
						providerOptions: advisorThinkingOptions(advisor, executor),
					}
				: {},
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
	});

	return result.toUIMessageStreamResponse({
		originalMessages: messages,
		onFinish: ({ messages }) => {
			if (threadId) void saveThreadMessages(threadId, messages);
		},
	});
}
