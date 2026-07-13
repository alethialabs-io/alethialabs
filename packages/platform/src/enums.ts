// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Enums owned by the platform-operator plane. Deliberately does NOT re-declare the console's
// `billing_plan` — this package must stay self-contained (it cannot import console enums, and
// re-declaring one would make drizzle-kit emit a duplicate type). `plan` / `currency` are plain
// text columns, validated against an allow-list in the operator app.

import { pgEnum } from "drizzle-orm/pg-core";

/**
 * How a contract is paid.
 *  - `stripe`   — Stripe Invoicing (collection_method: send_invoice); the console webhook
 *                 activates the plan when the subscription goes live.
 *  - `external` — off-Stripe (bank transfer / Odoo фактура); the operator sets the plan directly.
 */
export const platformCollectionMethod = pgEnum("platform_collection_method", [
	"stripe",
	"external",
]);

export type PlatformCollectionMethod =
	(typeof platformCollectionMethod.enumValues)[number];
