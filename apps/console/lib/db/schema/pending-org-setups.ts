// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server-side record of a paid create-a-team setup (#5445).
//
// The create-a-team sheet charges FIRST and creates the organization after. Until this table the
// only references tying a charge to the team it was for lived in the browser (React state, then one
// tab's sessionStorage), and the server's fallback was Stripe's search API — which indexes a new
// subscription about a minute late, so a customer who paid, lost the tab and reopened Create a team
// inside that minute was offered a SECOND purchase.
//
// One row per new-org subscription, INSERTED by `createNewOrgSubscriptionIntent` in the same server
// call that mints the subscription and before the client can pay it. Each post-payment step stamps it:
//   - `created_org_id` — by the organization plugin's create hooks (the org's creator owns this row,
//     checked server-side), or by the resume when it finds the org by its server-stamped marker;
//   - `linked_at` — by `linkSubscriptionToNewOrg`, once the subscription names the org;
//   - `declared_at` — by `declarePayer` for that org, the last step. `billing` is nulled then;
//   - `closed_at` (+ `closed_reason`, and `closed_by` / `closed_note` for an operator) — by the setup
//     closer, the link's refusal, or `scripts/pending-org-setups.ts close-setup` (ADR 0002 §5.7, #5714);
//     and, once slice 5 gives it a caller, by the release of a payment hold on the subscription
//     (`closed_reason = 'hold_released'`, ADR 0002 §4.1, lib/billing/payment-holds/store.ts).
//     A closed setup is finished for good: it never blocks the org's purchases again and is never
//     offered for resume. `refused_reason` records why the link refused, beside it.
// "Unfinished" is `declared_at IS NULL AND closed_at IS NULL`; recovery reads it by `user_id`, so it
// needs no browser record and no search index. "Open" — what blocks the org's own plan purchases
// (ADR 0002 §5.7) — is `linked_at IS NULL AND closed_at IS NULL`.
//
// `billing` carries what the customer typed at checkout (address, tax id, the "use as the team's
// address" choice) so a resume from any tab restores it. It is written BEFORE the card is confirmed (the
// checkout refuses to charge until it is), so a crash after the charge cannot lose it. It is null only for
// a setup recorded before that, or one backfilled from Stripe, and the recovery view then says the tax
// id must be re-added in billing.
//
// TENANCY. A row is its user's alone: RLS (programmables.sql) is `user_id = app.current_owner`, and
// every server read filters on the actor's own id. No `org_id`: the organization does not exist when
// the row is written, and a row must not become visible to an org's other members once it does.

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";
import { user } from "./auth";
import { organization } from "./organizations";

/**
 * Why a setup was closed (ADR 0002 §5.7): its subscription read ended (`ended`), the link refused it
 * beside another live plan (`org_has_plan`), an operator closed it (`operator`), or a payment hold on
 * its subscription was released for any reason but `adopted` (`hold_released`, §4.1 — written by
 * `releaseHold` in lib/billing/payment-holds/store.ts, which has no caller until slice 5).
 */
export type PendingOrgSetupClosedReason = "ended" | "org_has_plan" | "operator" | "hold_released";

/** Why the link refused a setup (ADR 0002 §5.6). S1 writes only `org_has_plan`. */
export type PendingOrgSetupRefusedReason = "ended" | "held" | "org_has_plan";

export const pendingOrgSetups = pgTable(
	"pending_org_setups",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// The Stripe subscription minted for the team (`sub_…`). Unique: one setup per charge.
		subscription_id: text().notNull().unique(),
		customer_id: text().notNull(),
		intended_name: text().notNull(),
		// The slug the customer chose; updated when they pick another after a refusal.
		intended_slug: text().notNull(),
		billing: jsonb().$type<PendingOrgSetupBilling>(),
		created_org_id: uuid().references(() => organization.id, { onDelete: "set null" }),
		// Claimed by an organization create for this setup (`stampNewOrgMetadata`), so two concurrent
		// creates cannot both make an organization for one charge. A create that fails gives its claim
		// back (`runOrgCreate`); one whose request never answered lapses after a minute.
		creating_at: timestamp({ withTimezone: true }),
		linked_at: timestamp({ withTimezone: true }),
		declared_at: timestamp({ withTimezone: true }),
		closed_at: timestamp({ withTimezone: true }),
		closed_reason: text().$type<PendingOrgSetupClosedReason>(),
		// The operator's user id and note, for `closed_reason = 'operator'` only.
		closed_by: text(),
		closed_note: text(),
		refused_reason: text().$type<PendingOrgSetupRefusedReason>(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("pending_org_setups_user_idx").on(t.user_id, t.created_at),
		// The §5.7 guard reads the OPEN setups naming an org by `created_org_id`.
		index("pending_org_setups_open_org_idx")
			.on(t.created_org_id)
			.where(sql`linked_at IS NULL AND closed_at IS NULL`),
	],
);
