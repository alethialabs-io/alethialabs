// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// THE ENVIRONMENTS DOMAIN'S READS (ADR 0005 D1, #6120). Everything the project's Environments page
// reads lives here as a plain server function, served over GET by the procedures at the bottom and
// prefetched in-process by the page (`app/(private)/[org]/[project]/environments/page.tsx`), so the
// page's first paint carries its data and the client fetches nothing on mount.
//
// The bodies MOVED here from the `"use server"` modules that used to serve them as actions:
//   · readPromotions          ← app/server/actions/promotions.ts listPromotions
//   · readPromotionDetail     ← app/server/actions/promotions.ts getPromotionDetail
//   · readPromotionPreview    ← app/server/actions/promotions.ts previewPromotion
//   · readProtectionSummaries ← app/server/actions/protection.ts listProtectionRules
//   · readProtectionRules     ← app/server/actions/protection.ts getProtectionRules
// Three reads are served without moving, called IN-PROCESS (a plain function call, not a
// server-action POST): the environment list and the consistency matrix (`getProjectEnvironments`,
// `getEnvConsistency`, app/server/actions/projects.ts) and the reconcile badges
// (`getEnvReconcileStates`, app/server/actions/reconcile.ts) — those modules belong to other units.
//
// TENANCY. The actor is the one the read router bound for the request's ADDRESS (`lib/rpc/base.ts`),
// never the session's org. Every read here is addressed by a project (a slug or an id) or a
// promotion id, and binds it to the actor's organization BEFORE the PDP is asked about it
// (`lib/promotions/org-binding.ts`): an org-wide grant answers `view` for any project id, so the
// PDP alone would answer for a project this org does not own. Another organization's id is a typed
// NOT_FOUND, exactly like an id that does not exist.

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
	type EnvConsistency,
	getEnvConsistency,
	getProjectAsFormData,
	getProjectEnvironments,
} from "@/app/server/actions/projects";
import type { ProtectionSummary } from "@/app/server/actions/protection";
import { type EnvReconcileState, getEnvReconcileStates } from "@/app/server/actions/reconcile";
import { ActionRefusal } from "@/lib/actions/result";
import { authorizeRead, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	environmentPromotions,
	environmentProtectionRules,
	projectEnvironments,
	projects,
	promotionApprovals,
	user,
} from "@/lib/db/schema";
import { diffDesigns } from "@/lib/promotions/diff";
import { IN_FLIGHT, type PromotionRow, type ProtectionRow } from "@/lib/promotions/lifecycle";
import { assertProjectInActorOrg, promotionInActorOrg } from "@/lib/promotions/org-binding";
import { query } from "@/lib/rpc/base";
import { arrayIncludes } from "@/lib/type-guards";
import type { GateResult, PromotionDiff } from "@/types/jsonb.types";

/** One environment row as the page shows it (`updated_at` is an ISO string). */
export interface EnvRow {
	id: string;
	name: string;
	stage: string;
	is_default: boolean;
	updated_at: string;
}

/** A promotion row projected for the client. */
export interface PromotionRowView {
	id: string;
	source_environment_id: string;
	target_environment_id: string;
	status: string;
	error_message: string | null;
	created_at: string;
}

/** One approval slot, enriched with the approver's display name for the UI. */
export interface PromotionApprovalSlot {
	id: string;
	status: "pending" | "approved" | "rejected";
	/** Approver display name; null while the slot is still pending. */
	name: string | null;
	initials: string | null;
	requiredRole: string | null;
	comment: string | null;
	decidedAt: string | null;
}

/** A promotion hydrated for the active-promotion panel + detail overlay. */
export interface PromotionDetail {
	id: string;
	status: string;
	sourceName: string;
	targetName: string;
	/** Per-gate results from the stored evaluation ([] until the plan has run). */
	gates: GateResult[];
	overall: string | null;
	approvals: PromotionApprovalSlot[];
	approved: number;
	required: number;
	diff: PromotionDiff | null;
	initiator: string | null;
	createdAt: string;
}

/** Everything the Environments page paints, in one read. */
export interface EnvironmentsOverview {
	projectId: string;
	envs: EnvRow[];
	consistency: EnvConsistency;
	reconcile: EnvReconcileState[];
	promotions: PromotionRowView[];
	/** The in-flight promotion, hydrated (gates + approval slots + diff); null when none. */
	activePromotion: PromotionDetail | null;
	/** Each environment's protection-rule summary, keyed by environment id (unset → absent). */
	protectionByEnv: Record<string, ProtectionSummary>;
}

/** One environment's protection rules, or `rules: null` when none are set (fully permissive). */
export interface ProtectionRulesRead {
	environmentId: string;
	rules: ProtectionRow | null;
}

/** The promotable diff from one environment onto another, naming both. */
export interface PromotionPreview {
	sourceId: string;
	targetId: string;
	diff: PromotionDiff;
}

// ── Project addressing ────────────────────────────────────────────────────────────────────────

/**
 * The id of the project `slug` names IN THE ACTOR'S ORGANIZATION. Slugs are unique per org, so the
 * same slug can name a project in each of two orgs; the org predicate picks the addressed one, and
 * a slug with no project in this org is a NOT_FOUND.
 */
async function resolveProjectInOrg(actor: Actor, slug: string): Promise<string> {
	const [row] = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.slug, slug), eq(projects.org_id, actor.orgId)))
		.limit(1);
	if (!row) throw new ActionRefusal("not-found", "Project not found.");
	return row.id;
}

/**
 * Binds `projectId` to the actor's organization, then asks the PDP for `view` on it — in that order,
 * so the PDP is never asked about another organization's project. Returns the actor.
 */
async function viewProjectInOrg(projectId: string): Promise<Actor> {
	await assertProjectInActorOrg(await currentActor(), projectId);
	return authorizeRead("view", { type: "project", id: projectId });
}

/** Throws a NOT_FOUND unless every id in `envIds` is an environment of `projectId`. */
async function assertEnvsInProject(actor: Actor, projectId: string, envIds: string[]): Promise<void> {
	const wanted = [...new Set(envIds)];
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.where(
				and(
					eq(projectEnvironments.project_id, projectId),
					inArray(projectEnvironments.id, wanted),
				),
			),
	);
	if (rows.length !== wanted.length) {
		throw new ActionRefusal("not-found", "Environment not found.");
	}
}

// ── Promotions ────────────────────────────────────────────────────────────────────────────────

/** A project's promotions, newest first. The caller has bound and authorized the project. */
async function readPromotions(actor: Actor, projectId: string): Promise<PromotionRow[]> {
	return withActorScope(actor, (tx) =>
		tx
			.select()
			.from(environmentPromotions)
			.where(eq(environmentPromotions.project_id, projectId))
			.orderBy(desc(environmentPromotions.created_at)),
	);
}

/** Two-letter initials from a display name (e.g. "Ivo Karadzhov" → "IK"). */
function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A promotion hydrated for the UI — gate results (from the stored evaluation), approval slots with
 * the approver's name, the source/target env names, the diff, and the initiator. The promotion is
 * resolved within the addressed organization first (`promotionInActorOrg`, #6225), then gated on
 * project `view`; another organization's promotion is a NOT_FOUND.
 */
export async function readPromotionDetail(promotionId: string): Promise<PromotionDetail> {
	const { promotion } = await promotionInActorOrg(promotionId, "view");
	const db = getServiceDb();

	const [envs, approvalRows] = await Promise.all([
		db
			.select({ id: projectEnvironments.id, name: projectEnvironments.name })
			.from(projectEnvironments)
			.where(
				and(
					// The promotion is bound to the org above; its environments are bound to its project.
					eq(projectEnvironments.project_id, promotion.project_id),
					inArray(projectEnvironments.id, [
						promotion.source_environment_id,
						promotion.target_environment_id,
					]),
				),
			),
		db
			.select({
				id: promotionApprovals.id,
				status: promotionApprovals.status,
				required_role: promotionApprovals.required_role,
				comment: promotionApprovals.comment,
				decided_at: promotionApprovals.decided_at,
				approver_name: user.name,
				approver_email: user.email,
			})
			.from(promotionApprovals)
			.leftJoin(user, eq(user.id, promotionApprovals.decided_by))
			.where(eq(promotionApprovals.promotion_id, promotionId)),
	]);
	const nameOf = (id: string) => envs.find((e) => e.id === id)?.name ?? "—";

	const [initiator] = promotion.user_id
		? await db
				.select({ name: user.name, email: user.email })
				.from(user)
				.where(eq(user.id, promotion.user_id))
				.limit(1)
		: [];

	const approvals: PromotionApprovalSlot[] = approvalRows.map((a) => {
		const display = a.approver_name || a.approver_email || null;
		return {
			id: a.id,
			status: a.status,
			name: display,
			initials: display ? initialsOf(display) : null,
			requiredRole: a.required_role,
			comment: a.comment,
			decidedAt: a.decided_at ? a.decided_at.toISOString() : null,
		};
	});

	return {
		id: promotion.id,
		status: promotion.status,
		sourceName: nameOf(promotion.source_environment_id),
		targetName: nameOf(promotion.target_environment_id),
		gates: promotion.gate_evaluations?.results ?? [],
		overall: promotion.gate_evaluations?.overall ?? null,
		approvals,
		approved: approvals.filter((a) => a.status === "approved").length,
		required: approvals.length,
		diff: promotion.diff_summary ?? null,
		initiator: initiator?.name || initiator?.email || null,
		createdAt: promotion.created_at.toISOString(),
	};
}

/**
 * The promotable diff from `sourceId` onto `targetId`, for the promote dialog — computed without
 * side effects. Both environments must belong to the project, and the project to the addressed
 * organization; the same environment on both sides is an empty diff.
 */
export async function readPromotionPreview(
	projectId: string,
	sourceId: string,
	targetId: string,
	includeRemovals: boolean,
): Promise<PromotionPreview> {
	const actor = await viewProjectInOrg(projectId);
	await assertEnvsInProject(actor, projectId, [sourceId, targetId]);
	if (sourceId === targetId) {
		return { sourceId, targetId, diff: { changes: [], summary: [], include_removals: includeRemovals } };
	}
	const source = (await getProjectAsFormData(projectId, sourceId)).formData;
	const target = (await getProjectAsFormData(projectId, targetId)).formData;
	return { sourceId, targetId, diff: diffDesigns(source, target, includeRemovals) };
}

// ── Protection rules ──────────────────────────────────────────────────────────────────────────

/** A protection-rule row reduced to the env-card's "gates into this env" summary. */
function summaryOf(row: ProtectionRow): ProtectionSummary {
	return {
		require_predecessor: row.require_predecessor,
		require_verify_pass: row.require_verify_pass,
		require_approval: row.require_approval,
		min_count: row.approvers?.min_count ?? null,
		soak_minutes: row.soak_minutes,
		cost_delta_threshold: row.cost_delta_threshold,
	};
}

/** All of a project's protection rules, keyed by environment id. The caller bound the project. */
async function readProtectionSummaries(
	actor: Actor,
	projectId: string,
): Promise<Record<string, ProtectionSummary>> {
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select()
			.from(environmentProtectionRules)
			.where(eq(environmentProtectionRules.project_id, projectId)),
	);
	return Object.fromEntries(rows.map((r) => [r.environment_id, summaryOf(r)]));
}

/**
 * One environment's protection rules (null when none are set), for the rules editor. The project is
 * bound to the addressed organization and the environment to the project before the row is read.
 */
export async function readProtectionRules(
	projectId: string,
	environmentId: string,
): Promise<ProtectionRulesRead> {
	const actor = await viewProjectInOrg(projectId);
	await assertEnvsInProject(actor, projectId, [environmentId]);
	const [row] = await withActorScope(actor, (tx) =>
		tx
			.select()
			.from(environmentProtectionRules)
			.where(
				and(
					eq(environmentProtectionRules.environment_id, environmentId),
					// Scoped by the same project id the caller was authorized against.
					eq(environmentProtectionRules.project_id, projectId),
				),
			)
			.limit(1),
	);
	return { environmentId, rules: row ?? null };
}

// ── The page's one read ───────────────────────────────────────────────────────────────────────

/**
 * Everything the Environments page paints for the project `slug` names in the addressed org.
 *
 * The environment list is the core of the page: if it fails, the read fails, and the page renders
 * its error — never an empty list. The enrichment probes (consistency / reconcile / promotions /
 * protection / the active promotion) each read per-environment design and can throw (e.g. a
 * since-deleted cloud identity); they degrade to safe empty defaults rather than failing the page,
 * exactly as the server-rendered page did before this moved.
 */
export async function readEnvironmentsOverview(slug: string): Promise<EnvironmentsOverview> {
	const projectId = await resolveProjectInOrg(await currentActor(), slug);
	const actor = await authorizeRead("view", { type: "project", id: projectId });

	const { environments } = await getProjectEnvironments(projectId);
	const [consistency, reconcile, promotions, protectionByEnv] = await Promise.all([
		getEnvConsistency(projectId).catch(
			(): EnvConsistency => ({
				envs: environments.map((e) => ({ id: e.id, name: e.name, stage: e.stage })),
				rows: [],
			}),
		),
		getEnvReconcileStates(projectId).catch((): EnvReconcileState[] => []),
		readPromotions(actor, projectId).catch((): PromotionRow[] => []),
		readProtectionSummaries(actor, projectId).catch((): Record<string, ProtectionSummary> => ({})),
	]);

	const active = promotions.find((p) => arrayIncludes(IN_FLIGHT, p.status));
	const activePromotion = active ? await readPromotionDetail(active.id).catch(() => null) : null;

	return {
		projectId,
		envs: environments.map((e) => ({
			id: e.id,
			name: e.name,
			stage: e.stage,
			is_default: e.is_default,
			updated_at: e.updated_at.toISOString(),
		})),
		consistency,
		reconcile,
		promotions: promotions.map((p) => ({
			id: p.id,
			source_environment_id: p.source_environment_id,
			target_environment_id: p.target_environment_id,
			status: p.status,
			error_message: p.error_message,
			created_at: p.created_at.toISOString(),
		})),
		activePromotion,
		protectionByEnv,
	};
}

// ── The procedures ────────────────────────────────────────────────────────────────────────────

/**
 * The environments domain's read procedures (ADR 0005 D1, #6120). Every one is a GET (the `query`
 * base). `overview` is prefetched by the Environments page; the two dialog reads are fetched when
 * their dialog opens. All three are invalidated by the real-time bus (`lib/query/topics.ts`) —
 * an environment, a promotion, an approval slot or a protection rule changing is an `environments`
 * hint (`lib/db/programmables.sql`) — instead of polled.
 */
export const environmentsRouter = {
	/** The page: environments, consistency, reconcile, promotions, the active one, protection. */
	overview: query
		.input(z.object({ project: z.string().min(1).max(200) }))
		.handler(({ input }) => readEnvironmentsOverview(input.project)),
	/** One environment's protection rules (the rules editor). */
	protectionRules: query
		.input(z.object({ projectId: z.uuid(), environmentId: z.uuid() }))
		.handler(({ input }) => readProtectionRules(input.projectId, input.environmentId)),
	/** The promotable diff between two of a project's environments (the promote dialog). */
	promotionPreview: query
		.input(
			z.object({
				projectId: z.uuid(),
				sourceId: z.uuid(),
				targetId: z.uuid(),
				includeRemovals: z.boolean(),
			}),
		)
		.handler(({ input }) =>
			readPromotionPreview(input.projectId, input.sourceId, input.targetId, input.includeRemovals),
		),
};
