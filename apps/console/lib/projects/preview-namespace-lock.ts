// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-project lock that keeps a BYO chart out of the namespaces the project's other writers claim.
//
// Two pairs of writes each check the other's table:
//   - attaching a chart reads the project's preview prefix, and saving the preview prefix reads the
//     project's charts (#6494);
//   - attaching a chart reads the namespace placements on its Fabric, and creating a namespace
//     placement reads the host's chart namespaces (#6575, lib/projects/placement-namespace-claim.ts).
// Run side by side, each could read the other's OLD value and both commit, storing exactly the
// overlap both checks exist to refuse. Every one of those writers takes this lock first, in the
// transaction that does the read AND the write, so the second waits for the first to commit and then
// reads what it wrote. One key for all of them: attachByoChart takes it once and so excludes both
// kinds of writer, and a lock per pair would let the pairs' checks interleave through it.
//
// Why a lock, and not a constraint: the two sides are rows of DIFFERENT tables (project_addons and
// project_environments), matched through a derived value (a placement's namespace falls back to its
// name's slug), so no unique index or exclusion constraint can state the rule; a trigger could, but it
// would need this same lock to see the other table's uncommitted rows.
//
// Transaction-scoped (`pg_advisory_xact_lock`): Postgres releases it at commit or rollback, so it
// never outlives the transaction that took it, and nothing has to release it on an error path. That
// is also what makes it safe under connection pooling — a transaction holds one server connection from
// BEGIN to COMMIT, even through a transaction-mode pooler, whereas a SESSION advisory lock would stay
// on the pooled connection for whichever client draws it next. The checks read under READ COMMITTED,
// where each statement takes a fresh snapshot, so a read issued after the lock is granted sees the
// first writer's committed row (the lib/elench/draft-gate.ts pattern).

import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

/**
 * Takes the namespace lock for `projectId` in `tx`, waiting for any other attach, preview-prefix save
 * or namespace-placement create of the same project to commit first. The key keeps its #6494 text, so
 * a console still running the previous release excludes the same writers during a rollout.
 */
export async function lockProjectPreviewNamespaces(tx: Tx, projectId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`byo-preview-ns:${projectId}`}, 0))`);
}
