// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The email suppression list — addresses we must never send to again because
// they hard-bounced or complained. Written by the SES webhook
// (app/api/webhooks/ses), read by the send guard (lib/email/guard.ts). Global
// (not org-scoped), so it goes through the service connection.

import { eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { emailSuppression } from "@/lib/db/schema";
import type { EmailSuppressionDetail } from "@/types/jsonb.types";

/** Normalize an address for the suppression key (case-insensitive, trimmed). */
function normalize(email: string): string {
	return email.trim().toLowerCase();
}

/** True if the address is on the suppression list (bounced/complained). */
export async function isSuppressed(email: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ email: emailSuppression.email })
		.from(emailSuppression)
		.where(eq(emailSuppression.email, normalize(email)))
		.limit(1);
	return row !== undefined;
}

interface SuppressArgs {
	email: string;
	reason: "bounce" | "complaint";
	source?: string;
	detail?: EmailSuppressionDetail;
}

/**
 * Adds (or refreshes) an address on the suppression list. Idempotent — keyed on
 * the normalized email — so replayed SNS notifications are harmless.
 */
export async function recordSuppression({
	email,
	reason,
	source = "ses-sns",
	detail,
}: SuppressArgs): Promise<void> {
	const key = normalize(email);
	await getServiceDb()
		.insert(emailSuppression)
		.values({ email: key, reason, source, detail })
		.onConflictDoUpdate({
			target: emailSuppression.email,
			set: { reason, source, detail, updated_at: new Date() },
		});
}
