// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #3754 operator command: list the org members who hold NO grant, and grant each one ONLY on
// an explicit per-row "y" (or `--yes`). Remediation for the `toOrgRole` gap #3744 closed:
// `ensureMemberGrant` used to narrow `member.role` through `toOrgRole`, which answered null for
// Better Auth's default `member` role, and returned in silence — so those members kept a
// `member` row and zero permissions (the PDP authorizes from `grants`, never from `member.role`).
//
// Usage:
//   pnpm -C apps/console run authz:grant-ungranted -- --list          # read, print, grant nothing
//   pnpm -C apps/console run authz:grant-ungranted                    # list, then ask per row
//   pnpm -C apps/console run authz:grant-ungranted -- --org <uuid>    # one org only
//   pnpm -C apps/console run authz:grant-ungranted -- --yes           # grant the CLEAR rows unasked
//   pnpm -C apps/console run authz:grant-ungranted -- --list --json   # machine-readable listing
//
// Reads ALETHIA_DATABASE_URL (the SERVICE connection, via lib/config/database.ts) from the
// environment, plus ALETHIA_EDITION and the OpenFGA settings when the store should be mirrored.
// Running it against production and the other long-lived databases is the maintainer's step.
//
// Exit codes:
//   0 — nothing is left ungranted in what was listed (nothing found, or every row was granted).
//   2 — rows remain ungranted: declined, held, unmappable, or `--list` (which grants nothing).
//   1 — the command could not run (no database, a query failed).
//
// ── Why this is an operator command and not a backfill ───────────────────────────────────────────
// "Never granted" and "deliberately revoked" are BYTE-IDENTICAL in the data: `revokeGrant`
// (app/server/actions/grants.ts) deletes the grant row and leaves `member.role` intact. A blanket
// backfill would silently restore access an admin removed, so the maintainer ruled (2026-09-18)
// that a person confirms each row. This command shows them the only evidence the database holds:
//
//   * `org revocations since join` — `revokeGrant` records `recordActivity(actor, "revoke",
//     { type: "grant" })` and NOTHING ELSE: no subject, no grant id. So the log can say "a grant
//     was revoked in this org after this member joined", never "THIS member's grant was revoked".
//     That is why it is an org-level count, and why a non-zero count HOLDS the row under `--yes`
//     (it is only granted by a person answering "y" to it).
//   * `team grants` — grants the member holds through a team. Not excluded: a team grant is not
//     the org-wide member grant the gap failed to write. Shown so the operator can see that the
//     member is not locked out entirely.
//
// Suspended members are NOT listed: `setMemberSuspended` (app/server/actions/members.ts) revokes
// the grant and keeps the row, which is the ungranted shape by design.
//
// ── The grant path ───────────────────────────────────────────────────────────────────────────────
// Every grant goes through `ensureMemberGrant` (lib/authz/grants.ts) — the function the member
// lifecycle hooks and `setMemberSuspended` call — so the Postgres row is the same row the app
// writes and the OpenFGA mirror is the same `getTupleSync().syncMemberGrant` call. That mirror is
// fire-and-forget there (Postgres is authoritative, and `backfill()` reconciles tuples from
// `grants` at boot); this command does not `process.exit()`, so node waits for an in-flight mirror
// before exiting instead of cutting it off. That also means it lingers until the service pool's
// idle timeout closes the connections (default 20s) after printing its summary. A mirror FAILURE
// is logged by `ensureMemberGrant`, not reported in this command's exit code.
//
// Idempotent: a row is re-read immediately before its grant, and skipped if the member has gained
// a grant, been suspended, changed role, or left the org since it was listed. Re-running after a
// partial run lists only what is still ungranted.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { toPdpRole } from "@/lib/authz/org-access-control";
import { type Db, getServiceDb } from "@/lib/db";

/** One member with no user-principal grant in their org, plus the evidence shown beside it. */
export type UngrantedMember = {
	member_id: string;
	org_id: string;
	org_name: string;
	user_id: string;
	email: string;
	/** `member.role`, verbatim — what `ensureMemberGrant` is handed. */
	role: string;
	/** `member.created_at` as Postgres text, so no driver date parsing is involved. */
	created_at: string;
	/** Grant rows held through teams the member belongs to. */
	team_grants: number;
	/** Activity rows `action='revoke', resource_type='grant'` in this org since the member joined. */
	org_revocations_since_join: number;
	last_org_revocation: string | null;
};

/**
 * Lists every non-suspended member holding NO user-principal grant in their org — org-wide or
 * scoped, allow or deny: any such row means someone set this member's access, so it is not the
 * gap's shape. Optionally narrowed to one org.
 */
export async function listUngrantedMembers(
	db: Db,
	orgId?: string,
): Promise<UngrantedMember[]> {
	const orgFilter = orgId ? sql`and m.organization_id = ${orgId}::uuid` : sql``;
	return db.execute<UngrantedMember>(sql`
		select
			m.id as member_id,
			m.organization_id as org_id,
			o.name as org_name,
			m.user_id,
			u.email,
			m.role,
			m.created_at::text as created_at,
			(select count(*)::int
			   from grants tg
			   join team_member tm on tm.team_id = tg.principal_id
			  where tg.org_id = m.organization_id and tg.principal_type = 'team'
			    and tm.user_id = m.user_id) as team_grants,
			(select count(*)::int
			   from authz_activity_log a
			  where a.org_id = m.organization_id and a.action = 'revoke'
			    and a.resource_type = 'grant' and a.ts >= m.created_at) as org_revocations_since_join,
			(select max(a.ts)::text
			   from authz_activity_log a
			  where a.org_id = m.organization_id and a.action = 'revoke'
			    and a.resource_type = 'grant' and a.ts >= m.created_at) as last_org_revocation
		from member m
		join organization o on o.id = m.organization_id
		join "user" u on u.id = m.user_id
		left join grants g
		  on g.org_id = m.organization_id and g.principal_type = 'user'
		 and g.principal_id = m.user_id
		where g.id is null and m.status <> 'suspended'
		${orgFilter}
		order by o.name, m.created_at, m.id
	`);
}

/** Why a listed row was, or was not, granted. */
export type RowOutcome =
	| "granted"
	| "declined"
	| "held"
	| "unmappable"
	| "already-granted"
	| "suspended"
	| "role-changed"
	| "gone";

/**
 * Re-reads one listed member and grants them through `ensureMemberGrant` only if they are STILL
 * ungranted, active and on the role that was shown. `ensureMemberGrant` REPLACES the org-wide
 * grant, so granting over a grant an admin wrote since the listing would overwrite their choice;
 * this check is what prevents that (a read then a write, not one transaction — an admin acting in
 * the milliseconds between them is not covered).
 */
export async function grantIfStillUngranted(
	db: Db,
	row: UngrantedMember,
	grant: typeof ensureMemberGrant = ensureMemberGrant,
): Promise<RowOutcome> {
	const [now] = await db.execute<{
		role: string;
		status: string;
		user_grants: number;
	}>(sql`
		select m.role, m.status,
		       (select count(*)::int from grants g
		         where g.org_id = m.organization_id and g.principal_type = 'user'
		           and g.principal_id = m.user_id) as user_grants
		from member m
		where m.id = ${row.member_id}::uuid
	`);
	if (!now) return "gone";
	if (now.user_grants > 0) return "already-granted";
	if (now.status === "suspended") return "suspended";
	if (now.role !== row.role) return "role-changed";
	await grant(row.org_id, row.user_id, row.role);
	return "granted";
}

/** How the pass decides each row. `confirm` is asked only when a person must decide. */
export interface GrantPassOptions {
	db: Db;
	rows: UngrantedMember[];
	/** Grant rows with no revocation evidence without asking. Held rows are never auto-granted. */
	yes: boolean;
	/** Asks the operator about one row; resolves true only on an explicit yes. */
	confirm: (row: UngrantedMember, index: number) => Promise<boolean>;
	grant?: typeof ensureMemberGrant;
	log?: (line: string) => void;
}

/**
 * Walks the listed rows in order and returns one outcome per row. A role no PDP role maps from
 * is never granted (`ensureMemberGrant` would write nothing for it anyway) and never asked about.
 */
export async function runGrantPass(
	opts: GrantPassOptions,
): Promise<RowOutcome[]> {
	const log = opts.log ?? (() => {});
	const outcomes: RowOutcome[] = [];
	for (const [i, row] of opts.rows.entries()) {
		const label = `${i + 1}. ${row.email} in ${row.org_name}`;
		if (!toPdpRole(row.role)) {
			log(`   ${label}: role "${row.role}" maps to no PDP role — not granted.`);
			outcomes.push("unmappable");
			continue;
		}
		let approved: boolean;
		if (opts.yes) {
			if (row.org_revocations_since_join > 0) {
				log(
					`   ${label}: HELD — ${row.org_revocations_since_join} grant revocation(s) in this org since they joined. Re-run without --yes to decide it.`,
				);
				outcomes.push("held");
				continue;
			}
			approved = true;
		} else {
			approved = await opts.confirm(row, i);
		}
		if (!approved) {
			log(`   ${label}: declined — not granted.`);
			outcomes.push("declined");
			continue;
		}
		const outcome = await grantIfStillUngranted(opts.db, row, opts.grant);
		log(
			outcome === "granted"
				? `   ${label}: granted ${toPdpRole(row.role)} (from member.role "${row.role}").`
				: `   ${label}: skipped — ${outcome} since it was listed.`,
		);
		outcomes.push(outcome);
	}
	return outcomes;
}

/** One listed row as an indented block, with the evidence the operator decides on. */
export function renderRow(row: UngrantedMember, index: number): string {
	const pdp = toPdpRole(row.role);
	return [
		`${index + 1}. ${row.email}  (user ${row.user_id})`,
		`   org          ${row.org_name} (${row.org_id})`,
		`   member.role  "${row.role}" → ${pdp ? `grants ${pdp}` : "maps to NO PDP role (will not be granted)"}`,
		`   joined       ${row.created_at}`,
		`   team grants  ${row.team_grants}`,
		`   org revocations since join  ${row.org_revocations_since_join}` +
			(row.last_org_revocation ? ` (latest ${row.last_org_revocation})` : "") +
			(row.org_revocations_since_join > 0
				? " — the log does not record WHOSE grant; this may be one. Held under --yes."
				: ""),
	].join("\n");
}

/** Returns the value of `--name <v>` / `--name=<v>`, or undefined. */
function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** A line-at-a-time prompt over stdin; end of input answers "no" to everything after it. */
function makeConfirm(): {
	confirm: (row: UngrantedMember, index: number) => Promise<boolean>;
	close: () => void;
} {
	const rl = createInterface({ input: stdin, terminal: false });
	const lines = rl[Symbol.asyncIterator]();
	return {
		confirm: async (row, index) => {
			stdout.write(`\nGrant ${index + 1}. ${row.email} in ${row.org_name}? [y/N] `);
			const next = await lines.next();
			if (next.done) return false;
			const answer = String(next.value).trim().toLowerCase();
			return answer === "y" || answer === "yes";
		},
		close: () => rl.close(),
	};
}

/**
 * CLI entry: list, then grant per the flags. Sets `process.exitCode` and never calls exit(), so
 * an in-flight OpenFGA mirror is not cut off. The process ends once the service pool's idle
 * timeout closes its connections (`ALETHIA_DB_IDLE_TIMEOUT`, default 20s — lib/config/database.ts);
 * `getServiceDb()`'s `Db` type does not expose the client, so the pool is not ended here.
 */
async function main(): Promise<void> {
	const listOnly = process.argv.includes("--list");
	const json = process.argv.includes("--json");
	const yes = process.argv.includes("--yes");
	const orgId = arg("org");
	if (json && !listOnly) {
		console.error("✗ --json is a listing format; pass it with --list.");
		process.exitCode = 1;
		return;
	}
	if (yes && listOnly) {
		console.error("✗ --yes and --list contradict each other: --list grants nothing.");
		process.exitCode = 1;
		return;
	}

	const db = getServiceDb();
	try {
		const rows = await listUngrantedMembers(db, orgId);
		if (json) {
			stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
			process.exitCode = rows.length === 0 ? 0 : 2;
			return;
		}
		if (rows.length === 0) {
			console.log(
				`✓ No active member${orgId ? ` of org ${orgId}` : ""} is without a grant. Nothing to do.`,
			);
			process.exitCode = 0;
			return;
		}
		console.log(
			`⚠ ${rows.length} active member${rows.length === 1 ? "" : "s"} hold${rows.length === 1 ? "s" : ""} NO grant — ` +
				"the PDP denies them everything in their org.\n",
		);
		for (const [i, row] of rows.entries()) console.log(`${renderRow(row, i)}\n`);
		if (listOnly) {
			console.log("--list: nothing granted.");
			process.exitCode = 2;
			return;
		}
		console.log(
			"A row here is EITHER never granted (the #3744 gap) OR deliberately revoked — the data cannot tell\n" +
				"them apart. Answer y only for a member you know should have access.",
		);
		const prompt = makeConfirm();
		let outcomes: RowOutcome[];
		try {
			outcomes = await runGrantPass({
				db,
				rows,
				yes,
				confirm: prompt.confirm,
				log: (line) => console.log(line),
			});
		} finally {
			prompt.close();
		}
		const granted = outcomes.filter((o) => o === "granted").length;
		const alreadyDone = outcomes.filter((o) => o === "already-granted").length;
		const remaining = outcomes.length - granted - alreadyDone;
		console.log(
			`\n${granted} granted, ${alreadyDone} already granted since listing, ${remaining} left ungranted.`,
		);
		process.exitCode = remaining === 0 ? 0 : 2;
	} catch (err) {
		console.error("\n✗ grant-ungranted-members failed:\n");
		console.error(err);
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
