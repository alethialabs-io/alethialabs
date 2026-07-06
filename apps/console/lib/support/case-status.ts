// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support-case status machine + display helpers. Lives in a plain (non-"use server")
// module so both the customer actions (app/server/actions/support.ts) and the staff
// actions (support-staff.ts) share one source of truth — a "use server" file may only
// export async functions, so this logic can't live there.

import type { SupportCaseStatus } from "@/lib/db/schema/enums";

/**
 * Legal status transitions. Each key lists the statuses a case may move to from that
 * state (self-transitions included so idempotent updates pass). Enforced by
 * {@link assertTransition}; illegal jumps throw. `pending_customer` is reachable from the
 * active/settled states because a STAFF reply waits on the customer (support-staff.ts).
 */
export const TRANSITIONS: Record<SupportCaseStatus, SupportCaseStatus[]> = {
	open: ["open", "pending_support", "pending_customer", "resolved", "closed"],
	pending_support: ["pending_support", "pending_customer", "resolved", "closed"],
	pending_customer: ["pending_customer", "pending_support", "resolved", "closed"],
	resolved: ["resolved", "open", "pending_support", "pending_customer", "closed"],
	closed: ["closed", "open", "pending_support", "pending_customer"],
};

/** Throws when `to` is not a legal successor of `from`. */
export function assertTransition(
	from: SupportCaseStatus,
	to: SupportCaseStatus,
): void {
	if (!TRANSITIONS[from].includes(to)) {
		throw new Error(`Illegal support-case transition: ${from} → ${to}`);
	}
}

/** The status a case advances to when the CUSTOMER replies (reopens a settled case). */
export function nextStatusAfterCustomerReply(
	current: SupportCaseStatus,
): SupportCaseStatus {
	if (
		current === "resolved" ||
		current === "closed" ||
		current === "pending_customer"
	) {
		return "pending_support";
	}
	return current;
}

/**
 * The status a case advances to when a STAFF agent posts a public reply: the ball is now
 * in the customer's court, so it becomes `pending_customer` (from any non-terminal state,
 * reopening a resolved/closed case).
 */
export function nextStatusAfterStaffReply(
	_current: SupportCaseStatus,
): SupportCaseStatus {
	return "pending_customer";
}

/** `CASE-000123` display form of a case number. */
export function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}
