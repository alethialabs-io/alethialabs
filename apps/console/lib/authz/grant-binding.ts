// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A grant's references stay inside the grant's own organization.
//
// A grant row names an org and up to three other things that are themselves owned by an org: the
// ROLE it binds, a TEAM principal, and the RESOURCE it is scoped to. The invariant is that each is
// owned by the grant's org (a built-in role is owned by none and is valid everywhere). Nothing in
// the schema states it — `grants.role_id` is a foreign key to `role.id` alone, `principal_id` and
// `resource_id` are bare uuids — so it is stated in ONE place, the SQL function
// `grant_org_binding_violation` (lib/db/programmables.sql), and every reader asks that function:
//
//   * the `grants_org_binding` trigger, which refuses a row from ANY writer;
//   * the two write boundaries, through `grantBindingViolation` below, so the person who asked
//     gets a named refusal before the insert instead of a constraint error after it;
//   * the community PDP's grant read and the ee OpenFGA writer, which skip an ALLOW row that
//     fails it — a row stored before the trigger existed, or whose resource later moved org.
//
// Why a SQL function and not a TypeScript one: the trigger cannot call TypeScript, and two copies
// of the predicate are two things to keep in step. The write boundaries asking the database the
// same question the trigger will ask means the refusal and the backstop cannot disagree.

import { sql } from "drizzle-orm";
import type { GrantResource } from "@/lib/authz/grant-scope";
import { resourceIdOf } from "@/lib/authz/grant-scope";
import { getServiceDb } from "@/lib/db";

/** Why a grant is not bound to its org — the codes `grant_org_binding_violation` returns. */
export type GrantBindingReason = "foreign_role" | "foreign_team" | "foreign_resource";

const REASONS: ReadonlySet<string> = new Set<GrantBindingReason>([
	"foreign_role",
	"foreign_team",
	"foreign_resource",
]);

/** Narrows the function's text result to a known reason code. */
function isGrantBindingReason(value: string): value is GrantBindingReason {
	return REASONS.has(value);
}

/**
 * The refusal each write boundary returns, per reason. Worded from the grantor's side: the thing
 * they named is not part of this organization. "Unknown" and "another org's" deliberately read the
 * same, so the answer says nothing about ids outside the caller's org.
 */
export const GRANT_BINDING_MESSAGE: Readonly<Record<GrantBindingReason, string>> = {
	foreign_role: "That role is not part of this organization. Choose a built-in role or one of this organization's roles.",
	foreign_team: "That team is not part of this organization.",
	foreign_resource: "That resource is not part of this organization.",
};

/** The references of a grant about to be written, as the write boundaries hold them. */
export interface GrantBindingInput {
	orgId: string;
	principalType: "user" | "team";
	principalId: string;
	roleId: string | null;
	resource: GrantResource;
}

/**
 * Asks the database whether a grant's role, team principal and scoped resource all belong to
 * `orgId`. Returns null when they do, else the first failing reason (role, then team, then
 * resource — the order the SQL function checks them in).
 *
 * An unrecognised code from the function is THROWN rather than read as "bound": the function and
 * this type are two halves of one contract, and a code this side does not know is a deploy skew to
 * surface, not a pass.
 */
export async function grantBindingViolation(
	input: GrantBindingInput,
): Promise<GrantBindingReason | null> {
	const rows = await getServiceDb().execute<{ reason: string | null }>(sql`
		select public.grant_org_binding_violation(
			${input.orgId}::uuid,
			${input.principalType},
			${input.principalId}::uuid,
			${input.roleId}::uuid,
			${input.resource.resourceType},
			${resourceIdOf(input.resource)}::uuid
		) as reason
	`);
	const reason = rows[0]?.reason ?? null;
	if (reason === null) return null;
	if (isGrantBindingReason(reason)) return reason;
	throw new Error(`grant_org_binding_violation returned an unknown code: ${reason}`);
}
