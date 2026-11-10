// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-project lock that keeps a BYO chart out of the project's preview namespaces (#6494).
//
// Two writes each check the other's table: attaching a chart reads the project's preview prefix,
// and saving the preview prefix reads the project's charts. Run side by side, each could read the
// other's OLD value and both commit, storing exactly the overlap both checks exist to refuse. Both
// take this transaction-scoped advisory lock first, in the transaction that does the read AND the
// write, so the second waits for the first to commit and then reads what it wrote. Postgres
// releases it at commit or rollback (the lib/elench/draft-gate.ts pattern).

import { sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";

/**
 * Takes the preview-namespace lock for `projectId` in `tx`, waiting for any other attach or
 * preview-prefix save of the same project to commit first.
 */
export async function lockProjectPreviewNamespaces(tx: Tx, projectId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`byo-preview-ns:${projectId}`}, 0))`);
}
