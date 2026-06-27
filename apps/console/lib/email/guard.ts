// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Suppression-aware send. The console's user-facing senders go through this
// instead of @repo/email's sendEmail directly, so a hard-bounced/complained
// address is skipped before we ask SES to send (protecting deliverability). The
// shared @repo/email package stays DB-agnostic — this DB check lives here.

import { sendEmail, type SendEmailArgs } from "@repo/email/send";
import { isSuppressed } from "./suppression";

/**
 * Sends one transactional email unless the recipient is suppressed. When
 * suppressed, it logs and returns without sending. Drop-in for sendEmail at the
 * console's send sites.
 */
export async function sendGuardedEmail(args: SendEmailArgs): Promise<void> {
	if (await isSuppressed(args.to)) {
		console.warn(
			`[email] skipped "${args.subject}" → ${args.to} (suppressed)`,
		);
		return;
	}
	await sendEmail(args);
}
