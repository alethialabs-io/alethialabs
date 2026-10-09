// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { z } from "zod";
import { serveTurn } from "@/lib/agent/turn-route";
import { formatMentionsForPrompt } from "@/lib/ai/mentions";
import { formatContextBlock, readAgentContext } from "@/lib/ai/project-knowledge";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import {
	getAdvisorModel,
	getExecutorModel,
	isSelectableModel,
	resolveModel,
} from "@/lib/config/ai";

/**
 * The org route's own body fields, validated before the budget hold. `mode` picks the prompt and the
 * tool set: an unknown value used to run silently as Ask. `threadId` is checked as a uuid by the shared
 * route body (`lib/agent/turn-route.ts`). `deepReasoning` degrades rather than rejects: losing a hint is
 * a smaller failure than losing the turn. The turn's mentions and cell target are not body fields: they
 * ride the user message's own `metadata`, which the shared route body stores and reads (§9.2).
 */
const agentBodySchema = z.looseObject({
	messages: z.array(z.custom<UIMessage>()),
	threadId: z.unknown().optional(),
	mode: z.enum(["ask", "act"]).optional(),
	model: z.string().optional().catch(undefined),
	deepReasoning: z.boolean().catch(false),
});

/** The org route's own fields, as `prepare` reads them. */
interface AgentRouteFields {
	mode: AgentMode;
	model: string | undefined;
	deepReasoning: boolean;
}

/**
 * System prompt for the general Agent page (infra Q&A + project design + Act-mode ops).
 * Exported so the nightly behavior eval (tests/ai-eval) scores the REAL prompt — the
 * thing that actually decides whether the model reaches for the right tool.
 */
export function systemPrompt(mode: AgentMode): string {
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
		"- `cidr_for_hosts(hosts, base?, cloud?)` — the smallest CIDR that fits N hosts AND that the",
		"  cloud's template can carve subnets out of. ALWAYS pass `cloud` once it is known: the floors",
		"  differ (aws/azure /18, hetzner /22, alibaba /28, gcp none) and the apply gate rejects a",
		"  network below its cloud's floor. Without `cloud` the answer is widened to a /18.",
		"",
		"You can ANALYZE A REPO and propose a whole stack from it:",
		"- `scan_repo(repoUrl)` → queues a scan (returns a jobId; logs stream in the panel). Then poll",
		"  `get_scan_result(jobId)` for the inferred stack + a proposed Project, and `compare_providers(jobId)` for",
		"  the cost on each cloud. When ready, tell the user to open it in the canvas (the result includes an",
		"  openInCanvasUrl) to review/edit before deploying. Summarize the inferred needs + their rationale.",
		"",
		"GRID (the side-panel bento canvas):",
		"- Structured read results (list_*/get_*_usage/billing/drift) auto-pin to the user's per-chat",
		"  widget grid; `build_dashboard` pins one widget per block. You don't need to do anything.",
		"- `pin_widget` pins ONE extra widget on request — a `block` you compose from fetched data, or a",
		"  `source` (read tool + args). Use it when the user asks to put something on the grid/dashboard",
		"  or to fill a specific cell (pass `position`). Never invent data for blocks.",
		"",
		"Rules:",
		"- Use real values from the tools; never invent ids, regions, instance types, or credentials.",
		"- Be terse, concrete, and grayscale in tone. No emoji.",
		...act,
	].join("\n");
}

/**
 * POST /api/agent — one Elench turn in the org context. The claim, the billing org, the hold and the
 * stream are the shared route body's (`serveTurn`); this route supplies its body fields and its prompt.
 */
export async function POST(req: Request): Promise<Response> {
	return serveTurn<AgentRouteFields>(req, {
		aiDisabledMessage: "AI is not configured. Set ANTHROPIC_API_KEY to enable the agent.",
		projectId: null,
		turnMetadata: { mentions: true, cellTarget: true },
		parseBody: (raw) => {
			const parsed = agentBodySchema.safeParse(raw);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				return {
					ok: false,
					message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "The request body is malformed.",
				};
			}
			const b = parsed.data;
			return {
				ok: true,
				value: {
					messages: b.messages,
					threadId: b.threadId,
					route: { mode: b.mode ?? "ask", model: b.model, deepReasoning: b.deepReasoning },
				},
			};
		},
		prepare: async ({ actor, mentions, cellTarget, route }) => {
			// Cost-optimized orchestration: a tier-derived ADVISOR plans step 0, then a cheap Haiku
			// EXECUTOR runs the tool loop (ai_free = Haiku throughout). On ai_max the per-message
			// `deepReasoning` opt-in upgrades the advisor to Opus. An explicit client model pick overrides
			// orchestration with that single deliberate choice. The tier is the BILLING org's.
			const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
			const executor = getExecutorModel();
			const advisor = getAdvisorModel(tier, { deepReasoning: route.deepReasoning });
			const clientPick = isSelectableModel(route.model) ? route.model : null;
			const base = clientPick ? resolveModel(clientPick) : executor;

			const mentionBlock = formatMentionsForPrompt(mentions);
			// Empty-cell prompt: the user clicked grid cell (x, y) and described a widget.
			const cellBlock = cellTarget
				? [
						`The user is filling grid cell (x=${cellTarget.x}, y=${cellTarget.y}) of the 5-column`,
						"bento grid with this request. Satisfy it with ONE read tool, then call `pin_widget`",
						`with position {x: ${cellTarget.x}, y: ${cellTarget.y}}, sized to fit the content.`,
					].join(" ")
				: "";
			// The org-level pinned context (custom instructions + knowledge) rides EVERY org chat — the
			// Claude-Projects model. Project-scoped context deliberately does NOT leak in here. The actor
			// is the billing org's (readAgentContext is scope-flag-aware, lib/ai/org-agent-context-flag.ts).
			const orgCtx = await readAgentContext(actor, null).catch(() => null);
			const orgBlock = formatContextBlock("Organization", orgCtx);
			return {
				system: [systemPrompt(route.mode), orgBlock, mentionBlock, cellBlock].filter(Boolean).join("\n\n"),
				tools: buildAgentTools({ mode: route.mode }),
				models: { advisor, executor, base, clientPick: clientPick !== null },
			};
		},
	});
}
