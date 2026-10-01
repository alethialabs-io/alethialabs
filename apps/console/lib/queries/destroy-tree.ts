// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The DESTROY TREE of an environment (#5249): what tearing it down actually tears down.
//
// A `dedicated` environment OWNS its Fabric — the cluster, the network, the shared add-ons, one
// tofu state. `namespace` and `vcluster` environments are PLACED onto a Fabric and own none of that.
// So destroying a dedicated environment destroys the cluster every other placement on that Fabric
// runs in, and the runner does exactly that (packages/core/provisioner/destroy.go). Before this
// module nothing asked whether anyone else lived there: the tenants were orphaned, their own destroy
// then failed closed (destroy_namespace.go cannot mint a kubeconfig for a cluster that is gone), and
// that namespace teardown is what deletes each tenant's per-namespace cloud identity — so those leaked.
//
// The rule is AWS's: a resource with children is not deleted until its children are, unless the
// caller explicitly cascades. A child here is a LIVE tenant:
//
//   - another environment on the SAME `fabric_id`,
//   - whose `placement_mode` is not `dedicated` (a dedicated env owns a Fabric 1:1; it is never a
//     tenant of somebody else's),
//   - whose `status` is anything but DRAFT or DESTROYED. DRAFT has never been applied, so there is
//     nothing in the cluster to orphan; DESTROYED has already been torn down. Every other status —
//     including QUEUED, PROVISIONING, DESTROYING and FAILED — may have something in the cluster.
//
// The same predicate lives in SQL as `public.destroy_waits_on_tenants` (lib/db/programmables.sql),
// which `claim_next_job` uses to hold an owner's DESTROY until its tenants are gone. The two must
// agree: this one decides what the user is told and what a cascade queues, that one decides what a
// runner is allowed to start. Both are exercised against real Postgres in
// tests/integration/destroy-fabric-tenants.test.ts.

import "server-only";
import { and, asc, eq, ne, notInArray } from "drizzle-orm";
import type { Db, Tx } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";
import type { PlacementMode, ProjectStatus } from "@/lib/db/schema/enums";

type Executor = Db | Tx;

/**
 * The statuses in which an environment has nothing in its Fabric's cluster to orphan. Everything
 * outside this list counts as live — FAILED and DESTROYING included, because a failed apply can
 * leave resources and a destroy in flight has not finished removing them.
 */
const NOT_LIVE_STATUSES = [
	"DRAFT",
	"DESTROYED",
] as const satisfies readonly ProjectStatus[];

/** The columns of an environment the tree is computed from. */
export type DestroyTreeSubject = Pick<
	typeof projectEnvironments.$inferSelect,
	"id" | "name" | "project_id" | "fabric_id" | "placement_mode" | "status"
>;

/** One environment in a destroy tree, in the shape both the CLI and the console read. */
export interface DestroyTreeNode {
	environment_id: string;
	name: string;
	placement_mode: PlacementMode;
	status: ProjectStatus;
	/** True for the `dedicated` environment that owns the Fabric (the cluster) — destroyed LAST. */
	owns_fabric: boolean;
	/**
	 * The live tenants this node's DESTROY will wait for. Non-empty only on the owner. A DESTROY of
	 * the owner that is already QUEUED stays QUEUED until this list is empty — claim_next_job will
	 * not hand it to a runner — so a tenant whose destroy FAILED shows up here, by name and status,
	 * instead of the owner silently waiting forever.
	 */
	waiting_on: Array<{ name: string; status: ProjectStatus }>;
}

/**
 * Reads the LIVE tenants of `target`'s Fabric: the non-dedicated environments placed on the Fabric a
 * dedicated `target` owns, excluding DRAFT and DESTROYED ones. Empty for a non-dedicated target (it
 * owns no Fabric, so destroying it orphans nobody) and for a target with no Fabric linked yet.
 *
 * Scoped to the target's project: a Fabric belongs to exactly one project
 * (`project_fabrics.project_id`), and every placement path resolves the Fabric inside the project.
 * The claim-time SQL predicate is NOT project-scoped, so if that ever stopped being true the claim
 * would still refuse to start the owner's destroy — this read is the friendly half, not the guard.
 */
export async function readLiveFabricTenants(
	db: Executor,
	target: DestroyTreeSubject,
): Promise<DestroyTreeSubject[]> {
	if (target.placement_mode !== "dedicated" || !target.fabric_id) return [];
	return db
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			project_id: projectEnvironments.project_id,
			fabric_id: projectEnvironments.fabric_id,
			placement_mode: projectEnvironments.placement_mode,
			status: projectEnvironments.status,
		})
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.project_id, target.project_id),
				eq(projectEnvironments.fabric_id, target.fabric_id),
				ne(projectEnvironments.id, target.id),
				ne(projectEnvironments.placement_mode, "dedicated"),
				notInArray(projectEnvironments.status, [...NOT_LIVE_STATUSES]),
			),
		)
		.orderBy(asc(projectEnvironments.name));
}

/**
 * Orders a target and its live tenants into the destroy tree: every tenant first, the target last.
 * The tenants have no order among themselves — each is its own namespace or vcluster — so they are
 * listed by name, which is what makes the printed tree stable from one run to the next.
 */
export function buildDestroyTree(
	target: DestroyTreeSubject,
	tenants: readonly DestroyTreeSubject[],
): DestroyTreeNode[] {
	const sorted = [...tenants].sort((a, b) => a.name.localeCompare(b.name));
	const node = (
		e: DestroyTreeSubject,
		owns: boolean,
		waitingOn: DestroyTreeNode["waiting_on"],
	): DestroyTreeNode => ({
		environment_id: e.id,
		name: e.name,
		placement_mode: e.placement_mode,
		status: e.status,
		owns_fabric: owns,
		waiting_on: waitingOn,
	});
	const ownsFabric = target.placement_mode === "dedicated";
	return [
		...sorted.map((t) => node(t, false, [])),
		node(
			target,
			ownsFabric,
			sorted.map((t) => ({ name: t.name, status: t.status })),
		),
	];
}

/** "dev-1 (namespace, ACTIVE), staging (vcluster, FAILED)" — how a refusal names the tenants. */
function describeTenants(tenants: readonly DestroyTreeSubject[]): string {
	return [...tenants]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => `${t.name} (${t.placement_mode}, ${t.status})`)
		.join(", ");
}

/**
 * Refusal: the caller asked to destroy a `dedicated` environment while other environments are still
 * placed on its Fabric, and did not ask to cascade. Typed so an HTTP edge answers 409 with the tenant
 * list, without matching on the message text.
 */
export class FabricHasLiveTenantsError extends Error {
	/** The environment whose destroy was refused. */
	readonly target: string;
	/** The live tenants that must be destroyed first, by name. */
	readonly tenants: DestroyTreeSubject[];

	/** Builds the refusal naming `target` and each of its live `tenants`. */
	constructor(target: string, tenants: readonly DestroyTreeSubject[]) {
		const n = tenants.length;
		super(
			`Environment "${target}" owns the cluster that ${n} other environment${n === 1 ? " is" : "s are"} ` +
				`still placed on: ${describeTenants(tenants)}. Destroying it would orphan ` +
				`${n === 1 ? "that environment" : "them"} and could leak ${n === 1 ? "its" : "their"} cloud identities. ` +
				`Destroy ${n === 1 ? "it" : "them"} first, or cascade the destroy (CLI: --cascade) to queue ` +
				`${n === 1 ? "it" : "all of them"} and then "${target}", in that order.`,
		);
		this.name = "FabricHasLiveTenantsError";
		this.target = target;
		this.tenants = [...tenants];
	}
}
