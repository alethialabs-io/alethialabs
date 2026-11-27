// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, count, countDistinct, eq, exists, inArray, max, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ProjectListItem, ProjectWithProvider } from "@/app/server/actions/projects";
import type { Db, Tx } from "@/lib/db";
import {
	normalizeWebhookCaConsumers,
	type WebhookCaConsumer,
} from "@/lib/addons/webhook-ca-consumers";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { assertCloudOffered, CloudNotOfferedError } from "@/lib/cloud-providers/availability";
import { claimPlacementNamespace } from "@/lib/projects/placement-namespace-claim";
import {
	cloudIdentities,
	cloudProvider,
	type EnvironmentLifecycle,
	type EnvironmentStage,
	type PlacementMode,
	type Project,
	projectAddons,
	projectEnvironments,
	projectFabrics,
	projectServices,
	projectSourceRepos,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import { likeTerm } from "@/lib/db/like";
import { narrowTo, nonEmpty, searchTerm } from "@/lib/queries/facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	type KeysetPosition,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "@/lib/queries/keyset";
import { repoLabel } from "@/lib/repos/repo-label";
import { pickFreeSlug, RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import { slugify } from "@/lib/utils/slugify";
import {
	environmentNameProblem,
	namespaceProblem,
	normalizeEnvironmentName,
} from "@/lib/validations/names";
import {
	duplicatePlacementNamespace,
	effectivePlacementNamespace,
	placementNamespaceMessage,
} from "@/lib/validations/placement-namespace";

/**
 * Why an environment spec cannot be fanned out, or `null` when it can.
 *
 * Re-validated at all because `createProject` does not re-parse the client input, so a crafted
 * request must not smuggle path separators into a tofu state key or a Fabric name.
 *
 * It asks the SHARED rules (lib/validations/names.ts) rather than keeping its own copy. The copy
 * it used to keep was a pair of bounded charset patterns, one per field, and both required a
 * leading LETTER — the rule #3665 removes, because Kubernetes accepts `1dev`. `POST
 * /api/cli/projects` parses the matrix with `environmentMatrixSchema` and hands it straight to the
 * fan-out, so the two disagreeing meant `alethia project create --env 1dev:namespace` passed
 * validation and then threw out of the fan-out — which the route's catch renders as a 500, not the
 * 400 a rejected name deserves.
 *
 * Exported so that agreement is a TEST rather than a claim: tests/lib/queries-projects-specs.test.ts
 * drives this and `environmentMatrixSchema` over one corpus and asserts they answer alike.
 */
export function environmentSpecProblem(spec: {
	name: string;
	namespace?: string | null;
	placement_mode?: PlacementMode;
}): string | null {
	const nameProblem = environmentNameProblem(spec.name);
	if (nameProblem) return `Invalid environment name "${spec.name}": ${nameProblem}`;
	// The name arrives already normalized when it came through environmentMatrixSchema. Checked
	// again because the fan-out is also reachable from callers that never parsed it, and a name
	// that still needs normalizing would be stored in a form no URL resolves.
	const canonical = normalizeEnvironmentName(spec.name);
	if (canonical !== spec.name) {
		return (
			`Invalid environment name "${spec.name}": it must already be normalized ` +
			`("${canonical}") before it reaches the fan-out.`
		);
	}
	if (spec.namespace != null) {
		const nsProblem = namespaceProblem(spec.namespace);
		if (nsProblem) return `Invalid namespace "${spec.namespace}": ${nsProblem}`;
	}
	// #6551: a namespace placement may not use a namespace the platform uses on the host cluster. A
	// NEW project's host has no BYO charts yet, so the static list is the whole rule here.
	if (spec.placement_mode === "namespace") {
		const reserved = placementNamespaceMessage(effectivePlacementNamespace(spec), []);
		if (reserved) return reserved;
	}
	return null;
}

/**
 * Why a create matrix cannot be fanned out, or `null`: the first spec {@link environmentSpecProblem}
 * refuses, else two namespace placements resolving to one namespace (#6551) — the shared placements
 * all land on one host Fabric, so they would share its namespace, AppProject and identity.
 */
export function environmentSpecsProblem(
	specs: readonly { name: string; namespace?: string | null; placement_mode: PlacementMode }[],
): string | null {
	for (const s of specs) {
		const problem = environmentSpecProblem(s);
		if (problem) return problem;
	}
	return duplicatePlacementNamespace(specs)?.message ?? null;
}

/** One environment the front door seeds, with its placement onto a Fabric. The placement selector
 * (#844) emits these; the fan-out below turns them into `project_fabrics` + `project_environments`
 * rows — see {@link planFabricPlacement} for which Fabric each one lands on. */
export interface EnvironmentSpec {
	/** Slug-safe env name — also the Fabric name for a `dedicated` env and the tofu state segment. */
	name: string;
	stage: EnvironmentStage;
	placement_mode: PlacementMode;
	/** `persistent` (default) or `ephemeral` (e.g. preview). Data-only seam until the reaper reads it. */
	lifecycle?: EnvironmentLifecycle;
	/** ArgoCD destination namespace for a shared placement; ignored for `dedicated`. */
	namespace?: string | null;
	/** Exactly one spec must be the default — the representative env for single-value surfaces. */
	is_default?: boolean;
}

/**
 * Decide which Fabric each environment in a create-matrix is placed onto.
 *
 * Only a `dedicated` environment provisions a cluster, so a `namespace`/`vcluster` environment must
 * be hosted on some dedicated env's Fabric. `packages/core/provisioner/deploy_namespace.go` enforces
 * the same rule at deploy time and fails closed: "the Fabric's cluster must be provisioned (a
 * 'dedicated' env owning the Fabric) before a namespace env can be placed onto it".
 *
 * This used to mint a separate Fabric literally named `shared` to carry every shared placement — a
 * Fabric NO environment owned, which nothing therefore ever provisioned, leaving every tier on it
 * undeployable from birth. Both sibling paths already had it right (the legacy shape puts Prod and
 * its `preview` namespace env on ONE Fabric; the `project env add` route resolves onto the DEFAULT
 * environment's Fabric), so this is the third path being brought into line rather than a new policy.
 *
 * Pure and exported so the decision is testable without Postgres — the bug lived for as long as it
 * did because the only coverage of the fan-out needed a real database.
 *
 * @throws if a shared placement is present with no `dedicated` env to host it.
 */
export function planFabricPlacement(specs: EnvironmentSpec[]): {
	/** Fabric names to create — one per `dedicated` env, in spec order. */
	fabricNames: string[];
	/** The Fabric name a given spec is placed onto. */
	hostFor: (spec: EnvironmentSpec) => string;
} {
	const dedicated = specs.filter((s) => s.placement_mode === "dedicated");
	const hasShared = specs.some((s) => s.placement_mode !== "dedicated");
	if (hasShared && dedicated.length === 0) {
		throw new Error(
			"At least one environment must be `dedicated`: it owns the Fabric and is what brings the cluster into being. `namespace` and `vcluster` environments are placed onto a cluster that already exists.",
		);
	}
	// Host the cheap tiers on the default env's Fabric when the default is dedicated, so they ride
	// the project's primary cluster; otherwise the first dedicated env in spec order.
	const host = dedicated.find((s) => s.is_default) ?? dedicated[0];
	return {
		fabricNames: dedicated.map((s) => s.name),
		hostFor: (spec) => {
			const name = spec.placement_mode === "dedicated" ? spec.name : host?.name;
			if (!name) throw new Error(`No Fabric for environment "${spec.name}".`);
			return name;
		},
	};
}

/** Scalar inputs the create front door needs — the `project` sub-object of `CreateProjectInput`
 * plus the resolved tenancy (owner + active org). Deliberately narrow: the shared core owns the
 * Fabric + placement invariant, not the form's component graph. */
export interface CreateProjectCoreInput {
	project_name: string;
	region: string;
	cloud_identity_id?: string | null;
	iac_version: string;
	/** Seeds the default Fabric's name AND the default (Production) environment's name + stage. */
	environment_stage: EnvironmentStage;
	/** The default (Production) environment's placement onto its first Fabric. Optional so the value
	 *  flows from the create front door (UI #844 / CLI) rather than a literal; defaults to `dedicated`
	 *  — a new project's first env OWNS the Fabric it provisions, so `dedicated` is the sensible
	 *  default (placing the first env as `namespace`/`vcluster` would leave the new Fabric with no
	 *  cluster owner). Preview is always `namespace` on that same Fabric. Ignored when `environments`
	 *  is provided (the full matrix carries its own placements). */
	placement_mode?: PlacementMode;
	/** The full environment matrix from the placement selector (#844). When present, the core fans it
	 *  out via {@link planFabricPlacement}: a Fabric per `dedicated` env, with every shared placement
	 *  hosted on a dedicated env's Fabric. When ABSENT the core keeps the legacy
	 *  Prod(dedicated)+Preview(namespace-on-Prod-Fabric) shape — so the CLI route and any caller that
	 *  doesn't set it are byte-identical to before. */
	environments?: EnvironmentSpec[];
	/** The project-level webhook-CA marker (#4990) — workloads that are not add-ons but need the
	 *  cert-manager controller for their webhook CA. Set by the AI Workloads template; omitted by
	 *  every other caller, which stores the column default (none). */
	webhook_ca_consumers?: WebhookCaConsumer[];
	/** The creating user id — stamped on every row. */
	owner: string;
	/** The ACTIVE ORG id — rows belong to the org, not the creating user (they diverge under EE). */
	orgId: string;
}

/** The rows the front door always creates, returned so callers can seed components onto the default
 * env / render a wire response. */
export interface CreateProjectCoreResult {
	project: Project;
	defaultFabric: { id: string };
	defaultEnv: { id: string };
	previewEnv: { id: string };
}

/**
 * The project-creation front door's shared core: inserts the project row, its default **Fabric**,
 * the **Production + Preview** environments with explicit placement (Prod = `dedicated` on the new
 * Fabric; Preview = `namespace` on that same Fabric), and the project→org authz hierarchy edge.
 *
 * This is the single owner of the "default Fabric + Prod/Preview placement" invariant, called by
 * BOTH the `createProject` server action (canvas/form path) and the `POST /api/cli/projects` route
 * (CLI path) so the two can never drift. Runs entirely inside the caller-provided transaction `tx`
 * — the caller owns auth + tenancy resolution (RLS `withScope` for the action; a service-role
 * `transaction` for the CLI route) and any post-insert work (components, audit, wire response).
 *
 * The org-scoped slug select filters `org_id` EXPLICITLY so it is correct under a service-role
 * (BYPASSRLS) transaction as well as an RLS-scoped one — never rely on RLS alone for uniqueness here.
 */

/**
 * The name collision, as something a caller can catch.
 *
 * Raised by BOTH write paths — `insertProjectWithDefaultFabric` on create and `updateProjectName`
 * on rename — so a duplicate reads the same whether it was found by the pre-check or by the index
 * losing a race. Without it the caller sees drizzle's wrapper, whose message is
 * `Failed query: insert into …`, and the console answers a 500 for a thing the user can fix.
 */
export class ProjectNameTakenError extends Error {
	constructor(readonly project_name: string) {
		super(
			`A project named "${project_name}" already exists in this organization. ` +
				"Project names are unique per organization and are compared without regard to case.",
		);
		this.name = "ProjectNameTakenError";
	}
}

/** Every error in a `cause` chain, outermost first.
 *
 * Drizzle WRAPS the driver error: what a failing `.insert()` throws is a DrizzleQueryError whose
 * message is "Failed query: insert into ..." and whose `cause` is the postgres.js error carrying
 * `code` and `constraint_name`. Inspecting only the thrown object finds neither, so a check written
 * against the driver's shape silently never fires and every unique violation falls through as an
 * unmapped 500. That is not hypothetical — it is what the integration suite caught here. The depth
 * bound is paranoia about a self-referential cause, not a real chain length. */
function causeChain(err: unknown): unknown[] {
	const chain: unknown[] = [];
	let cur = err;
	for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
		chain.push(cur);
		if (typeof cur !== "object" || cur === null || !("cause" in cur)) break;
		// `in` narrows; no cast — CLAUDE.md §6 forbids `as`, and the narrowing is what makes the
		// read safe rather than asserted.
		const next: unknown = cur.cause;
		if (next === cur) break;
		cur = next;
	}
	return chain;
}

/** The Postgres error code, if this error or anything it wraps carries one (23505 = unique
 * violation). */
function pgErrorCode(err: unknown): string | undefined {
	for (const link of causeChain(err)) {
		if (typeof link === "object" && link !== null && "code" in link) {
			const code: unknown = link.code;
			if (typeof code === "string") return code;
		}
	}
	return undefined;
}

/** Whether this error is the project-name unique violation — exported so `updateProjectName`,
 * the other path that can mint a duplicate, maps the race onto the same error as create. */
export function isProjectNameTaken(err: unknown): boolean {
	return violates(err, "projects_org_id_project_name_key");
}

/** Whether this error is the environment-name unique violation (`project_environments.(project_id,
 * name)`) — the loser of two concurrent adds of one name, mapped by `addEnvironment` /
 * `duplicateEnvironment` onto the same refusal as the ordinary duplicate. */
export function isEnvironmentNameTaken(err: unknown): boolean {
	return violates(err, "project_environments_project_id_name_key");
}

/** Whether a driver error names a particular constraint. `constraint_name` is what postgres-js
 * surfaces; the message is checked too because a wrapped error can lose the field. */
function violates(err: unknown, constraint: string): boolean {
	if (pgErrorCode(err) !== "23505") return false;
	for (const link of causeChain(err)) {
		if (typeof link !== "object" || link === null) continue;
		if ("constraint_name" in link && link.constraint_name === constraint) {
			return true;
		}
		// A wrapper that dropped the field can still name the constraint in its text. Checked
		// second, so the structured answer always wins.
		if (link instanceof Error && link.message.includes(constraint)) return true;
	}
	return false;
}

/**
 * Claims each namespace placement's namespace under the project's namespace lock before the fan-out
 * inserts the placements (#6575), throwing the first refusal. Every namespace-placement writer goes
 * through {@link claimPlacementNamespace}, so this one also reads the host's charts and the Fabric's
 * placements instead of assuming a new project has none. Today that assumption holds: the project row
 * is uncommitted until this transaction commits, so no attach can reach it and every read here returns
 * nothing. The lock and the reads are what keep the rule true for a caller that fans placements out
 * into a project that already exists.
 */
async function refuseClaimedPlacementNamespaces(
	tx: Tx,
	projectId: string,
	placements: readonly { fabricId: string; namespace: string }[],
): Promise<void> {
	for (const p of placements) {
		const refusal = await claimPlacementNamespace(tx, projectId, p.fabricId, p.namespace);
		if (refusal) throw new Error(refusal);
	}
}

/**
 * Refuses a cloud account whose cloud this deployment does not offer, by throwing
 * `CloudNotOfferedError`. The cloud is the stored row's, read in the caller's transaction, never a
 * value the caller sent.
 *
 * An id that matches no row the transaction can read is not refused here. Whether the caller may
 * use an account at all is a different question, and each write path asks it before it gets this
 * far; this function answers only for a row it has read.
 */
async function assertIdentityCloudOffered(tx: Db | Tx, cloudIdentityId: string): Promise<void> {
	const rows = await tx
		.select({ provider: cloudIdentities.provider })
		.from(cloudIdentities)
		.where(eq(cloudIdentities.id, cloudIdentityId));
	for (const row of rows) assertCloudOffered(row.provider);
}

/**
 * Refuses a project whose cloud account is on a cloud this deployment does not offer, by throwing
 * `CloudNotOfferedError`. It is the check for the two operations that put new infrastructure on a
 * cloud, plan and deploy. Reading the project, drift detection, kubeconfig minting, destroy and
 * removing the account do not call it and stay open.
 *
 * A project with no cloud account, and an id that matches no row the transaction can read, are not
 * refused: there is no cloud to refuse.
 *
 * Every path that queues a PLAN or a DEPLOY asks it (#6964): `buildConfigSnapshot` in
 * app/server/actions/projects.ts for the plan, deploy and build a person queues (the console, the
 * agent and `POST /api/jobs` all go through it), and {@link projectCloudRefusal} for the deploys the
 * system queues with nobody asking (auto-heal, a promotion, the deploy a build chains, and the build
 * a deploy chains). A destroy plan is a plan of a teardown and is not asked.
 */
export async function assertProjectCloudOffered(tx: Db | Tx, projectId: string): Promise<void> {
	const rows = await tx
		.select({ cloud_identity_id: projects.cloud_identity_id })
		.from(projects)
		.where(eq(projects.id, projectId));
	for (const row of rows) {
		if (row.cloud_identity_id) await assertIdentityCloudOffered(tx, row.cloud_identity_id);
	}
}

/**
 * The refusal {@link assertProjectCloudOffered} would throw, returned instead: null when the project
 * may be planned and deployed. For the service-role paths that queue a DEPLOY with nobody waiting on
 * the answer, which skip or block the work rather than throw. Any other error is rethrown.
 */
export async function projectCloudRefusal(
	db: Db | Tx,
	projectId: string,
): Promise<CloudNotOfferedError | null> {
	try {
		await assertProjectCloudOffered(db, projectId);
		return null;
	} catch (error) {
		if (error instanceof CloudNotOfferedError) return error;
		throw error;
	}
}

export async function insertProjectWithDefaultFabric(
	tx: Tx,
	input: CreateProjectCoreInput,
): Promise<CreateProjectCoreResult> {
	// Before any read or write: a new project is accepted only on a cloud this deployment offers.
	// This is the one insert path for a project, so it covers the console create, the duplicate
	// (which creates through the same action) and the CLI route.
	if (input.cloud_identity_id) await assertIdentityCloudOffered(tx, input.cloud_identity_id);

	// One org-scoped read serves both uniqueness questions, and they are answered DIFFERENTLY on
	// purpose (#3145). The slug is DERIVED, so a collision is de-duplicated silently — that is what
	// `api-2` is for, and no user ever typed it. The NAME is the user's, and is the token
	// `alethia project get <name>` addresses, so a collision is REFUSED rather than quietly
	// rewritten: silently creating "api" when "api" exists gives them two projects they cannot tell
	// apart from the terminal.
	const existing = await tx
		.select({ slug: projects.slug, project_name: projects.project_name })
		.from(projects)
		.where(eq(projects.org_id, input.orgId));

	// Case-insensitive, matching `projects_org_id_project_name_key` (UNIQUE on
	// (org_id, lower(project_name))). Checking with a different predicate than the index enforces
	// is how a friendly message gets skipped and a raw 23505 reaches the user instead.
	const wanted = input.project_name.toLowerCase();
	if (existing.some((r) => r.project_name.toLowerCase() === wanted)) {
		throw new ProjectNameTakenError(input.project_name);
	}

	// Unique-per-org URL slug, skipping reserved project-child segments (e.g. "settings") so a
	// project slug can never shadow a project-scoped route.
	const takenSlugs = [
		...existing.map((r) => r.slug).filter((s): s is string => Boolean(s)),
		...RESERVED_PROJECT_CHILD_SLUGS,
	];
	const slug = pickFreeSlug(slugify(input.project_name, "project"), takenSlugs);

	// Both checks above are read-then-write inside the caller's transaction, which at READ
	// COMMITTED is optimistic: two concurrent creates of "api" both read the same rows and both
	// compute the same answer. The constraints are what actually enforce uniqueness, so the loser
	// used to surface a raw Postgres error — a bare 500 through `POST /api/cli/projects`. Mapping
	// it here means the race and the ordinary case give the SAME message.
	//
	// A name violation cannot be another tenant's: the index is keyed on (org_id, ...), so a
	// conflict is necessarily inside the caller's own org and the message leaks nothing.
	// A SLUG COLLISION MUST NOT RAISE, and that is the whole reason for `onConflictDoNothing`
	// here rather than a try/catch around a plain insert.
	//
	// This function always runs inside the CALLER's transaction — `withScope` →
	// `getAppDb().transaction(...)` on the console path, `db.transaction(...)` at
	// `app/api/cli/projects/route.ts` on the CLI path — and neither drizzle nor postgres-js opens
	// an implicit savepoint per statement. So a 23505 puts the whole transaction in the aborted
	// state, and the next command on that connection fails with 25P02 `current transaction is
	// aborted`. A retry written as catch-then-re-read therefore CANNOT succeed: it replaces a raw
	// slug violation with a stranger error, and only under the concurrency it was written for, so
	// every test with distinct names stays green over it.
	//
	// Targeting the slug constraint alone keeps the two conflicts distinguishable: a slug race
	// returns zero rows and is retried, while a NAME violation still raises and is mapped below.
	// (`onConflictDoNothing()` untargeted would swallow both and silently return nothing for a
	// duplicate name — the friendly error replaced by no error at all.)
	const insertProject = (withSlug: string) =>
		tx
			.insert(projects)
			.values({
				project_name: input.project_name,
				region: input.region,
				iac_version: input.iac_version,
				cloud_identity_id: input.cloud_identity_id ?? null,
				webhook_ca_consumers: normalizeWebhookCaConsumers(
					input.webhook_ca_consumers,
				),
				slug: withSlug,
				user_id: input.owner,
				org_id: input.orgId,
			})
			.onConflictDoNothing({ target: [projects.org_id, projects.slug] })
			.returning();

	let inserted: Awaited<ReturnType<typeof insertProject>>;
	try {
		inserted = await insertProject(slug);
	} catch (err) {
		if (violates(err, "projects_org_id_project_name_key")) {
			throw new ProjectNameTakenError(input.project_name);
		}
		throw err;
	}

	// Zero rows means the slug lost a race — the derived value, not the user's. The remedy is the
	// one pickFreeSlug already implements: re-read so the retry sees whatever the winner actually
	// took, rather than incrementing blindly. ONE retry, because a second miss is no longer a race
	// and a loop here would hide a real defect. The transaction is healthy at this point, which is
	// exactly what the catch-based version could not say.
	if (inserted.length === 0) {
		const now = await tx
			.select({ slug: projects.slug })
			.from(projects)
			.where(eq(projects.org_id, input.orgId));
		try {
			inserted = await insertProject(
				pickFreeSlug(slugify(input.project_name, "project"), [
					...now.map((r) => r.slug).filter((s): s is string => Boolean(s)),
					...RESERVED_PROJECT_CHILD_SLUGS,
				]),
			);
		} catch (err) {
			if (violates(err, "projects_org_id_project_name_key")) {
				throw new ProjectNameTakenError(input.project_name);
			}
			throw err;
		}
	}

	const [project] = inserted;
	if (!project) throw new Error("Failed to create project");

	// The Fabric(s) are the front door's infra units. Project-level region/cloud stay populated for
	// compatibility while downstream reads move to Fabric. Common per-Fabric values:
	const fabricBase = {
		project_id: project.id,
		user_id: input.owner,
		org_id: project.org_id,
		cloud_identity_id: input.cloud_identity_id ?? null,
		region: input.region,
		status: "DRAFT" as const,
	};

	let defaultFabric: { id: string };
	let defaultEnv: { id: string };
	let previewEnv: { id: string };

	if (input.environments && input.environments.length > 0) {
		// --- Fan-out: the full environment matrix from the placement selector (#844) ---------------
		// Placement model: a `dedicated` env OWNS its Fabric 1:1; every `namespace`/`vcluster` env is
		// placed onto the Fabric of a dedicated env, because only a dedicated env provisions a cluster.
		// Everything is `DRAFT` — no cluster is provisioned until a deploy.
		const specs = input.environments;
		// Bound the fan-out HERE, not just in the form schema — createProject doesn't re-parse the
		// client input, so the core is the real choke point against a crafted many-env request.
		if (specs.length > 8) {
			throw new Error("Too many environments (max 8).");
		}
		const defaults = specs.filter((s) => s.is_default);
		if (defaults.length !== 1) {
			throw new Error("Exactly one environment must be the default.");
		}
		const specsProblem = environmentSpecsProblem(specs);
		if (specsProblem) throw new Error(specsProblem);
		// Still reserved even though the fan-out no longer mints a Fabric by this name: projects
		// created before that fix carry one, so the name would be ambiguous in a state key and in
		// `project env add --fabric shared`.
		const SHARED_FABRIC = "shared";
		if (specs.some((s) => s.name === SHARED_FABRIC)) {
			throw new Error(`"${SHARED_FABRIC}" is a reserved environment name.`);
		}
		// Unique env names — mirrors the (project_id, name) constraint so the env→Fabric map is 1:1.
		if (new Set(specs.map((s) => s.name)).size !== specs.length) {
			throw new Error("Environment names must be unique.");
		}
		// One Fabric per dedicated env; shared placements join a dedicated env's Fabric rather than a
		// Fabric of their own, because only a dedicated env provisions a cluster. See the rationale on
		// planFabricPlacement — this is the decision that used to mint an unprovisionable `shared`.
		const { fabricNames, hostFor } = planFabricPlacement(specs);
		const fabricRows = await tx
			.insert(projectFabrics)
			.values(fabricNames.map((name) => ({ ...fabricBase, name })))
			.returning({ id: projectFabrics.id, name: projectFabrics.name });
		const fabricByName = new Map(fabricRows.map((f) => [f.name, f.id]));
		const fabricFor = (s: EnvironmentSpec): string => {
			const id = fabricByName.get(hostFor(s));
			if (!id) throw new Error(`No Fabric for environment "${s.name}".`);
			return id;
		};
		await refuseClaimedPlacementNamespaces(
			tx,
			project.id,
			specs.flatMap((s) =>
				s.placement_mode === "namespace"
					? [{ fabricId: fabricFor(s), namespace: effectivePlacementNamespace(s) }]
					: [],
			),
		);

		const envRows = await tx
			.insert(projectEnvironments)
			.values(
				specs.map((s) => ({
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: s.name,
					stage: s.stage,
					status: "DRAFT" as const,
					is_default: s.is_default ?? false,
					region: input.region,
					fabric_id: fabricFor(s),
					placement_mode: s.placement_mode,
					// `dedicated` owns the whole Fabric → no namespace; shared placements carry one.
					namespace: s.placement_mode === "dedicated" ? null : (s.namespace ?? null),
					lifecycle: s.lifecycle ?? "persistent",
				})),
			)
			.returning({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				is_default: projectEnvironments.is_default,
			});

		const def = envRows.find((e) => e.is_default);
		if (!def) throw new Error("Failed to create the default environment.");
		defaultEnv = { id: def.id };
		// `previewEnv` is retained for the result contract; fall back to the default if none is named.
		previewEnv = { id: (envRows.find((e) => e.name === "preview") ?? def).id };
		defaultFabric = { id: fabricFor(defaults[0]) };
	} else {
		// --- Legacy shape (unchanged): one Fabric named after the stage; Prod(dedicated) + Preview
		// (namespace) BOTH placed on it. Byte-identical to the #900 seam so the CLI route and any
		// caller that doesn't set `environments` don't drift.
		const [fabric] = await tx
			.insert(projectFabrics)
			.values({ ...fabricBase, name: input.environment_stage })
			.returning({ id: projectFabrics.id });
		if (!fabric) throw new Error("Failed to create default Fabric");
		await refuseClaimedPlacementNamespaces(tx, project.id, [
			{ fabricId: fabric.id, namespace: "preview" },
		]);

		const [dEnv, pEnv] = await tx
			.insert(projectEnvironments)
			.values([
				{
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: input.environment_stage,
					stage: input.environment_stage,
					status: "DRAFT",
					is_default: true,
					region: input.region,
					fabric_id: fabric.id,
					placement_mode: input.placement_mode ?? "dedicated",
				},
				{
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: "preview",
					stage: "development",
					status: "DRAFT",
					is_default: false,
					region: input.region,
					fabric_id: fabric.id,
					placement_mode: "namespace",
					namespace: "preview",
				},
			])
			.returning({ id: projectEnvironments.id });
		if (!dEnv || !pEnv)
			throw new Error("Failed to create project environments");
		defaultFabric = fabric;
		defaultEnv = dEnv;
		previewEnv = pEnv;
	}

	// Authz hierarchy edge: project → org, so an org-wide grant flows down to this project.
	await tx
		.insert(resourceHierarchy)
		.values({
			child_type: "project",
			child_id: project.id,
			parent_type: "org",
			parent_id: input.orgId,
		})
		.onConflictDoNothing();
	mirrorHierarchyEdge("project", project.id, "org", input.orgId);

	return { project, defaultFabric, defaultEnv, previewEnv };
}

// ============================================================
// The org overview's project grid — one keyset page at a time (LST-4 #7486, epic #7481).
// ============================================================
//
// Before this builder the grid read EVERY project of the organization (`queryProjects`, deleted
// here), filtered and sorted them in memory, and the browser drew a growing "Show more" window
// over the lot. Now the rows are filtered, ordered and cut in SQL, the per-card rollups are read
// for the page's ids only, and the facets are a separate pass over the unfiltered universe.
//
// SCOPE IS THE TRANSACTION. Every read here runs in the caller's `withActorScope` transaction, so
// the org wall is the RLS policy on `projects` (`org_id = app.current_org`), as it was for the
// reader this replaces — there is no `org_id` predicate to thread, and the facet pass therefore
// carries no WHERE at all. That is the support list's shape (`queryCasesPage`), and why this builder
// is declared in `F7_UNDRIVEN` and its two-pass property is asserted by
// tests/lib/queries/projects-page.test.ts instead.
//
// TWO ORDERS, BOTH TOTAL.
// - `activity` (the default): the project's `updated_at`, newest first, through the shared codec —
//   ms-truncated sort key, then id ({@link keysetSortKey}, {@link keysetOrderBy}, {@link keysetAfter}).
// - `name`: `lower(project_name)` ascending, then id. A name is not an instant, so this order takes
//   the shape `queryRolesPage` (LST-8) gave its alphabetical rail: the cursor is still the shared
//   opaque codec over the last row's id (a malformed one is a 400 at the boundary), its instant is a
//   constant, and the predicate reads the cursor row's name back by id in the same statement — under
//   the same RLS, so a cursor can never name another org's project. The cursor stays short and free
//   of user text. If the cursor's project is deleted between two pages the walk ends there; the
//   delete is a `projects` hint, which refetches the list from page one without it.
//
// FAVOURITES are the browser's (`useProjectsStore`), so they cannot order the server's walk without
// putting them in the list's key, where the route's prefetch could never match them. The grid asks
// for its starred projects by id instead (`ids`), as a second, bounded read of the same builder,
// draws them first, and drops them from the walk's rows — so a starred project on page four is on
// screen at once, not when the reader scrolls to it.

/** The grid's query: the address's search, filters and sort, plus the starred-projects lookup. */
export interface ProjectsPageQuery {
	/** Case-insensitive contains-match on the project name (LIKE-escaped). */
	q?: string;
	/** Keep projects whose cloud is one of these (OR). An unknown cloud matches nothing. */
	clouds?: string[];
	/** Keep projects that use any of these source-repository URLs (OR). */
	repos?: string[];
	/** `activity` = most recently updated first (default); `name` = A→Z. */
	sort?: "activity" | "name";
	/**
	 * Only these projects — the grid's starred-projects lookup. A lookup, not a walk: it answers
	 * no facets and no `universeEmpty` (both null), because the walk beside it already has them.
	 */
	ids?: string[];
}

/** A cloud facet option with its count of projects over the unfiltered universe. */
interface ProjectCloudFacet {
	value: string;
	count: number;
}

/** A repository facet option — its URL and `owner/repo` label — with its unfiltered project count. */
interface ProjectRepoFacet {
	url: string;
	label: string;
	count: number;
}

/** The grid's facets: every cloud and repository in the organization, never narrowed by the query. */
export interface ProjectsFacets {
	clouds: ProjectCloudFacet[];
	repos: ProjectRepoFacet[];
}

/** One page of the grid (`KeysetListPage`): rows, the next cursor, and first-page facets. */
export type ProjectsPage = KeysetListPage<ProjectListItem, ProjectsFacets>;

/** The instant every name-ordered cursor carries: the predicate reads the row's name back by id. */
const NAME_CURSOR_AT = new Date(0);

/** The `activity` order's sort key: `updated_at` truncated to ms, as the codec requires. */
const PROJECT_UPDATED_AT: SQL = keysetSortKey(projects.updated_at);

/** The `name` order's sort key: the name case-folded, matching the per-org unique index. */
const PROJECT_SORT_NAME: SQL = sql`lower(${projects.project_name})`;

/** The cursor row, read back inside the `name` predicate to learn the name it sorts under. */
const cursorProject = alias(projects, "cursor_project");

/**
 * Rows strictly after `cursor` in `(lower(name), id)` order — one row-value comparison against the
 * cursor row as it reads now, in the same transaction (so under the same RLS wall).
 */
function nameAfter(tx: Tx, cursor: KeysetPosition | undefined): SQL | undefined {
	if (cursor === undefined) return undefined;
	const at = tx
		.select({ name: sql`lower(${cursorProject.project_name})`, id: cursorProject.id })
		.from(cursorProject)
		.where(eq(cursorProject.id, cursor.id));
	return sql`(${PROJECT_SORT_NAME}, ${projects.id}) > (${at})`;
}

/**
 * The rows-pass predicate for `query`: search, clouds, repositories and the starred-ids lookup.
 * A cloud list with no cloud this schema knows matches NOTHING — dropping the predicate would widen
 * a narrowed view to the whole organization.
 */
function projectsPredicate(tx: Tx, query: ProjectsPageQuery): SQL | undefined {
	const search = searchTerm(query.q);
	const cloudsAsked = nonEmpty(query.clouds);
	const clouds = narrowTo(cloudProvider.enumValues, query.clouds);
	const repos = nonEmpty(query.repos);
	const ids = nonEmpty(query.ids);
	return and(
		search ? sql`${projects.project_name} ilike ${likeTerm(search)}` : undefined,
		cloudsAsked ? (clouds ? inArray(cloudIdentities.provider, clouds) : sql`false`) : undefined,
		repos
			? exists(
					tx
						.select({ one: sql`1` })
						.from(projectSourceRepos)
						.where(and(eq(projectSourceRepos.project_id, projects.id), inArray(projectSourceRepos.repo_url, repos))),
				)
			: undefined,
		ids ? inArray(projects.id, ids) : undefined,
	);
}

/**
 * The per-card rollups for one page's projects: distinct source repositories, environment count and
 * last deploy (every environment), and the DEFAULT environment's services and add-ons. Read for the
 * page's ids only — never for the organization.
 */
async function projectRollups(tx: Tx, rows: ProjectWithProvider[]): Promise<ProjectListItem[]> {
	const ids = rows.map((p) => p.id);
	if (ids.length === 0) return [];
	const defaultEnvIds = rows.map((p) => p.default_environment_id).filter((id): id is string => Boolean(id));
	const [repoRows, envRows, serviceRows, addonRows] = await Promise.all([
		tx
			.selectDistinct({ project_id: projectSourceRepos.project_id, repo_url: projectSourceRepos.repo_url })
			.from(projectSourceRepos)
			.where(inArray(projectSourceRepos.project_id, ids)),
		tx
			.select({
				project_id: projectEnvironments.project_id,
				n: count(),
				last_deployed_at: max(projectEnvironments.last_deployed_at),
			})
			.from(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, ids))
			.groupBy(projectEnvironments.project_id),
		defaultEnvIds.length
			? tx
					.select({ project_id: projectServices.project_id, n: count() })
					.from(projectServices)
					.where(inArray(projectServices.environment_id, defaultEnvIds))
					.groupBy(projectServices.project_id)
			: [],
		defaultEnvIds.length
			? tx
					.select({ project_id: projectAddons.project_id, n: count() })
					.from(projectAddons)
					.where(inArray(projectAddons.environment_id, defaultEnvIds))
					.groupBy(projectAddons.project_id)
			: [],
	]);
	const repos = new Map<string, { url: string; label: string }[]>();
	for (const r of repoRows) {
		if (!r.project_id) continue;
		const list = repos.get(r.project_id) ?? [];
		list.push({ url: r.repo_url, label: repoLabel(r.repo_url) });
		repos.set(r.project_id, list);
	}
	const envs = new Map(envRows.map((r) => [r.project_id, r]));
	const services = new Map(serviceRows.map((r) => [r.project_id, Number(r.n)]));
	const addons = new Map(addonRows.map((r) => [r.project_id, Number(r.n)]));
	return rows.map((p) => {
		const env = envs.get(p.id);
		return {
			...p,
			repositories: repos.get(p.id) ?? [],
			services_count: services.get(p.id) ?? 0,
			addons_count: addons.get(p.id) ?? 0,
			environments_count: env ? Number(env.n) : 0,
			last_deployed_at: env?.last_deployed_at ?? null,
		};
	});
}

/**
 * The facet pass: every cloud and repository of the organization's projects, each with its count of
 * projects. It is handed NOTHING from the query — no search, no filter, no cursor — which is the
 * invariant: an option never disappears as you pick it. The scope is the transaction's RLS.
 */
async function projectsFacetPass(tx: Tx): Promise<{ facets: ProjectsFacets; universeEmpty: boolean }> {
	const [cloudRows, repoRows, anyProject] = await Promise.all([
		tx
			.select({ value: cloudIdentities.provider, count: count() })
			.from(projects)
			.innerJoin(cloudIdentities, eq(projects.cloud_identity_id, cloudIdentities.id))
			.groupBy(cloudIdentities.provider),
		tx
			.select({ url: projectSourceRepos.repo_url, count: countDistinct(projectSourceRepos.project_id) })
			.from(projectSourceRepos)
			.innerJoin(projects, eq(projects.id, projectSourceRepos.project_id))
			.groupBy(projectSourceRepos.repo_url),
		tx.select({ id: projects.id }).from(projects).limit(1),
	]);
	return {
		facets: {
			clouds: cloudRows
				.map((r) => ({ value: r.value, count: Number(r.count) }))
				.sort((a, b) => a.value.localeCompare(b.value)),
			repos: repoRows
				.map((r) => ({ url: r.url, label: repoLabel(r.url), count: Number(r.count) }))
				.sort((a, b) => a.label.localeCompare(b.label)),
		},
		universeEmpty: anyProject.length === 0,
	};
}

/**
 * One page of the overview grid for `query`, inside the caller's actor-scoped transaction: at most
 * `limit` projects strictly after the cursor in the query's order, each with its card rollups, and
 * — on the first page of a walk only — the facets over the UNFILTERED organization and whether it
 * has any project at all. A later page, and the starred-ids lookup, carry `facets: null`.
 */
export async function queryProjectsPage(
	tx: Tx,
	query: ProjectsPageQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<ProjectsPage> {
	const byName = query.sort === "name";
	const walk = query.ids === undefined;
	const firstPage = request.cursor === undefined && walk;

	const [fetched, first] = await Promise.all([
		tx
			.select({
				project: projects,
				cloud_provider: cloudIdentities.provider,
				env_id: projectEnvironments.id,
				env_name: projectEnvironments.name,
				env_status: projectEnvironments.status,
			})
			.from(projects)
			.leftJoin(cloudIdentities, eq(projects.cloud_identity_id, cloudIdentities.id))
			.leftJoin(
				projectEnvironments,
				and(eq(projectEnvironments.project_id, projects.id), eq(projectEnvironments.is_default, true)),
			)
			.where(
				and(
					projectsPredicate(tx, query),
					byName ? nameAfter(tx, request.cursor) : keysetAfter(PROJECT_UPDATED_AT, projects.id, request.cursor),
				),
			)
			.orderBy(
				...(byName
					? [sql`${PROJECT_SORT_NAME} asc`, sql`${projects.id} asc`]
					: keysetOrderBy(PROJECT_UPDATED_AT, projects.id)),
			)
			.limit(keysetFetchLimit(request.limit)),
		firstPage ? projectsFacetPass(tx) : null,
	]);

	const cut = keysetPage(fetched, request.limit, (r) => ({
		at: byName ? NAME_CURSOR_AT : r.project.updated_at,
		id: r.project.id,
	}));
	const rows = await projectRollups(
		tx,
		cut.rows.map((r) => ({
			...r.project,
			cloud_provider: r.cloud_provider ?? null,
			environment_stage: r.env_name ?? "development",
			status: r.env_status ?? "DRAFT",
			default_environment_id: r.env_id ?? null,
		})),
	);
	const page = { rows, nextCursor: walk ? cut.nextCursor : null };
	if (first === null) return keysetListPage(page, null);
	return keysetListPage(page, { facets: first.facets, universeEmpty: first.universeEmpty });
}

/** How many projects the actor's organization has — the Usage card's count, not a list size. */
export async function countProjects(tx: Tx): Promise<number> {
	const [row] = await tx.select({ n: count() }).from(projects);
	return Number(row?.n ?? 0);
}
