// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The purchase lease (ADR 0002 §4.4, Q2, #5741). One row per lease key — today only `user:<userId>`,
// taken by the create-a-team purchase and its link — naming the request that holds it (`holder`, a
// fresh uuid per acquisition) and until when (`expires_at`). Unlike the advisory lock it replaces for
// those two flows, no pooled connection is held while Stripe is called: the row IS the lock.
//
// `holder` is a fencing token. Every write the holder makes to Stripe is preceded by a renewal that
// matches `key` AND `holder` (lib/billing/purchase-lease.ts), so a request that stalled past its lease
// and was taken over by another learns that before it writes. The one exception is the close-out (ADR
// 0002 §4.4 rule 4): after a lost lease, the void and cancel of the subscription that request minted
// and never handed out run unrenewed — they touch nothing another holder made. A renewal narrows the
// window but cannot close it: a request that pauses between a successful renewal and its write still
// writes. That is why only the mint's client secret is gated (rule 3).
//
// TENANCY. Service-role only: RLS is enabled with NO app policy (programmables.sql), so the app role
// can neither read nor write a lease. Nothing a user sees is in it, and a lease a user could write
// would let them block, or steal, another user's purchase.

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const purchaseLeases = pgTable("purchase_leases", {
	// The lease key, e.g. `user:<userId>`. One row per key: the primary key is what makes two takers
	// conflict.
	key: text().primaryKey(),
	// The request that holds it. Replaced on takeover, so a stale holder's renewal matches no row.
	holder: uuid().notNull(),
	// When the lease lapses unless renewed. Another taker may replace the row only after it.
	expires_at: timestamp({ withTimezone: true }).notNull(),
});

export type PurchaseLeaseRow = typeof purchaseLeases.$inferSelect;
