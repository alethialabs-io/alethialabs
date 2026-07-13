// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlatformCollectionMethod } from "./enums";

/** The typed shape of `platform_audit.input` — what the operator asked for, verbatim. */
export interface PlatformAuditInput {
	plan?: string;
	seats?: number | null;
	termMonths?: number | null;
	collectionMethod?: PlatformCollectionMethod;
	amountCents?: number | null;
	currency?: string;
	contractRef?: string | null;
	invoiceRef?: string | null;
	ownerEmail?: string | null;
	orgName?: string | null;
	slug?: string | null;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
}
