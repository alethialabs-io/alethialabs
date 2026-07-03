// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The enterprise authorization engine: OpenFGA-backed ReBAC implementing the same Pdp
// contract as the community PostgresRbacPDP, so getPdp() swaps it in with no call-site
// changes. Uses ONLY core's pure helpers (core.fga.*) + the FGA client — no core
// runtime import. Standup-verified (needs a running OpenFGA + a backfilled store).

import type { OpenFgaClient } from "@openfga/sdk";
import type { Action, Resource } from "@/lib/authz/registry";
import type {
	Actor,
	BulkCheck,
	Decision,
	Pdp,
	ResourceRef,
} from "@/lib/authz/types";
import type { CoreContext } from "@/lib/enterprise";

export class OpenFgaPdp implements Pdp {
	constructor(
		private readonly core: CoreContext,
		private readonly client: OpenFgaClient,
	) {}

	async can(
		actor: Actor,
		action: Action,
		resource: ResourceRef,
	): Promise<Decision> {
		const checks = this.core.fga.checksFor(resource.type, action, {
			id: resource.id,
			orgId: actor.orgId,
		});
		const user = `user:${actor.userId}`;
		// 1–2 checks ORed: the instance grant and/or the org-wide capability.
		const results = await Promise.all(
			checks.map((c) =>
				this.client.check({ user, relation: c.relation, object: c.object }),
			),
		);
		return results.some((r) => r.allowed === true)
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
		const user = `user:${actor.userId}`;
		// Org-wide capability ⇒ every instance of the type in the org (matches the
		// PostgresRbacPDP org-wide path).
		const orgCap = await this.client.check({
			user,
			relation: `${resourceType}_${action}`,
			object: `org:${actor.orgId}`,
		});
		if (orgCap.allowed === true) {
			return this.core.fga.listOrgResourceIds(resourceType, actor.orgId);
		}
		// Otherwise the instances the actor can act on directly (scoped grants).
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
