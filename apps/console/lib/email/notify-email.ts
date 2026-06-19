// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEmailConfig } from "@/lib/config/email";
import { sendEmail } from "@/lib/email/send";
import {
	WelcomeEmail,
	subject as welcomeSubject,
} from "@/emails/welcome";

/**
 * Product/general-stream emails (hello@mail.*) — welcome, notifications. The
 * org-invite email follows the same shape with emails/invite.tsx once orgs ship.
 */

/**
 * Post-signup welcome. Ready to wire into the Better Auth user-create hook
 * (lib/auth/index.ts); a no-op-by-default until called.
 */
export async function sendWelcomeEmail(
	to: string,
	consoleUrl?: string,
): Promise<void> {
	await sendEmail({
		from: getEmailConfig().from.general,
		to,
		subject: welcomeSubject,
		react: WelcomeEmail(consoleUrl ? { consoleUrl } : {}),
	});
}
