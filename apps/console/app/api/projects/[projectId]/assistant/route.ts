// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { saveThreadMessages } from "@/app/server/actions/agent";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import { summarizeCanvas } from "@/lib/ai/canvas-context";
import { buildProjectAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

export const runtime = "nodejs";
export const maxDuration = 300;

interface ProjectAssistantBody {
	messages: UIMessage[];
	/** Live canvas snapshot when the canvas is active (undefined on the form view). */
	canvas?: CanvasContext;
	/** When set, the transcript is persisted to this (project-scoped) thread on finish. */
	threadId?: string;
}

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
			"AI is not configured. Set AI_GATEWAY_API_KEY to enable the assistant.",
			{ status: 503 },
		);
	}

	const { projectId } = await params;
	const actor = await currentActor();
	const charge = await assertAiAllowed(actor.orgId, "agent").catch((e: unknown) => {
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

	const { messages, canvas, threadId }: ProjectAssistantBody = await req.json();
	const modelId = getAiModel();

	const result = streamText({
		model: modelId,
		system: systemPrompt(projectId, canvas),
		messages: await convertToModelMessages(messages),
		tools: buildProjectAgentTools(canvas),
		stopWhen: stepCountIs(8),
		onFinish: ({ usage }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				credits: charge.credits,
				source: charge.source,
				refId: threadId ?? projectId,
				model: modelId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
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
