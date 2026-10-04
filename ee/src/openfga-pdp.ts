// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The enterprise authorization engine: OpenFGA-backed ReBAC implementing the same Pdp
// contract as the community PostgresRbacPDP, so getPdp() swaps it in with no call-site
// changes. Uses ONLY core's pure helpers (core.fga.*) + the FGA client — no core
// runtime import. Standup-verified (needs a running OpenFGA + a backfilled store).

import type { Action, Resource } from "@/lib/authz/registry";
import type {
	Actor,
	BulkCheck,
	Decision,
	Pdp,
	ResourceRef,
} from "@/lib/authz/types";
import type { CoreContext } from "@/lib/enterprise";

/** The two OpenFGA reads this engine makes; `OpenFgaClient` provides both. */
export interface FgaReader {
	check(request: {
		user: string;
		relation: string;
		object: string;
	}): Promise<{ allowed?: boolean }>;
	listObjects(request: {
		user: string;
		relation: string;
		type: string;
	}): Promise<{ objects?: string[] }>;
}

/** The core capabilities this engine uses, out of `CoreContext`. */
export interface PdpCore {
	lacksActiveMembership: CoreContext["lacksActiveMembership"];
	fga: Pick<
		CoreContext["fga"],
		"checksFor" | "denyChecksFor" | "enforceDecision" | "listOrgResourceIds"
	>;
}

export class OpenFgaPdp implements Pdp {
	constructor(
		private readonly core: PdpCore,
		private readonly client: FgaReader,
	) {}

	/**
	 * Decides one check. An actor who is not an active member of the org — a member row that is not
	 * `active`, or no member row outside their personal scope — is denied before any tuple is read
	 * (#5472): suspension and removal revoke their own grant tuples, but team tuples
	 * (`team:T#member@user:U`) can outlive both, and FGA resolves a team's grants through them.
	 * `PostgresRbacPDP` applies the same rule in its grant query, so the two engines agree.
	 */
	async can(
		actor: Actor,
		action: Action,
		resource: ResourceRef,
	): Promise<Decision> {
		if (await this.core.lacksActiveMembership(actor.orgId, actor.userId)) {
			return { allowed: false, reason: "no_grant" };
		}
		const opts = { id: resource.id, orgId: actor.orgId };
		const allowChecks = this.core.fga.checksFor(resource.type, action, opts);
		const denyChecks = this.core.fga.denyChecksFor(resource.type, action, opts);
		const user = `user:${actor.userId}`;
		// Explicit-deny-wins (IAM-style, matching PostgresRbacPDP.decide): the actor is
		// allowed ⇔ SOME allow check passes AND NO deny check passes. The allow half ORs
		// the instance grant and/or the raw org-wide capability; the deny half VETOES on a
		// per-instance/org deny. Without this veto the raw org capability would silently
		// override a per-instance deny (the community↔enterprise parity bug this closes).
		const [allowResults, denyResults] = await Promise.all([
			Promise.all(
				allowChecks.map((c) =>
					this.client.check({ user, relation: c.relation, object: c.object }),
				),
			),
			Promise.all(
				denyChecks.map((c) =>
					this.client.check({ user, relation: c.relation, object: c.object }),
				),
			),
		]);
		if (denyResults.some((r) => r.allowed === true)) {
			return { allowed: false, reason: "explicit_deny" };
		}
		return allowResults.some((r) => r.allowed === true)
			? { allowed: true }
			: { allowed: false, reason: "no_grant" };
	}

	async enforce(
		actor: Actor,
		action: Action,
		resource: ResourceRef,
	): Promise<void> {
		const decision = await this.can(actor, action, resource);
		this.core.fga.enforceDecision(actor, action, resource, decision);
	}

	async bulkCheck(actor: Actor, checks: BulkCheck[]): Promise<Decision[]> {
		return Promise.all(checks.map((c) => this.can(actor, c.action, c.resource)));
	}

	async listAccessible(
		actor: Actor,
		action: Action,
		resourceType: Resource,
	): Promise<string[]> {
		// An actor who is not an active member can reach nothing, for the reason `can` states.
		if (await this.core.lacksActiveMembership(actor.orgId, actor.userId)) return [];
		const user = `user:${actor.userId}`;
		// Org-wide capability ⇒ every instance of the type in the org (matches the
		// PostgresRbacPDP org-wide path). This must be DENY-AWARE, exactly like that
		// engine — else "allow the org except this project/except this action" silently
		// over-permits here (the same explicit-deny-wins parity `can()` enforces).
		const orgCap = await this.client.check({
			user,
			relation: `${resourceType}_${action}`,
			object: `org:${actor.orgId}`,
		});
		if (orgCap.allowed === true) {
			// An org-wide deny on this permission removes everything (Postgres returns []).
			const orgDeny = await this.client.check({
				user,
				relation: `${resourceType}_deny_${action}`,
				object: `org:${actor.orgId}`,
			});
			if (orgDeny.allowed === true) return [];
			// Otherwise: every org instance MINUS the ones the actor is explicitly denied.
			// `deny_<action>` = a direct per-instance `perm_deny` (no parent edge needed)
			// OR a deny inherited down the hierarchy — so listObjects captures per-instance
			// and descendant-of-denied-container denials, mirroring Postgres' deny subtraction.
			const [allIds, deniedRes] = await Promise.all([
				this.core.fga.listOrgResourceIds(resourceType, actor.orgId),
				this.client.listObjects({
					user,
					relation: `deny_${action}`,
					type: resourceType,
				}),
			]);
			const denied = new Set(
				(deniedRes.objects ?? [])
					.map((o) => o.split(":")[1])
					.filter((id): id is string => Boolean(id)),
			);
			return allIds.filter((id) => !denied.has(id));
		}
		// Otherwise the instances the actor can act on directly (scoped grants). `can_<action>`
		// is itself deny-aware in the model (allow MINUS deny), so this path needs no subtraction.
		const res = await this.client.listObjects({
			user,
			relation: `can_${action}`,
			type: resourceType,
		});
		return (res.objects ?? [])
			.map((o) => o.split(":")[1])
			.filter((id): id is string => Boolean(id));
	}
}
