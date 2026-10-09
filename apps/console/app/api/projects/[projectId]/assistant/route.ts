// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { serveTurn } from "@/lib/agent/turn-route";
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
import { buildProjectAgentTools } from "@/lib/ai/tools";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import { getAdvisorModel, getExecutorModel } from "@/lib/config/ai";

export const runtime = "nodejs";

/** The project route's own fields, as `prepare` reads them. */
interface AssistantRouteFields {
	canvas: CanvasContext | undefined;
	deepReasoning: boolean;
	environmentId: string | null;
	view: AssistantView | undefined;
}

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

/**
 * POST /api/projects/[projectId]/assistant — one Elench turn in a project. The claim, the billing org,
 * the project check (the project must be in the billing org and visible to the caller, §6.2), the hold
 * and the stream are the shared route body's (`serveTurn`); this route supplies its body and prompt.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
	const { projectId } = await params;
	return serveTurn<AssistantRouteFields>(req, {
		aiDisabledMessage: "AI is not configured. Set ANTHROPIC_API_KEY to enable the assistant.",
		projectId,
		// The body shape is shared with the client (lib/ai/project-assistant-body.ts), so the two cannot
		// drift. It degrades rather than throws: only `messages` is genuinely required. `environmentId`
		// is the environment the user is looking at (a malformed one degrades to null).
		parseBody: (raw) => {
			const body = parseProjectAssistantBody(raw);
			if (!body.ok) return body;
			const v = body.value;
			return {
				ok: true,
				value: {
					messages: v.messages,
					threadId: v.threadId,
					mentions: v.mentions,
					// The project prompt has no grid hint: an empty-cell prompt is an org-chat feature.
					cellTarget: null,
					route: {
						canvas: v.canvas,
						deepReasoning: v.deepReasoning,
						environmentId: v.environmentId,
						view: v.view,
					},
				},
			};
		},
		prepare: async ({ actor, mentions, route }) => {
			// Cost-optimized orchestration: a tier-derived ADVISOR plans step 0, then a cheap Haiku
			// EXECUTOR runs the tool loop. On ai_max the per-message `deepReasoning` opt-in upgrades the
			// advisor to Opus. The tier is the BILLING org's.
			const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
			const executor = getExecutorModel();
			const advisor = getAdvisorModel(tier, { deepReasoning: route.deepReasoning });
			const mentionBlock = formatMentionsForPrompt(mentions);

			// The environment this turn is about. `resolveActiveEnvironmentId` validates the requested
			// id belongs to THIS project under the actor's org (the billing org: this runs inside
			// `runWithActor`) and falls back to the project's default, so a foreign or stale id from the
			// client can never scope the prompt to another tenant's environment. A project with no
			// visible default resolves to null and the prompt says so.
			const environmentId = await resolveActiveEnvironmentId(
				projectId,
				route.environmentId ?? undefined,
			).catch(() => null);
			const noEnvironment: EnvironmentKnowledge = { name: null, block: "" };

			// The Claude-Projects model: this chat inherits the project's pinned instructions and
			// knowledge, layered UNDER the org-level ones, plus a derived block of the project's live
			// state. A project's context never leaks out to org chats.
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
				systemPrompt(projectId, route.canvas, {
					environmentId,
					environmentName: environment.name,
					view: route.view,
				}),
				formatContextBlock("Organization", orgCtx),
				formatContextBlock("Project", projectCtx),
				derived,
				environment.block,
				mentionBlock,
			]
				.filter(Boolean)
				.join("\n\n");
			return {
				system,
				tools: buildProjectAgentTools(route.canvas, { environmentId }),
				models: { advisor, executor, base: executor, clientPick: false },
			};
		},
	});
}
