// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getAuthConfig } from "@/lib/config/auth";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";
import {
	InviteEmail,
	subject as inviteSubject,
} from "@/emails/invite";
import {
	WelcomeEmail,
	subject as welcomeSubject,
} from "@/emails/welcome";

/**
 * Product/general-stream emails (hello@mail.*) — welcome, org invitations,
 * notifications.
 */

/** 1–2 letter initials for the email's inviter avatar. */
function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

/**
 * Post-signup welcome. Ready to wire into the Better Auth user-create hook
 * (lib/auth/index.ts); a no-op-by-default until called.
 */
export async function sendWelcomeEmail(
	to: string,
	consoleUrl?: string,
): Promise<void> {
	// Point the CTA at the actual deployment origin (alethialabs.io in prod, the
	// operator's own origin when self-hosted); fall back to the template default.
	const url = consoleUrl ?? getAuthConfig().baseURL;
	await sendEmail({
		from: getEmailConfig().from.general,
		to,
		subject: welcomeSubject,
		react: WelcomeEmail(url ? { consoleUrl: url } : {}),
	});
}

interface InviteArgs {
	to: string;
	inviterName: string;
	workspaceName: string;
	role: string;
	/** The invitation id — carried in the accept link as ?token=. */
	token: string;
	expiresInDays?: number;
}

/**
 * Organization invitation. The accept link points at /invites/accept?token=… on
 * the configured base URL; the accept page resolves the invitation and (after
 * sign-in, if needed) joins the user. Called by the ee/ organization plugin's
 * sendInvitationEmail hook via CoreContext (so ee/ never imports this module).
 */
export async function sendInviteEmail(args: InviteArgs): Promise<void> {
	// Carry the recipient email so the accept page can prefill sign-in / sign-up.
	const acceptUrl = `${getAuthConfig().baseURL}/invites/accept?token=${encodeURIComponent(args.token)}&email=${encodeURIComponent(args.to)}`;
	await sendEmail({
		from: getEmailConfig().from.general,
		to: args.to,
		subject: inviteSubject(args.inviterName),
		react: InviteEmail({
			inviterName: args.inviterName,
			inviterInitials: initials(args.inviterName),
			workspaceName: args.workspaceName,
			role: args.role,
			acceptUrl,
			expiresInDays: args.expiresInDays ?? 7,
		}),
	});
}
