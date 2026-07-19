// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench "project knowledge" block — our analogue of a Claude Project's knowledge base.
// Claude grounds a project's chats in uploaded docs; an infra project's ground truth already
// lives in our DB, so we DERIVE the block from live state (identity, environments, recent jobs)
// and ride it on the system prompt of every chat scoped to that project. That means the very
// first message is grounded without a tool round-trip.
//
// The formatting half is pure (and unit-tested); the DB half is a thin owner-scoped read.

import { desc, eq, isNull, sql } from "drizzle-orm";
import { type Tx, withActorScope, withOwnerScope } from "@/lib/db";
import { agentContext, jobs, projectEnvironments, projects } from "@/lib/db/schema";
import type { AgentContext } from "@/lib/db/schema";
import { orgAgentContextEnabled } from "./org-agent-context-flag";

/** Actor scope for the agent-context reads — the real `{ userId, orgId }` (community: equal). */
type ReadActor = { userId: string; orgId: string };

// Re-exported for server callers; the constant itself lives in a client-safe module so a client
// component can read it without dragging this (DB-bound) module into the browser bundle.
export { KNOWLEDGE_LIMIT } from "./knowledge-limits";

/** How many recent jobs the block summarizes (keeps the prompt cheap). */
const RECENT_JOBS = 5;
/** Hard cap on the whole derived block — a system prompt is paid for on every turn. */
const MAX_CHARS = 2000;

/** The live facts the knowledge block is rendered from (kept flat so it's trivially testable). */
export interface ProjectFacts {
	name: string;
	slug: string | null;
	region: string;
	iacVersion: string;
	monthlyCost: number | null;
	environments: Array<{
		name: string;
		stage: string;
		status: string;
		region: string | null;
	}>;
	recentJobs: Array<{ type: string; status: string; error: string | null }>;
}

/** Trim a block to MAX_CHARS on a line boundary so we never cut mid-fact. */
function cap(text: string): string {
	if (text.length <= MAX_CHARS) return text;
	const cut = text.slice(0, MAX_CHARS);
	const lastNl = cut.lastIndexOf("\n");
	return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n… (truncated)`;
}

/**
 * Render the derived knowledge block for a project. Pure: same facts → same string, so the
 * prompt stays cacheable and the shape is unit-testable.
 */
export function formatProjectKnowledge(facts: ProjectFacts): string {
	const lines: string[] = [
		"## Project knowledge (live, auto-derived — no need to look these up)",
		`- Name: ${facts.name}${facts.slug ? ` (slug: ${facts.slug})` : ""}`,
		`- Region: ${facts.region} · IaC: ${facts.iacVersion}`,
	];
	if (facts.monthlyCost !== null) {
		lines.push(`- Estimated monthly cost: $${facts.monthlyCost}`);
	}

	if (facts.environments.length > 0) {
		lines.push("- Environments:");
		for (const e of facts.environments) {
			const region = e.region ? `, ${e.region}` : "";
			lines.push(`  - ${e.name} (${e.stage}${region}) — ${e.status}`);
		}
	} else {
		lines.push("- Environments: none yet");
	}

	if (facts.recentJobs.length > 0) {
		lines.push(`- Recent jobs (newest first):`);
		for (const j of facts.recentJobs) {
			const err = j.error ? ` — ${j.error.slice(0, 120)}` : "";
			lines.push(`  - ${j.type}: ${j.status}${err}`);
		}
	} else {
		lines.push("- Recent jobs: none");
	}

	return cap(lines.join("\n"));
}

/**
 * Render an org/project context row (custom instructions + pinned knowledge documents) as a
 * prompt block. Each document keeps its TITLE, so the model can say which one it drew on —
 * that's the point of a list of named docs over one opaque blob. Returns "" when nothing is
 * pinned, so the block drops out of the prompt entirely.
 */
export function formatContextBlock(
	scope: "Organization" | "Project",
	ctx: AgentContext | null,
): string {
	if (!ctx) return "";
	const parts: string[] = [];
	const instructions = ctx.instructions.trim();
	if (instructions) {
		parts.push(
			`## ${scope} custom instructions (follow these)\n${instructions}`,
		);
	}

	const docs = (ctx.documents ?? []).filter((d) => d.content.trim().length > 0);
	if (docs.length > 0) {
		const body = docs
			.map((d) => `### ${d.title.trim()}\n${d.content.trim()}`)
			.join("\n\n");
		parts.push(`## ${scope} knowledge (pinned by the user)\n${body}`);
	}
	return parts.join("\n\n");
}

/**
 * Read the pinned context row for a scope (project_id NULL = the org-level row).
 *
 * Scope depends on {@link orgAgentContextEnabled}:
 * - OFF (default): per-user — `withOwnerScope(actor.userId)`, byte-identical to before. Each member
 *   only ever sees their own row (written stamping `org_id = user_id`).
 * - ON: org-shared — `withActorScope`. During the transition a member may see BOTH the shared org
 *   row (`org_id = actor.orgId`) and their own legacy personal row (`user_id = actor.userId`) via
 *   the `owner_all` RLS `user_id OR org_id` predicate, so we PREFER the org row (then most-recently-
 *   updated). That makes the read deterministic with no backfill: once an admin sets the org row
 *   everyone reads it; until then each member falls back to their own legacy row.
 */
export async function readAgentContext(
	actor: ReadActor,
	projectId: string | null,
): Promise<AgentContext | null> {
	// project_id IS NULL = the org-level row.
	const scopeWhere = projectId
		? eq(agentContext.project_id, projectId)
		: isNull(agentContext.project_id);

	if (!orgAgentContextEnabled()) {
		return withOwnerScope(actor.userId, async (tx) => {
			const [row] = await tx
				.select()
				.from(agentContext)
				.where(scopeWhere)
				.limit(1);
			return row ?? null;
		});
	}

	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select()
			.from(agentContext)
			.where(scopeWhere)
			// Prefer the shared org row over a lingering legacy personal row, then newest.
			.orderBy(
				desc(sql`${agentContext.org_id} = ${actor.orgId}`),
				desc(agentContext.updated_at),
			)
			.limit(1);
		return row ?? null;
	});
}

/**
 * Assemble the derived project-knowledge block from live state. Returns "" if the project isn't
 * visible in scope. Scope depends on {@link orgAgentContextEnabled}: OFF → `withOwnerScope`
 * (per-user, byte-identical to before); ON → `withActorScope`, so a teammate resolves an org
 * project's knowledge (projects are org-shared).
 */
export async function buildProjectKnowledge(
	actor: ReadActor,
	projectId: string,
): Promise<string> {
	const read = async (tx: Tx): Promise<ProjectFacts | null> => {
		const [p] = await tx
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		if (!p) return null;

		const envs = await tx
			.select({
				name: projectEnvironments.name,
				stage: projectEnvironments.stage,
				status: projectEnvironments.status,
				region: projectEnvironments.region,
			})
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));

		const recent = await tx
			.select({
				type: jobs.job_type,
				status: jobs.status,
				error: jobs.error_message,
			})
			.from(jobs)
			.where(eq(jobs.project_id, projectId))
			.orderBy(desc(jobs.created_at))
			.limit(RECENT_JOBS);

		return {
			name: p.project_name,
			slug: p.slug,
			region: p.region,
			iacVersion: p.iac_version,
			monthlyCost: p.estimated_monthly_cost ?? null,
			environments: envs,
			recentJobs: recent,
		};
	};

	const facts = orgAgentContextEnabled()
		? await withActorScope(actor, read)
		: await withOwnerScope(actor.userId, read);

	return facts ? formatProjectKnowledge(facts) : "";
}
