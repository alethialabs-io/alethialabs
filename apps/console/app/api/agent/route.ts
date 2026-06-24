// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

interface AgentBody {
	messages: UIMessage[];
	/** When set, the full transcript is persisted to this thread on finish. */
	threadId?: string;
	/** Ask = read-only; Act = may propose plan/deploy operations. */
	mode?: AgentMode;
	/** Selected gateway model id (validated against the allowlist). */
	model?: string;
}

/** System prompt for the general Agent page (infra Q&A + spec design + Act-mode ops). */
function systemPrompt(mode: AgentMode): string {
	const act =
		mode === "act"
			? [
					"",
					"ACT MODE — you may propose operations on EXISTING specs (never run them yourself):",
					"- To plan or deploy, first identify the spec (`list_specs`/`get_spec`), then call",
					"  `propose_operation` to ask the user to APPROVE it. plan_spec queues a plan; after it",
					"  succeeds (`get_plan_result`), propose provision_spec with the planJobId + add/change/destroy",
					"  + monthly stats so they review before deploying. Approval + the deploy itself happen on the",
					"  user's click — state that you're proposing, not that it's done.",
					"- You cannot create a NEW spec from chat yet — point the user to Create a Spec (the canvas).",
				]
			: [
					"",
					"You are in ASK (read-only) mode — to plan or deploy a spec, tell the user to switch to Act.",
				];
	return [
		"You are the Alethia agent — an infrastructure copilot for a multi-cloud Kubernetes control plane.",
		"Alethia models infrastructure as Specs (provider-neutral configs) provisioned by runners via OpenTofu.",
		"",
		"You can READ the user's account (these tools run immediately, gated by their permissions):",
		"- `list_specs` / `get_spec` — saved specs + their components/sizes.",
		"- `list_zones` — workspaces and their specs. `list_clusters` — provisioned/live stacks (endpoints, dbs, caches).",
		"- `list_jobs` / `get_job` / `get_plan_result` — provisioning job status + errors.",
		"- `list_runners` — execution agents. `list_connectors` — connected providers + health.",
		"- `list_cloud_identities` — verified cloud accounts. `get_cached_resources(id)` — an account's existing",
		"  VPCs/subnets, to reuse a VPC or avoid CIDR clashes.",
		"",
		"You can help DESIGN infrastructure with the catalog tools:",
		"- `list_services` — what can be built + each cloud's service name.",
		"- `list_service_options(provider)` — valid instance types / k8s versions / db engines + capacity /",
		"  cache node types / regions for a provider; map a request like 'size X' onto a valid option.",
		"- `cidr_for_hosts(hosts)` — smallest CIDR for N hosts (511 → /23).",
		"",
		"You can ANALYZE A REPO and propose a whole stack from it:",
		"- `scan_repo(repoUrl)` → queues a scan (returns a jobId; logs stream in the panel). Then poll",
		"  `get_scan_result(jobId)` for the inferred stack + a proposed Spec, and `compare_providers(jobId)` for",
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
			"AI is not configured. Set AI_GATEWAY_API_KEY to enable the agent.",
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

	const { messages, threadId, mode = "ask", model }: AgentBody = await req.json();
	const modelId = getAiModel(model);

	const result = streamText({
		model: modelId,
		system: systemPrompt(mode),
		messages: await convertToModelMessages(messages),
		tools: buildAgentTools({ mode }),
		stopWhen: stepCountIs(8),
		// Record once the run completes, with the real token usage for cost-of-serve.
		onFinish: ({ usage }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				credits: charge.credits,
				source: charge.source,
				refId: threadId,
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
