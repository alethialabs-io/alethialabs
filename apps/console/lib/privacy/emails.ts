// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The emails a data subject receives about their own privacy request: the account-deletion
// confirmation, reminder, cancellation and completion, and the export-ready link. All
// transactional — they carry no unsubscribe, because a person cannot opt out of being told their
// account is about to be deleted — and all go through the suppression guard.
//
// Not a `"use server"` module: the browser must never be able to choose a recipient.

import "server-only";
import { getEmailConfig } from "@repo/email/config";
import { formatDate } from "@repo/format";
import {
	type AccountDeletionStage,
	AccountDeletionEmail,
	subject as deletionSubject,
} from "@/emails/account-deletion";
import { DataExportReadyEmail, subject as exportSubject } from "@/emails/data-export-ready";
import { getAuthConfig } from "@/lib/config/auth";
import { sendGuardedEmail } from "@/lib/email/guard";

/** Dates in these emails are written in UTC, so every reader sees the day the sweep uses. */
function dateLabel(at: Date): string {
	return formatDate(at, "date", "UTC");
}

/** The page that cancels a scheduled deletion, carrying the case's link token. */
export function deletionCancelUrl(token: string): string {
	return `${getAuthConfig().baseURL}/account/deletion?t=${encodeURIComponent(token)}`;
}

/** The route that streams an export, carrying the case reference and its link token. */
export function exportDownloadUrl(reference: string, token: string): string {
	return `${getAuthConfig().baseURL}/api/privacy/export/${encodeURIComponent(reference)}?t=${encodeURIComponent(token)}`;
}

/** Sends one stage of the account-deletion correspondence. `at` is when it runs or ran. */
export async function sendAccountDeletionEmail(input: {
	to: string;
	stage: AccountDeletionStage;
	reference: string;
	at: Date;
	cancelToken?: string;
}): Promise<void> {
	const config = getEmailConfig();
	const label = dateLabel(input.at);
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to: input.to,
		subject: deletionSubject(input.stage, label),
		react: AccountDeletionEmail({
			stage: input.stage,
			reference: input.reference,
			dateLabel: label,
			cancelUrl: input.cancelToken ? deletionCancelUrl(input.cancelToken) : undefined,
		}),
		devLog: `account deletion ${input.stage} ${input.reference}`,
	});
}

/** Sends the export-ready email with its download link. */
export async function sendDataExportReadyEmail(input: {
	to: string;
	reference: string;
	token: string;
	expiresAt: Date;
}): Promise<void> {
	const config = getEmailConfig();
	await sendGuardedEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to: input.to,
		subject: exportSubject,
		react: DataExportReadyEmail({
			reference: input.reference,
			downloadUrl: exportDownloadUrl(input.reference, input.token),
			expiresLabel: dateLabel(input.expiresAt),
		}),
		devLog: `data export ${input.reference}`,
	});
}
