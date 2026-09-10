// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct-DB seeding for the RBAC / org-settings e2e specs.
//
// ── WHY THE DENIALS NEED A SEEDER AT ALL ────────────────────────────────────────────────────────
//
// `rbac.negative.spec.ts` asks whether a reduced-permission member is REFUSED when it tries to
// change or remove somebody. Before this file the only rows in ownerTeam's org were the owner —
// whose row renders no manage menu at all — and the member itself, so "a member cannot remove
// another member" had no other member to fail on. It drove its own row, which is a different
// question (leaving an org) with a different answer, and if the denial had ever regressed the suite
// would have destroyed the persona every other spec in the run depends on.
//
// So the negatives are pointed at a THROWAWAY member seeded here. If a denial regresses, what is
// lost is a row this file created and cleans up, and the failure is reported rather than cascading.
//
// ── WHAT IS SAFE TO WRITE, AND WHAT IS NOT ──────────────────────────────────────────────────────
//
// Inserts run as the owner DB role (RLS bypassed — see helpers/db.ts), so every row states its
// `organization_id` explicitly or the app's RLS-scoped reads will not see it.
//
// Nothing here touches a row it did not create. In particular it never suspends, re-roles or
// removes the `member` persona: suspending revokes that member's PDP grant, and a persona denied
// for want of ACCESS rather than of ROLE is exactly the failure that makes an RBAC suite report a
// column of green while measuring nothing (the `HAVE_MEMBER` lesson, one layer down). Seeded rows
// are recognised by their email prefix and by nothing else, so the cleanup cannot widen by accident.

import fs from "node:fs";
import { db } from "./db";
import { personaMetaPath, type PersonaName, type PersonaRecord } from "./personas";
import type { Owner } from "./seed";

/**
 * The email prefix that MAKES a row seeded.
 *
 * The cleanup below matches on this and only this. A cleanup that instead deleted "every member
 * that is not the owner" would reap the `member` persona the moment a spec ran in the wrong order —
 * the blast radius of a seeder must be a set it can enumerate, not a set it can describe.
 */
export const RBAC_SEED_PREFIX = "e2e-rbac-";

/** A member row this file created: the ids the specs drive it by, and the name the table shows. */
export interface SeededMember {
	memberId: string;
	userId: string;
	email: string;
	name: string;
}

/** A pending invitation this file created. */
export interface SeededInvitation {
	id: string;
	email: string;
}

/** A seeded address, unique per row so two workers cannot collide on the `user.email` unique index. */
function seedEmail(label: string): string {
	return `${RBAC_SEED_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@alethia.test`;
}

/**
 * The org a persona owns, read back from the metadata global-setup wrote.
 *
 * `beforeAll` runs before any persona FIXTURE exists, and seeding is a `beforeAll` job — a fixture
 * would re-seed per test. It THROWS rather than returning null: a seeder that quietly seeds nothing
 * is indistinguishable from one whose rows the app cannot see, and both make the specs below pass
 * for the wrong reason.
 */
export function personaOwner(name: PersonaName = "ownerTeam"): Owner {
	const p = personaMetaPath();
	if (!fs.existsSync(p)) {
		throw new Error(`No persona metadata at ${p} — global-setup did not run, so there is no org to seed into.`);
	}
	const meta = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Record<PersonaName, PersonaRecord>>;
	const rec = meta[name];
	if (!rec) throw new Error(`Persona "${name}" missing from personas.json — global-setup may have failed for it.`);
	if (!rec.orgId || !rec.userId) {
		throw new Error(`Persona "${name}" (org ${rec.orgSlug}) has no resolved org_id/user_id — nothing can be scoped to it.`);
	}
	return { orgId: rec.orgId, userId: rec.userId };
}

/**
 * Inserts a real `user` + `member` pair into the org: a colleague for the denials to fail on.
 *
 * The account is real but has no session and never signs in — the specs drive it as a ROW, never as
 * an actor. `role` defaults to `viewer` (the least-privileged assignable role) and `status` to
 * `active`; pass `status: "suspended"` for the Reactivate control's fixture.
 */
export async function seedOrgMember(
	owner: Owner,
	opts: { label?: string; name?: string; role?: string; status?: "active" | "suspended" } = {},
): Promise<SeededMember> {
	const sql = db();
	const email = seedEmail(opts.label ?? "member");
	const name = opts.name ?? "Seeded Colleague";
	const [u] = await sql<{ id: string }[]>`
		insert into "user" ${sql({ email, name, email_verified: true })}
		returning id`;
	if (!u) throw new Error(`insert into "user" returned no row for ${email}`);
	const [m] = await sql<{ id: string }[]>`
		insert into member ${sql({
			organization_id: owner.orgId,
			user_id: u.id,
			role: opts.role ?? "viewer",
			status: opts.status ?? "active",
		})}
		returning id`;
	if (!m) throw new Error(`insert into member returned no row for ${email}`);
	return { memberId: m.id, userId: u.id, email, name };
}

/**
 * Inserts a pending invitation into the org — the `pending-invitation` fixture, without walking the
 * invite dialog for it.
 *
 * `expires_at` is NOT NULL and carries no default, so it is stated here; a week out, because a
 * fixture instant pinned to "now" is a fixture that reads differently on a slow run.
 */
export async function seedPendingInvitation(
	owner: Owner,
	opts: { label?: string; role?: string } = {},
): Promise<SeededInvitation> {
	const sql = db();
	const email = seedEmail(opts.label ?? "invite");
	const [row] = await sql<{ id: string }[]>`
		insert into invitation ${sql({
			organization_id: owner.orgId,
			email,
			role: opts.role ?? "viewer",
			status: "pending",
			expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			inviter_id: owner.userId,
		})}
		returning id`;
	if (!row) throw new Error(`insert into invitation returned no row for ${email}`);
	return { id: row.id, email };
}

/**
 * Removes every row this file seeded into `orgId`, and nothing else.
 *
 * Members go first through their user rows (the `member` FK cascades from `user`), then any
 * invitation carrying the prefix. Both are scoped to the org AND to the prefix: either predicate
 * alone would be too wide — the org holds the persona, and the prefix is shared across runs.
 */
export async function cleanRbacSeed(orgId: string): Promise<void> {
	const sql = db();
	const like = `${RBAC_SEED_PREFIX}%`;
	await sql`
		delete from "user"
		where email like ${like}
		  and id in (select user_id from member where organization_id = ${orgId})`;
	await sql`delete from invitation where organization_id = ${orgId} and email like ${like}`;
}
