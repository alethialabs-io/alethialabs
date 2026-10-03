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
//   - `declared_at` — by `declarePayer` for that org, the last step. `billing` is nulled then.
// "Unfinished" is `declared_at IS NULL`; recovery reads it by `user_id`, so it needs no browser
// record and no search index.
//
// `billing` carries what the customer typed at checkout (address, tax id, the "use as the team's
// address" choice) so a resume from any tab restores it. It is written after the charge — the form
// collects it together with the card — so a tab lost between the charge and that write leaves it
// null, and the recovery view says the tax id must be re-added in billing.
//
// TENANCY. A row is its user's alone: RLS (programmables.sql) is `user_id = app.current_owner`, and
// every server read filters on the actor's own id. No `org_id`: the organization does not exist when
// the row is written, and a row must not become visible to an org's other members once it does.

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";
import { user } from "./auth";
import { organization } from "./organizations";

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
		linked_at: timestamp({ withTimezone: true }),
		declared_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("pending_org_setups_user_idx").on(t.user_id, t.created_at)],
);
