// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { z } from "zod";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { AGENT_STEP_PART_TYPE, agentStepMarker } from "@/lib/ai/agent-steps";
import {
	formatMentionsForPrompt,
	type Mention,
	mentionsSchema,
} from "@/lib/ai/mentions";
import {
	cachedSystemMessage,
	thinkingOptions,
} from "@/lib/ai/provider-options";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import {
	getAdvisorModel,
	getExecutorModel,
	isAiConfigured,
	isSelectableModel,
	resolveModel,
} from "@/lib/config/ai";

interface AgentBody {
	messages: UIMessage[];
	/** When set, the full transcript is persisted to this thread on finish. */
	threadId?: string;
	/** Ask = read-only; Act = may propose plan/deploy operations. */
	mode?: AgentMode;
	/** Selected model id (validated against the allowlist). */
	model?: string;
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

/** System prompt for the general Agent page (infra Q&A + project design + Act-mode ops). */
function systemPrompt(mode: AgentMode): string {
	const act =
		mode === "act"
			? [
					"",
					"ACT MODE — you may propose operations on EXISTING projects (never run them yourself):",
					"- To plan or deploy, first identify the project (`list_projects`/`get_project`), then call",
					"  `propose_operation` to ask the user to APPROVE it. plan_project queues a plan; after it",
					"  succeeds (`get_plan_result`), propose provision_project with the planJobId + add/change/destroy",
					"  + monthly stats so they review before deploying. Approval + the deploy itself happen on the",
					"  user's click — state that you're proposing, not that it's done.",
					"- You cannot create a NEW project from chat yet — point the user to Create a Project (the canvas).",
				]
			: [
					"",
					"You are in ASK (read-only) mode — to plan or deploy a project, tell the user to switch to Act.",
				];
	return [
		"You are the Alethia agent — an infrastructure copilot for a multi-cloud Kubernetes control plane.",
		"Alethia models infrastructure as Projects (provider-neutral configs) provisioned by runners via OpenTofu.",
		"",
		"You can READ the user's account (these tools run immediately, gated by their permissions):",
		"- `list_projects` / `get_project` — saved projects + their components/sizes.",
		"- `list_clusters` — provisioned/live stacks (endpoints, dbs, caches).",
		"- `list_jobs` / `get_job` / `get_plan_result` — provisioning job status + errors.",
		"- `list_runners` — execution agents. `list_connectors` — connected providers + health.",
		"- `list_cloud_identities` — verified cloud accounts. `get_cached_resources(id)` — an account's existing",
		"  VPCs/subnets, to reuse a VPC or avoid CIDR clashes.",
		"- `search_docs` — the Alethia docs (connectors, keyless OIDC auth, architecture, CLI, self-hosting).",
		"  GROUND how-to / how-it-works answers with it (esp. 'how do I connect <cloud>') instead of guessing.",
		"- `connect_cloud(provider)` — surface a one-click action that opens the connect sheet for a cloud.",
		"Cloud connectors are KEYLESS — Alethia stores no keys; it federates via its own OIDC issuer. Design",
		"onto an ALREADY-connected account: call `list_cloud_identities` first, and its provider fixes the valid",
		"service options. If the cloud the user wants (or asks to connect) isn't connected, call",
		"`connect_cloud(provider)` so they can connect it in one click.",
		"",
		"You can help DESIGN infrastructure with the catalog tools:",
		"- `list_services` — what can be built + each cloud's service name.",
		"- `list_service_options(provider)` — valid instance types / k8s versions / db engines + capacity /",
		"  cache node types / regions for a provider; map a request like 'size X' onto a valid option.",
		"- `cidr_for_hosts(hosts)` — smallest CIDR for N hosts (511 → /23).",
		"",
		"You can ANALYZE A REPO and propose a whole stack from it:",
		"- `scan_repo(repoUrl)` → queues a scan (returns a jobId; logs stream in the panel). Then poll",
		"  `get_scan_result(jobId)` for the inferred stack + a proposed Project, and `compare_providers(jobId)` for",
		"  the cost on each cloud. When ready, tell the user to open it in the canvas (the result includes an",
		"  openInCanvasUrl) to review/edit before deploying. Summarize the inferred needs + their rationale.",
		"",
		"Rules:",
		"- Use real values from the tools; never invent ids, regions, instance types, or credentials.",
		"- Be terse, concrete, and grayscale in tone. No emoji.",
		...act,
	].join("\n");
}

export async function POST(req: Request) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response(
			"AI is not configured. Set ANTHROPIC_API_KEY to enable the agent.",
			{ status: 503 },
		);
	}

	const actor = await currentActor();
	const {
		messages,
		threadId,
		mode = "ask",
		model,
		mentions,
		deepReasoning: deepReasoningRaw,
	}: AgentBody = await req.json();
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
	// An explicit client model pick overrides orchestration with that single deliberate choice.
	const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
	const executor = getExecutorModel();
	const advisor = getAdvisorModel(tier, { deepReasoning });
	const clientPick = isSelectableModel(model) ? model : null;
	// The base run: the client's explicit pick, else the cheap executor. Step 0 upgrades to the
	// advisor (via prepareStep) unless the user forced a pick.
	const base = clientPick ? resolveModel(clientPick) : executor;
	/** The canonical key metered for a given step (step 0 = advisor unless the user forced a pick). */
	const modelForStep = (stepNumber: number): string =>
		!clientPick && stepNumber === 0 ? advisor.key : base.key;

	// Resolve @-mentions into a prompt block so the model knows what each ref points to.
	const parsedMentions = mentionsSchema.safeParse(mentions);
	const mentionBlock = parsedMentions.success
		? formatMentionsForPrompt(parsedMentions.data)
		: "";
	const system = mentionBlock
		? `${systemPrompt(mode)}\n\n${mentionBlock}`
		: systemPrompt(mode);

	const modelMessages = await convertToModelMessages(messages);

	// Wrap streamText in a UI message stream so orchestration markers (`data-agent-step`
	// parts) interleave with the model's own parts — the transcript renders them as
	// PLAN/EXECUTE separators showing which model owns each phase.
	const stream = createUIMessageStream({
		originalMessages: messages,
		execute: ({ writer }) => {
			const result = streamText({
				model: base.model,
				// Cache the (stable) system prompt so repeated turns read it from cache.
				messages: [cachedSystemMessage(system), ...modelMessages],
				// Our own system prompt (cached) is intentionally a system message; user turns are
				// never system-role, so this is not a prompt-injection surface.
				allowSystemInMessages: true,
				tools: buildAgentTools({ mode }),
				stopWhen: stepCountIs(8),
				// A forced pick runs one model on every step — it thinks throughout.
				providerOptions: clientPick ? thinkingOptions(base) : undefined,
				// Step 0 runs on the advisor (unless the user forced a model); the rest use the
				// executor. The planning step gets extended thinking on EVERY tier (the free
				// tier's Haiku advisor included) so reasoning streams to the transcript.
				prepareStep: ({ stepNumber }) => {
					const marker = agentStepMarker({
						stepNumber,
						clientPick: !!clientPick,
						advisorKey: advisor.key,
						executorKey: executor.key,
						baseKey: base.key,
					});
					if (marker) {
						writer.write({
							type: AGENT_STEP_PART_TYPE,
							id: `step-${stepNumber}`,
							data: marker,
						});
					}
					if (clientPick) return {};
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
						refId: threadId,
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
			writer.merge(result.toUIMessageStream());
		},
		onFinish: ({ messages: finished }) => {
			if (threadId) void saveThreadMessages(threadId, finished);
		},
	});

	return createUIMessageStreamResponse({ stream });
}
