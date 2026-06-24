// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import { summarizeCanvas } from "@/lib/ai/canvas-context";
import { buildSpecAssistantTools } from "@/lib/ai/tools";

interface AskAiBody {
	messages: UIMessage[];
	canvas?: CanvasContext;
}

function systemPrompt(canvas: CanvasContext | undefined): string {
	return [
		"You are Alethia's design-spec assistant. You compose multi-cloud infrastructure on a",
		"visual canvas by PROPOSING changes the user accepts — you never apply anything yourself.",
		"",
		'Workflow for a build request (e.g. "an EKS cluster + an RDS db of size X + a new VPC for',
		'~511 hosts + redis & valkey caches"):',
		"1. Call `list_cloud_identities`; pick the verified account that matches the request",
		"   (EKS/RDS→aws, GKE→gcp, AKS→azure). If none is verified, ask the user to connect one.",
		"2. Call `list_service_options` for that provider; map vague sizes ('size X', 'large') onto",
		"   real instance types / db capacity / cache node types / k8s versions / regions from it.",
		"3. If the user gives a host count for a new network, call `cidr_for_hosts` and use the",
		"   returned cidr as the network's `cidr_block`.",
		"4. Emit ONE `propose_changes` containing, in order:",
		"   - `set_identity` on the project node (id `project-root`) with the chosen cloud identity id;",
		"   - `update_config` on `project-root` for `region` (+ `project_name`/`environment_stage` if implied);",
		"   - one `add_node` per resource with a valid `config`. If a singleton already exists on the",
		"     canvas (see Nodes list), use `update_config` on its id instead of `add_node`.",
		"5. Finish with a 1–2 sentence summary + any assumptions.",
		"",
		"add_node config keys by kind:",
		"- cluster: cluster_version, instance_types (string[]), node_min_size, node_desired_size,",
		"  node_max_size, provider_config ({enable_karpenter|enable_autopilot|enable_cluster_autoscaler:true})",
		"- network: provision_network (true), cidr_block, single_nat_gateway",
		"- database: name, engine, engine_version, min_capacity, max_capacity, port (5432), iam_auth",
		'- cache: name, engine ("redis"|"valkey"), node_type, num_cache_nodes, multi_az',
		"- queue: name, ordered, visibility_timeout  · topic: name",
		'- nosql: name, partition_key, partition_key_type ("S"|"N"|"B"), capacity_mode, point_in_time_recovery',
		"- dns: enabled, domain_name, managed_certificate, waf_enabled · secret: name, generate, length, special_chars",
		"- repositories: apps_destination_repo",
		"",
		"You can also answer questions about the user's account using read tools (these run",
		"immediately, no proposal needed):",
		"- `list_specs` / `get_spec`, `list_zones` — saved specs + workspaces.",
		"- `list_jobs` / `get_job` / `get_plan_result` — provisioning job status + errors.",
		"- `list_clusters` — what's provisioned/live (endpoints, dbs, caches).",
		"- `list_runners` — execution agents. `list_connectors` — connected providers.",
		"- `get_cached_resources(cloudIdentityId)` — an account's EXISTING VPCs/subnets, to reuse a",
		"  VPC or avoid CIDR clashes when composing a network.",
		"Plan / deploy can't be triggered from chat yet — point the user to the Plan / Create-spec UI.",
		"",
		"Rules:",
		"- CORE resources (cluster, network, database, cache, queue, topic, nosql) all run on the stack's",
		"  single cloud; PERIPHERY (dns, secret, repositories) may diverge. Never place a core resource on a",
		"  different cloud than the cluster.",
		"- Use real values from the tools; never invent node ids, regions, instance types, or credentials.",
		"  If an ask has no matching field (e.g. 'WIF' is a GCP auth concept, not an EKS toggle), say so",
		"  briefly instead of inventing it. Use `estimate_cost` when asked about price.",
		"- Be terse and concrete.",
		"",
		"Current canvas:",
		summarizeCanvas(canvas),
	].join("\n");
}

export async function POST(req: Request) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response(
			"AI is not configured. Set AI_GATEWAY_API_KEY to enable the assistant.",
			{ status: 503 },
		);
	}

	const actor = await currentActor();
	const charge = await assertAiAllowed(actor.orgId, "agent").catch(
		(e: unknown) => {
			if (e instanceof AiBudgetError) return e;
			throw e;
		},
	);
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

	const { messages, canvas }: AskAiBody = await req.json();
	const modelId = getAiModel();

	const result = streamText({
		model: modelId,
		system: systemPrompt(canvas),
		messages: await convertToModelMessages(messages),
		tools: buildSpecAssistantTools(canvas),
		stopWhen: stepCountIs(8),
		// Record once the run completes, with the real token usage for cost-of-serve.
		onFinish: ({ usage }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				credits: charge.credits,
				source: charge.source,
				model: modelId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
			});
		},
	});

	return result.toUIMessageStreamResponse();
}
