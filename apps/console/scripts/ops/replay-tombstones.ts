// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Replays erasure tombstones against a RESTORED database, before it serves (REL-L7, #6908).
//
// # Why this exists
//
// A backup taken before an erasure reinstates the erased rows when it is restored, and they look
// exactly like rows that were never erased (`lib/db/schema/privacy.ts`, "THE RESTORE PROBLEM").
// `privacy_erasure_tombstone` is what outlives the erasure; a restore is not complete until every
// tombstone has been re-applied. `scripts/ops/restore-drill.sh` runs this between the migration and
// the first request, and refuses to start the console until `--check` reports zero.
//
// # What it does, and what it deliberately does not
//
// It re-runs the SAME executor an erasure ran (`applyErasurePlan`), with the SAME register
// (`ERASURE_RULES`), restricted to the tables the tombstone's recorded scope names — so a replay
// can never do more than the erasure did, and never something different from what the register
// says today. A table in the scope that the register no longer has a rule for is a throw, not a
// skip: skipping would leave a reinstated row and report it handled.
//
// It does NOT re-check live residency (`findLiveResidency`). That check guarded the ORIGINAL
// erasure; a restore from before that erasure can show projects the subject has since torn down,
// and refusing on them would leave the erased data in place, which is the one outcome this exists
// to prevent.
//
// It reads `privacy_erasure_tombstone` directly, over the service connection, for every tenant at
// once. `unreplayedTombstones()` is the caller-scoped slice and is the wrong source here — its own
// comment says the restore runbook must not read it.
//
// # Usage (inside the console-migrate image, as restore-drill.sh does)
//
//	NODE_PATH=scripts/e2e/node-stubs ./node_modules/.bin/tsx scripts/ops/replay-tombstones.ts --apply
//	NODE_PATH=scripts/e2e/node-stubs ./node_modules/.bin/tsx scripts/ops/replay-tombstones.ts --check
//
// `--apply` replays every tombstone whose `replayed_at` is null, oldest first, one transaction per
// tombstone, and stamps `replayed_at`. Re-running it is safe: a replayed erasure finds nothing left.
// `--check` prints how many are still unreplayed and exits 1 unless that is zero.
// Output is one JSON line of counts — never a subject hash, user id or case reference.
//
// The NODE_PATH stubs are the ones `scripts/e2e/finalize-deployment.ts` uses, for the same reason:
// the transitive `import "server-only"` only resolves inside Next's bundler.

import { asc, count, eq, isNull } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { privacyErasureTombstone } from "@/lib/db/schema";
import { applyErasurePlan } from "@/lib/privacy/erasure-executor";
import { ERASURE_RULES, type ErasurePlan, type ErasureRule } from "@/lib/privacy/erasure-plan";
import type { PrivacyCaseScope } from "@/types/jsonb.types";

/** The rules a tombstone's scope names, in register order. Throws on a table the register lacks. */
function rulesForScope(scope: PrivacyCaseScope): Pick<ErasurePlan, "erase" | "pseudonymize"> {
	/** The register's rules of one disposition for the named tables; throws on a table with none. */
	const pick = (tables: string[], disposition: ErasureRule["disposition"]): ErasureRule[] => {
		const wanted = new Set(tables);
		const rules = ERASURE_RULES.filter((r) => r.disposition === disposition && wanted.has(r.table));
		for (const table of wanted) {
			if (!rules.some((r) => r.table === table)) {
				throw new Error(
					`A tombstone's scope ${disposition}s ${table}, and the erasure register has no ` +
						`${disposition} rule for it any more. Decide by hand what the replay must do there; ` +
						"replaying the rest and skipping it would leave a reinstated row reported as handled.",
				);
			}
		}
		return rules;
	};
	return {
		erase: pick(scope.erased, "erase"),
		pseudonymize: pick(
			scope.pseudonymized.map((p) => p.table),
			"pseudonymize",
		),
	};
}

/** Counts the tombstones not yet replayed against this database. */
async function unreplayedCount(): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(privacyErasureTombstone)
		.where(isNull(privacyErasureTombstone.replayedAt));
	return row?.n ?? 0;
}

/** Replays every unreplayed tombstone, oldest first, one transaction each. */
async function apply(): Promise<void> {
	const db = getServiceDb();
	const pending = await db
		.select()
		.from(privacyErasureTombstone)
		.where(isNull(privacyErasureTombstone.replayedAt))
		.orderBy(asc(privacyErasureTombstone.erasedAt), asc(privacyErasureTombstone.id));

	let replayed = 0;
	let nothingToReplay = 0;
	let rowsErased = 0;
	let rowsPseudonymized = 0;

	for (const t of pending) {
		const rules = rulesForScope(t.scope);
		await db.transaction(async (tx) => {
			if (rules.erase.length + rules.pseudonymize.length === 0) {
				// A legal-hold tombstone: the original run destroyed nothing, so neither does this.
				nothingToReplay += 1;
			} else {
				if (!t.erasedUserId) {
					throw new Error(
						`Tombstone ${t.id} names tables to erase but no user id to match them on. It has to be ` +
							"replayed by hand; this step would erase nothing and report that it had.",
					);
				}
				const plan: ErasurePlan = {
					...rules,
					retain: [],
					vendors: [],
					blocked: false,
					blockedReason: null,
				};
				const result = await applyErasurePlan(tx, plan, {
					userId: t.erasedUserId,
					personalOrgId: t.erasedUserId,
				});
				rowsErased += result.rowsErased;
				rowsPseudonymized += result.rowsPseudonymized;
			}
			await tx
				.update(privacyErasureTombstone)
				.set({ replayedAt: new Date() })
				.where(eq(privacyErasureTombstone.id, t.id));
		});
		replayed += 1;
	}

	const remaining = await unreplayedCount();
	console.log(
		JSON.stringify({
			mode: "apply",
			tombstones: pending.length,
			replayed,
			nothingToReplay,
			rowsErased,
			rowsPseudonymized,
			remaining,
		}),
	);
	if (remaining !== 0) process.exitCode = 1;
}

/** Prints the unreplayed count; exit 1 unless it is zero. */
async function check(): Promise<void> {
	const remaining = await unreplayedCount();
	console.log(JSON.stringify({ mode: "check", remaining }));
	if (remaining !== 0) process.exitCode = 1;
}

/** Parses the one flag and runs it. */
async function main(): Promise<void> {
	if (!process.env.ALETHIA_DATABASE_URL) {
		throw new Error("ALETHIA_DATABASE_URL is unset (the restored database, service role)");
	}
	const mode = process.argv[2];
	if (mode === "--apply") return apply();
	if (mode === "--check") return check();
	throw new Error("usage: replay-tombstones.ts --apply | --check");
}

main()
	// postgres-js keeps the event loop alive via its pool; exit explicitly once the work is done.
	.then(() => process.exit(process.exitCode ?? 0))
	.catch((err: unknown) => {
		console.error(
			`replay-tombstones failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
		);
		process.exit(1);
	});
