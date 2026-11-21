// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What `/invites/accept` knows about an invitation, and what it says when an action on one fails.
//
// Both answers are VALUES, never thrown, and every sentence is this module's own. The auth server's
// `message` is written for logs ("Invitation not found!"), not for this screen, so the page branches
// on the error `code` the organization plugin answers with and maps each to copy that says what to
// do. A code this module does not know reads as the generic failure.

import { z } from "zod";
import { authClient } from "@/lib/auth/client";

/** The organization plugin's error codes this route branches on. */
const NOT_RECIPIENT = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";
const VERIFY_TO_VIEW = "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION";
const VERIFY_TO_ANSWER = "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION";
const MEMBER_LIMIT = "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED";
/** The codes for an invitation that no longer exists to answer (expired, used, withdrawn, org gone). */
const GONE: readonly string[] = [
	"INVITATION_NOT_FOUND",
	"ORGANIZATION_NOT_FOUND",
	"INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION",
];

/** The fields of a read invitation the card renders. */
const invitationSchema = z.object({
	organizationName: z.string().min(1),
	organizationSlug: z.string().min(1),
	inviterEmail: z.string().min(1),
	role: z.string().min(1),
});

/** The outcome of reading an invitation for the signed-in viewer. */
export type InvitationRead =
	| { kind: "ready"; invitation: z.infer<typeof invitationSchema> }
	/** Addressed to another account than the one signed in. */
	| { kind: "not-recipient" }
	/** Expired, used, withdrawn, or its organization or inviter is gone. */
	| { kind: "unavailable" }
	/** The organization requires a verified address before showing it. */
	| { kind: "verify-email" }
	/** A network or server failure: the invitation is unchanged and a retry may work. */
	| { kind: "failed" };

/** The shape of an error the auth client answers with, as far as this module reads it. */
interface AuthClientError {
	code?: string;
	status?: number;
}

/** Narrows the error to the read outcome it means. */
function readFailure(error: AuthClientError): InvitationRead {
	if (error.code === NOT_RECIPIENT) return { kind: "not-recipient" };
	if (error.code === VERIFY_TO_VIEW) return { kind: "verify-email" };
	if ((error.code && GONE.includes(error.code)) || error.status === 400) return { kind: "unavailable" };
	return { kind: "failed" };
}

/**
 * Reads invitation `id` for the signed-in viewer. The server decides whether it is theirs, so the
 * mismatch answer is authoritative and the `email` in the link is only ever used to NAME the
 * invited address.
 */
export async function readInvitation(id: string): Promise<InvitationRead> {
	try {
		const { data, error } = await authClient.organization.getInvitation({ query: { id } });
		if (error) return readFailure(error);
		const parsed = invitationSchema.safeParse(data);
		return parsed.success ? { kind: "ready", invitation: parsed.data } : { kind: "failed" };
	} catch {
		return { kind: "failed" };
	}
}

/**
 * Runs an accept or decline and answers the sentence to show when it failed, or null when it
 * worked. A call that throws (the connection dropped) is the generic failure.
 */
export async function invitationActionFailure(
	action: "accept" | "decline",
	run: () => Promise<{ error: AuthClientError | null }>,
): Promise<string | null> {
	let error: AuthClientError | null;
	try {
		({ error } = await run());
	} catch {
		error = { status: 0 };
	}
	if (!error) return null;
	if (error.code === NOT_RECIPIENT) {
		return "This invitation was sent to a different address than the one you’re signed in with.";
	}
	if (error.code && GONE.includes(error.code)) {
		return "This invitation is no longer valid — it has expired, been used, or been withdrawn.";
	}
	if (error.code === VERIFY_TO_ANSWER) {
		return "Verify your email address before answering this invitation.";
	}
	if (error.code === MEMBER_LIMIT) {
		return "This organization has no free seats. Ask the person who invited you to make room.";
	}
	return action === "accept"
		? "We couldn’t accept the invitation. Try again."
		: "We couldn’t decline the invitation. Try again.";
}
