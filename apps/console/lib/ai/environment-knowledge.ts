// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench "environment knowledge" block — the project-knowledge block's sibling, scoped to
// the ONE environment the user is looking at. Before it existed the assistant knew the project
// had environments but not which one the conversation was about, so it planned and deployed the
// default one whatever the topbar switcher said. This block puts the scoped environment's live
// state (status, cost, drift, the jobs that ran against IT, what is staged on it) on every turn's
// system prompt, so the first answer is about the right environment without a tool round-trip.
//
// Same split as project-knowledge.ts: the formatting half is pure (and unit-tested); the DB half
// is a thin scoped read that gates on the environment being visible before touching its children.

import { formatDate, formatMonthlyRate } from "@repo/format";
import { and, desc, eq } from "drizzle-orm";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { type Tx, withActorScope, withOwnerScope } from "@/lib/db";
import {
	environmentCost,
	environmentDrift,
	jobs,
	projectChanges,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { structuralHash } from "@/lib/promotions/diff";
import { orgAgentContextEnabled } from "./org-agent-context-flag";

/** Actor scope for the reads — the real `{ userId, orgId }` (community: equal). */
type ReadActor = { userId: string; orgId: string };

/** How many of the environment's recent jobs the block summarizes. */
const RECENT_JOBS = 5;
/** Hard cap on the block — a system prompt is paid for on every turn. */
const MAX_CHARS = 1500;
/** Job statuses that mean "still working" — surfaced on their own line so the model never proposes a second one on top. */
const IN_FLIGHT = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/** The live facts the block is rendered from (flat, so it is trivially testable). */
export interface EnvironmentFacts {
	id: string;
	name: string;
	stage: string;
	status: string;
	/** The env's own region, or the project's when the env inherits it. */
	region: string;
	isDefault: boolean;
	/** From the last PLAN that priced this environment; null = never priced. */
	cost: { monthly: number; capturedAt: string } | null;
	/** The latest drift scan for this environment; null = never scanned. */
	drift: { inSync: boolean; drifted: number; scannedAt: string } | null;
	/** Whether a deploy has ever landed on this environment (it carries a deployed config hash). */
	deployed: boolean;
	/**
	 * Whether the saved design has moved ahead of the last deploy — the SAME comparison the
	 * environment card and the canvas badge make. null = could not be measured (the design read
	 * threw), which is stated as unknown, never as "matches".
	 */
	updatePending: boolean | null;
	/** Jobs that ran against THIS environment, newest first. */
	recentJobs: Array<{ type: string; status: string; error: string | null }>;
	/** Staged (not yet applied) canvas changes on this environment. */
	stagedChanges: Array<{ op: string; componentType: string }>;
}

/** What the route needs from the read: the name for the Scope paragraph, the block for the prompt. */
export interface EnvironmentKnowledge {
	name: string | null;
	block: string;
}

/** Trim a block to MAX_CHARS on a line boundary so we never cut mid-fact. */
function cap(text: string): string {
	if (text.length <= MAX_CHARS) return text;
	const cut = text.slice(0, MAX_CHARS);
	const lastNl = cut.lastIndexOf("\n");
	return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n… (truncated)`;
}

/** `2 update (cluster, cache) · 1 create (database)` — the staged rows grouped by operation. */
function summarizeStaged(rows: EnvironmentFacts["stagedChanges"]): string {
	const byOp = new Map<string, string[]>();
	for (const r of rows) {
		const kinds = byOp.get(r.op) ?? [];
		kinds.push(r.componentType);
		byOp.set(r.op, kinds);
	}
	return [...byOp.entries()]
		.map(([op, kinds]) => `${kinds.length} ${op} (${[...new Set(kinds)].join(", ")})`)
		.join(" · ");
}

/**
 * Render the environment knowledge block. Pure: same facts → same string, so the prompt stays
 * cacheable and the shape is unit-testable. Every empty case is STATED ("never priced", "no
 * staged changes") rather than omitted, so the model cannot mistake silence for "nothing".
 */
export function formatEnvironmentKnowledge(facts: EnvironmentFacts | null): string {
	if (!facts) return "";
	const lines: string[] = [
		"## Environment knowledge (live, auto-derived — the environment this conversation is scoped to)",
		`- Name: ${facts.name}${facts.isDefault ? " (project default)" : ""} · id: ${facts.id}`,
		`- Stage: ${facts.stage} · Status: ${facts.status} · Region: ${facts.region}`,
	];

	if (facts.cost) {
		// Through the shared formatter so the model is told the cost in the words the console
		// shows the user. The capture date says how stale the number is — it is the LAST plan's.
		lines.push(
			`- Estimated monthly cost: ${formatMonthlyRate(facts.cost.monthly, "exact")} (from the plan of ${formatDate(facts.cost.capturedAt, "date", "UTC")})`,
		);
	} else {
		lines.push("- Estimated monthly cost: never priced (no plan has run for this environment)");
	}

	if (facts.drift) {
		const posture = facts.drift.inSync
			? "in sync"
			: `${facts.drift.drifted} resource${facts.drift.drifted === 1 ? "" : "s"} drifted`;
		lines.push(
			`- Drift: ${posture} (scanned ${formatDate(facts.drift.scannedAt, "datetime", "UTC")} UTC)`,
		);
	} else {
		lines.push("- Drift: never scanned");
	}

	if (!facts.deployed) {
		lines.push("- Deployed: never");
	} else if (facts.updatePending === null) {
		lines.push("- Deployed: yes (whether the saved design has moved since could not be measured)");
	} else if (facts.updatePending) {
		lines.push("- Deployed: yes — the saved design has moved ahead of it (update pending)");
	} else {
		lines.push("- Deployed: yes — matches the saved design");
	}

	const inFlight = facts.recentJobs.find((j) => IN_FLIGHT.has(j.status));
	if (inFlight) {
		lines.push(
			`- In flight: ${inFlight.type} is ${inFlight.status} — do not propose another operation until it finishes`,
		);
	}

	if (facts.recentJobs.length > 0) {
		lines.push("- Recent jobs on this environment (newest first):");
		for (const j of facts.recentJobs) {
			const err = j.error ? ` — ${j.error.slice(0, 120)}` : "";
			lines.push(`  - ${j.type}: ${j.status}${err}`);
		}
	} else {
		lines.push("- Recent jobs on this environment: none");
	}

	if (facts.stagedChanges.length > 0) {
		lines.push(
			`- Staged changes (on the canvas, not yet applied): ${summarizeStaged(facts.stagedChanges)}`,
		);
	} else {
		lines.push("- Staged changes: none");
	}

	return cap(lines.join("\n"));
}

/**
 * Read the scoped environment's live facts. The environment row is read FIRST, joined to its
 * project under the caller's scope (the same `withActorScope` / `withOwnerScope` split
 * `buildProjectKnowledge` uses) — that is the tenancy gate. Only once it resolves are the
 * RLS-less children (cost, drift, staged changes) read, and each is keyed on BOTH the project
 * and the environment id the gate returned, never on a caller-supplied id alone. Returns null
 * when the environment is not visible in scope.
 */
export async function readEnvironmentFacts(
	actor: ReadActor,
	projectId: string,
	environmentId: string,
): Promise<EnvironmentFacts | null> {
	const read = async (
		tx: Tx,
	): Promise<(EnvironmentFacts & { deployedHash: string | null }) | null> => {
		const [env] = await tx
			.select({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				stage: projectEnvironments.stage,
				status: projectEnvironments.status,
				region: projectEnvironments.region,
				isDefault: projectEnvironments.is_default,
				deployedHash: projectEnvironments.deployed_config_hash,
				projectRegion: projects.region,
			})
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.where(
				and(
					eq(projectEnvironments.id, environmentId),
					eq(projectEnvironments.project_id, projectId),
				),
			)
			.limit(1);
		if (!env) return null;

		const [[cost], [drift], recent, staged] = await Promise.all([
			tx
				.select({
					monthly: environmentCost.total_monthly,
					capturedAt: environmentCost.captured_at,
				})
				.from(environmentCost)
				.where(
					and(
						eq(environmentCost.project_id, projectId),
						eq(environmentCost.environment_id, env.id),
					),
				)
				.orderBy(desc(environmentCost.captured_at))
				.limit(1),
			tx
				.select({
					inSync: environmentDrift.in_sync,
					drifted: environmentDrift.drifted,
					scannedAt: environmentDrift.scanned_at,
				})
				.from(environmentDrift)
				.where(
					and(
						eq(environmentDrift.project_id, projectId),
						eq(environmentDrift.environment_id, env.id),
					),
				)
				.orderBy(desc(environmentDrift.scanned_at))
				.limit(1),
			tx
				.select({
					type: jobs.job_type,
					status: jobs.status,
					error: jobs.error_message,
				})
				.from(jobs)
				.where(and(eq(jobs.project_id, projectId), eq(jobs.environment_id, env.id)))
				.orderBy(desc(jobs.created_at))
				.limit(RECENT_JOBS),
			tx
				.select({ op: projectChanges.op, componentType: projectChanges.component_type })
				.from(projectChanges)
				.where(
					and(
						eq(projectChanges.project_id, projectId),
						eq(projectChanges.environment_id, env.id),
					),
				)
				.orderBy(projectChanges.created_at),
		]);

		return {
			id: env.id,
			name: env.name,
			stage: env.stage,
			status: env.status,
			region: env.region ?? env.projectRegion,
			isDefault: env.isDefault,
			cost:
				cost && cost.monthly !== null
					? { monthly: cost.monthly, capturedAt: cost.capturedAt.toISOString() }
					: null,
			drift: drift
				? {
						inSync: drift.inSync,
						drifted: drift.drifted,
						scannedAt: drift.scannedAt.toISOString(),
					}
				: null,
			deployed: env.deployedHash !== null,
			deployedHash: env.deployedHash,
			updatePending: null,
			recentJobs: recent,
			stagedChanges: staged,
		};
	};

	const scoped = orgAgentContextEnabled()
		? await withActorScope(actor, read)
		: await withOwnerScope(actor.userId, read);
	if (!scoped) return null;
	const { deployedHash, ...facts } = scoped;
	if (!deployedHash) return facts;

	// The same comparison `getEnvironmentComponentStatus` / `getEnvReconcileStates` make, so the
	// model and the environment card cannot disagree about "update pending". Reading the design
	// can throw (a since-deleted cloud identity); that degrades to "unknown", never to "matches".
	const updatePending = await getProjectAsFormData(projectId, facts.id)
		.then((r) => structuralHash(r.formData) !== deployedHash)
		.catch(() => null);
	return { ...facts, updatePending };
}

/**
 * Assemble the environment knowledge for the prompt: the block, plus the environment's name so
 * the route's Scope paragraph can say which environment it means in the user's own words. An
 * environment that is not visible in scope yields `{ name: null, block: "" }`, so the block drops
 * out of the prompt and the route says so rather than inventing one.
 */
export async function buildEnvironmentKnowledge(
	actor: ReadActor,
	projectId: string,
	environmentId: string,
): Promise<EnvironmentKnowledge> {
	const facts = await readEnvironmentFacts(actor, projectId, environmentId);
	return { name: facts?.name ?? null, block: formatEnvironmentKnowledge(facts) };
}
