// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Performing an erasure, once somebody with standing has decided it should happen.
//
// This is the body `fulfilErasure` (actions/privacy/cases.ts) used to hold inline. It moved here so
// the three callers that may decide an erasure all run the SAME steps, and none of them can be
// reached from a browser by a caller that decides nothing:
//
//   · `fulfilErasure`              a console admin of the organization the case was raised in;
//   · the staff platform route     an allowlisted Alethia staff member, for a controller-level case
//                                  (`app/api/internal/platform/privacy`, behind its bearer secret);
//   · the privacy sweep            a self-serve case whose 14-day grace period has run out, which
//                                  the subject confirmed from their own session and did not cancel
//                                  (`lib/privacy/self-deletion.ts`). The actor is recorded as null:
//                                  an automated step, which is a real answer and not a missing one.
//
// `server-only`, NOT `"use server"`: every export here takes the case and the actor as parameters,
// and an export of a `"use server"` module is a POST endpoint whatever its intended caller.
//
// AFTER THE TRANSACTION, OpenFGA and Stripe are told (`erasure-outside.ts`). Neither can join the
// transaction, so both run only once the erasure has committed.

import "server-only";
import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { type PrivacyCase, privacyCase, privacyErasureTombstone } from "@/lib/db/schema";
import { recordEvent } from "@/app/server/actions/privacy/ledger";
import { eraseOutsidePostgres } from "./erasure-outside";
import {
	applyErasurePlan,
	describeResidency,
	type ErasureResidency,
	type ErasureTableResult,
	findLiveResidency,
	residencyIsClear,
} from "./erasure-executor";
import { buildErasurePlan, planToScope } from "./erasure-plan";

/**
 * What one erasure did. Three outcomes, and only one of them erased anything.
 *
 * A discriminated result rather than a thrown error for the two that did not: a refusal because the
 * subject's org is still running infrastructure is a NORMAL, expected answer that the caller has to
 * render to a person, and an exception is the wrong shape for an answer you were asked to give.
 */
export type ErasureFulfilment =
	| {
			outcome: "erased";
			/** Rows touched per table, in the register's order. */
			tables: ErasureTableResult[];
			rowsErased: number;
			rowsPseudonymized: number;
			/** Tables the register keeps, with a legal basis. Nothing was done to them. */
			tablesRetained: number;
	  }
	| { outcome: "paused_by_legal_hold"; reason: string }
	| {
			outcome: "refused_live_resources";
			/** The refusal in words, safe to show the subject verbatim. */
			message: string;
			residency: ErasureResidency;
	  };

/**
 * Performs the erasure a case orders, and leaves the tombstone behind.
 *
 * The caller has ALREADY established standing over the case; this re-checks only what is a fact
 * about the case itself — that identity was verified and that it is an erasure.
 *
 * Everything that touches rows happens in ONE transaction with the tombstone and the ledger entry
 * that describe it, because a half-applied erasure is worse than none: the subject is told their
 * data is gone while some of it is not, and no record says which half.
 *
 * THE REFUSAL. When an organization only the subject can reach still has projects, undestroyed
 * environments or a connected cloud account, nothing is erased and the case stays open. This is
 * the maintainer's ruling of 2026-09-19: erasing the owner would leave real cloud infrastructure
 * running with no account able to reach it, bill it or tear it down. It is NOT a GDPR art. 12(5)
 * refusal and does not set the case to `refused`.
 *
 * The tombstone is written EVEN under a legal hold, with an empty erasure scope: it records that the
 * request was made and what was held, so a later restore replays a decision that was actually taken.
 * It is NOT written for a live-resources refusal — nothing was erased, so there is nothing to replay.
 */
export async function performErasure(
	c: PrivacyCase,
	actorUserId: string | null,
	now: Date,
): Promise<ErasureFulfilment> {
	if (!c.identityVerifiedAt) {
		throw new Error(
			"Identity is not verified. Nothing is destroyed until we know who asked — an erasure " +
				"performed on an unverified request is itself a data breach.",
		);
	}
	if (c.kind !== "erasure") {
		throw new Error(`Request ${c.reference} is a ${c.kind} request, not an erasure.`);
	}

	const plan = buildErasurePlan({ legalHoldReason: c.legalHoldReason });
	const scope = planToScope(plan, now);
	const db = getServiceDb();

	if (plan.blocked) {
		await db.transaction(async (tx) => {
			await tx.insert(privacyErasureTombstone).values({
				subjectEmailSha256: c.subjectEmailSha256,
				erasedUserId: c.subjectUserId,
				caseReference: c.reference,
				erasedAt: now,
				scope,
			});
			await tx
				.update(privacyCase)
				.set({ scope, state: "in_review", updatedAt: now })
				.where(eq(privacyCase.id, c.id));
			await recordEvent(
				c.id,
				"legal_hold_applied",
				{
					summary: `Erasure paused by a legal hold: ${plan.blockedReason}`,
					counts: { retained: plan.retain.length },
					tables: plan.retain.map((r) => r.table),
				},
				actorUserId,
				tx,
			);
		});
		return { outcome: "paused_by_legal_hold", reason: plan.blockedReason ?? "" };
	}

	// Every rule matches on an identifier. A case opened by someone with no account has none, so
	// running the plan would delete nothing and report success.
	if (!c.subjectUserId) {
		throw new Error(
			`Request ${c.reference} names no account, so no row can be matched to the subject. It has ` +
				"to be fulfilled by hand and recorded on the case; this step would erase nothing and " +
				"report that it had.",
		);
	}
	// A personal organization's id IS the user's id.
	const subject = { userId: c.subjectUserId, personalOrgId: c.subjectUserId };

	const result = await db.transaction(async (tx): Promise<ErasureFulfilment> => {
		const residency = await findLiveResidency(tx, subject);
		if (!residencyIsClear(residency)) {
			const message = describeResidency(residency);
			await tx.update(privacyCase).set({ updatedAt: now }).where(eq(privacyCase.id, c.id));
			await recordEvent(
				c.id,
				"note",
				{
					summary: message,
					counts: {
						projects: residency.projects,
						environments_not_destroyed: residency.environments,
						cloud_connections: residency.cloudConnections,
						sole_owned_organizations: residency.soleOwnedOrganizations,
					},
				},
				actorUserId,
				tx,
			);
			return { outcome: "refused_live_resources", message, residency };
		}

		const execution = await applyErasurePlan(tx, plan, subject);
		await tx.insert(privacyErasureTombstone).values({
			subjectEmailSha256: c.subjectEmailSha256,
			erasedUserId: c.subjectUserId,
			caseReference: c.reference,
			erasedAt: now,
			scope,
		});
		await tx
			.update(privacyCase)
			.set({
				scope,
				state: "fulfilled",
				decidedAt: now,
				decidedByUserId: actorUserId,
				linkTokenSha256: null,
				updatedAt: now,
			})
			.where(eq(privacyCase.id, c.id));
		await recordEvent(
			c.id,
			"erasure_performed",
			{
				summary:
					"Erasure performed. See the scope for what was removed, unlinked and retained, and " +
					"the counts for how many rows each half actually touched.",
				counts: {
					rows_erased: execution.rowsErased,
					rows_pseudonymized: execution.rowsPseudonymized,
					tables_erased: plan.erase.length,
					tables_pseudonymized: plan.pseudonymize.length,
					tables_retained: plan.retain.length,
				},
				tables: execution.tables.map((t) => t.table),
			},
			actorUserId,
			tx,
		);
		return {
			outcome: "erased",
			tables: execution.tables,
			rowsErased: execution.rowsErased,
			rowsPseudonymized: execution.rowsPseudonymized,
			tablesRetained: plan.retain.length,
		};
	});

	if (result.outcome === "erased") {
		await eraseOutsidePostgres(c.id, c.subjectUserId, actorUserId);
	}
	return result;
}
