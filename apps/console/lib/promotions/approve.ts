// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The race-safe approval-claim primitive for environment promotions. Isolated from the "use server"
// action module (app/server/actions/promotions.ts) so it stays a plain, directly-testable helper
// rather than an exported server action. See app/server/actions/promotions.ts (approvePromotion).

import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { promotionApprovals } from "@/lib/db/schema";

/**
 * Outcome of atomically claiming one approval slot: a fresh slot was claimed (`claimed`), this actor
 * had already approved (`already_approved`), or no pending slot remained (`no_slots`). A discriminated
 * union so the caller can preserve its original per-outcome errors.
 */
export type SlotClaim =
	| { outcome: "claimed"; slotId: string }
	| { outcome: "already_approved" }
	| { outcome: "no_slots" };

/**
 * Atomically records one actor's approval on a promotion, race-safe. Runs in a single transaction:
 * it locks the promotion's approval rows (`SELECT … FOR UPDATE`) so concurrent approvers serialize,
 * re-checks the one-approval-per-user rule INSIDE the lock, then claims a still-pending slot with a
 * compare-and-swap `UPDATE … WHERE id = <slot> AND status = 'pending' RETURNING`. The CAS is the
 * correctness guarantee — two racers can never claim the same slot; if a slot was taken out from under
 * this actor the loop advances to the next pending slot and returns `no_slots` once none remain. The
 * `FOR UPDATE` lock makes the loop deterministic (each txn sees the previous one's committed claims)
 * and closes the same-actor double-approve window without an extra round-trip.
 *
 * Fixes the lost-update bug where two approvers reading the same slot set both picked the first
 * pending slot and the second `UPDATE` overwrote the first — collapsing two human approvals onto one.
 */
export async function claimApprovalSlot(
	db: Db,
	promotionId: string,
	actorUserId: string,
	comment: string | undefined,
): Promise<SlotClaim> {
	return db.transaction(async (tx) => {
		// Serialize concurrent approvers on this promotion by locking its approval rows for the txn.
		const locked = await tx
			.select()
			.from(promotionApprovals)
			.where(eq(promotionApprovals.promotion_id, promotionId))
			.for("update");

		// One approval per user — re-checked under the lock so a concurrent duplicate can't slip past.
		if (locked.some((s) => s.decided_by === actorUserId && s.status === "approved"))
			return { outcome: "already_approved" };

		// Claim the first still-pending slot via CAS; advance to the next if one was taken concurrently.
		let pending = locked.filter((s) => s.status === "pending");
		while (pending.length > 0) {
			const target = pending[0];
			const [claimed] = await tx
				.update(promotionApprovals)
				.set({
					status: "approved",
					decided_by: actorUserId,
					comment,
					decided_at: new Date(),
				})
				.where(
					and(
						eq(promotionApprovals.id, target.id),
						eq(promotionApprovals.status, "pending"),
					),
				)
				.returning({ id: promotionApprovals.id });
			if (claimed) return { outcome: "claimed", slotId: claimed.id };
			// The slot was claimed by a concurrent approver — re-read the pending set and try the next.
			pending = await tx
				.select()
				.from(promotionApprovals)
				.where(
					and(
						eq(promotionApprovals.promotion_id, promotionId),
						eq(promotionApprovals.status, "pending"),
					),
				)
				.for("update");
		}
		return { outcome: "no_slots" };
	});
}
