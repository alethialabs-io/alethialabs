// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `support_cases.contact` value every e2e seed writes (#5662).
//
// The column is jsonb typed by drizzle's `$type<SupportContactPrefs>()` alone, so a raw-SQL seed
// bypasses both the type and the zod schema `submitCase` validates with. Two seeds wrote
// `{ email }` that way; resolving or closing such a case then read `contact.notifyEmail` as
// undefined and the customer email threw inside `safeNotify`, so the gate exercised the button
// while the send path never ran. Building the value here, through `contactPrefsSchema`, makes a
// wrong shape fail at seed time instead of in a swallowed log line.

import type { SupportContactPrefs } from "@repo/support/types";
import { contactPrefsSchema, type ContactPrefsInput } from "@repo/support/validations";

/** The address the seeded cases notify — a reserved `.test` domain, so no real mailbox. */
export const SEED_SUPPORT_NOTIFY_EMAIL = "audit@alethia.test";

/**
 * Return a `support_cases.contact` value in the production shape, parsed through
 * `contactPrefsSchema` so a malformed fixture throws when the seed runs. The channel is `email`
 * (not `in_app`) so resolve/close in the audit really takes the customer email path.
 *
 * The return type is the schema's inferred alias rather than the `SupportContactPrefs` interface
 * because postgres' `sql.json` takes an index-signatured `JSONValue`, which an interface never
 * satisfies; `satisfies SupportContactPrefs` keeps the compile-time tie to the column's type.
 */
export function seedSupportContact(notifyEmail: string = SEED_SUPPORT_NOTIFY_EMAIL): ContactPrefsInput {
	return contactPrefsSchema.parse({ notifyEmail, channel: "email" }) satisfies SupportContactPrefs;
}
