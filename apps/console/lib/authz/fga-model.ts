// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generates the OpenFGA authorization model from the registry (registry-as-code).
// The model is PERMISSION-relational and IAM-like: one grantable relation per
// registry permission key, with hierarchy inheritance — NOT roles. Roles are a
// Postgres concept that expand to per-permission tuples at grant time, so adding or
// editing a custom role needs ZERO model change. The model is static; only tuples move.
//
// For each permission key `R:A`:
//   • org carries a directly-assignable capability `R_A` (an org-wide grant of R:A).
//   • each ANCESTOR container of R also carries `R_A` (= directly-assignable on that
//     container OR inherited from its parent), so a grant scoped to a container flows
//     down to its descendants.
//   • the instance type R carries `perm_A` (a grant scoped to one instance) and
//     `can_A = perm_A OR R_A from parent` (the effective check).
// `create` and org/member/activity/billing keys live only as org capabilities.
//
// Output is plain JSON typed locally (no @openfga/sdk import — this stays in core);
// the ee/ client passes it to writeAuthorizationModel(), which validates it.

import {
	ancestorsOf,
	INSTANCE_TYPES,
	PARENTS,
} from "@/lib/authz/fga-hierarchy";
import { PERMISSIONS, type Action, type Resource } from "@/lib/authz/registry";

interface DirectlyRelatedUserType {
	type: string;
	relation?: string;
}
export interface Userset {
	this?: Record<string, never>;
	computedUserset?: { relation: string };
	tupleToUserset?: {
		tupleset: { relation: string };
		computedUserset: { relation: string };
	};
	union?: { child: Userset[] };
	difference?: { base: Userset; subtract: Userset };
}
interface RelationMetadata {
	directly_related_user_types?: DirectlyRelatedUserType[];
}
interface TypeDefinition {
	type: string;
	relations: Record<string, Userset>;
	metadata?: { relations: Record<string, RelationMetadata> };
}
export interface AuthorizationModel {
	schema_version: string;
	type_definitions: TypeDefinition[];
}

const THIS: Userset = { this: {} };
const computed = (relation: string): Userset => ({ computedUserset: { relation } });
const ttu = (tupleset: string, relation: string): Userset => ({
	tupleToUserset: { tupleset: { relation: tupleset }, computedUserset: { relation } },
});
const union = (...child: Userset[]): Userset => ({ union: { child } });
/** `base but not subtract` — for explicit-deny exclusions. */
const difference = (base: Userset, subtract: Userset): Userset => ({
	difference: { base, subtract },
});

/** Grantable principals: a user directly, or every member of a team. */
const PRINCIPALS: DirectlyRelatedUserType[] = [
	{ type: "user" },
	{ type: "team", relation: "member" },
];

/** Non-`create` actions applicable to a resource, from the registry. */
function instanceActions(resource: Resource): Action[] {
	const seen = new Set<Action>();
	for (const p of PERMISSIONS) {
		if (p.resource === resource && p.action !== "create") seen.add(p.action);
	}
	return [...seen];
}

/** Builds the complete OpenFGA authorization model from the registry. */
export function buildAuthorizationModel(): AuthorizationModel {
	// org: a directly-assignable capability per permission key (the org-wide grant).
	const orgRelations: Record<string, Userset> = {};
	const orgMeta: Record<string, RelationMetadata> = {};
	for (const p of PERMISSIONS) {
		const rel = `${p.resource}_${p.action}`;
		orgRelations[rel] = THIS;
		orgMeta[rel] = { directly_related_user_types: PRINCIPALS };
		// Parallel org-wide DENY capability (an explicit deny scoped to the org).
		const denyRel = `${p.resource}_deny_${p.action}`;
		orgRelations[denyRel] = THIS;
		orgMeta[denyRel] = { directly_related_user_types: PRINCIPALS };
	}

	const relations = new Map<Resource, Record<string, Userset>>();
	const metas = new Map<Resource, Record<string, RelationMetadata>>();
	const ensure = (t: Resource) => {
		if (!relations.has(t)) {
			relations.set(t, {});
			metas.set(t, {});
		}
	};

	// Each instance type: a `parent`, plus per action a scoped `perm_A` and the
	// effective `can_A = perm_A OR <R>_<A> from parent`.
	for (const r of INSTANCE_TYPES) {
		ensure(r);
		const rels = relations.get(r) ?? {};
		const meta = metas.get(r) ?? {};
		rels.parent = THIS;
		meta.parent = {
			directly_related_user_types: (PARENTS[r] ?? []).map((pt) => ({ type: pt })),
		};
		for (const a of instanceActions(r)) {
			rels[`perm_${a}`] = THIS;
			meta[`perm_${a}`] = { directly_related_user_types: PRINCIPALS };
			rels[`perm_deny_${a}`] = THIS;
			meta[`perm_deny_${a}`] = { directly_related_user_types: PRINCIPALS };
			// deny inherits down the hierarchy like allow.
			rels[`deny_${a}`] = union(
				computed(`perm_deny_${a}`),
				ttu("parent", `${r}_deny_${a}`),
			);
			// effective allow, MINUS any deny (explicit deny overrides, IAM-style).
			rels[`can_${a}`] = difference(
				union(computed(`perm_${a}`), ttu("parent", `${r}_${a}`)),
				computed(`deny_${a}`),
			);
		}
	}

	// Intermediate containers (non-org ancestors) carry each descendant capability
	// `<D>_<A>` = directly-assignable on this container OR inherited from its parent.
	for (const d of INSTANCE_TYPES) {
		const actions = instanceActions(d);
		for (const c of ancestorsOf(d)) {
			if (c === "org") continue; // org already holds every capability directly.
			ensure(c);
			const rels = relations.get(c) ?? {};
			const meta = metas.get(c) ?? {};
			for (const a of actions) {
				const cap = `${d}_${a}`;
				rels[cap] = union(THIS, ttu("parent", cap));
				meta[cap] = { directly_related_user_types: PRINCIPALS };
				const denyCap = `${d}_deny_${a}`;
				rels[denyCap] = union(THIS, ttu("parent", denyCap));
				meta[denyCap] = { directly_related_user_types: PRINCIPALS };
			}
		}
	}

	const typeDefs: TypeDefinition[] = [
		{ type: "user", relations: {} },
		{
			type: "team",
			relations: { member: THIS },
			metadata: { relations: { member: { directly_related_user_types: [{ type: "user" }] } } },
		},
		{ type: "org", relations: orgRelations, metadata: { relations: orgMeta } },
	];
	for (const r of INSTANCE_TYPES) {
		typeDefs.push({
			type: r,
			relations: relations.get(r) ?? {},
			metadata: { relations: metas.get(r) ?? {} },
		});
	}

	return { schema_version: "1.1", type_definitions: typeDefs };
}
