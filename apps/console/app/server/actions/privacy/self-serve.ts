"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A data-subject request the subject opens about THEMSELVES, from the console (#4273).
//
// Separate from `cases.ts` because the two answer different questions about who may act. Every
// handling step there is gated on `org:edit` — somebody administering a case about someone else. The
// action here needs no org permission at all, and must not: the person asking is the person the
// request is about, and the only thing that has to be proved is that they are that person. So the
// check is the reverse of `cases.ts`'s — not "may this actor handle cases?" but "is the subject the
// caller, and nobody else?" — and it lives in its own module so neither gate can be mistaken for
// the other.

import { and, eq, notInArray } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { getServiceDb } from "@/lib/db";
import { privacyCase } from "@/lib/db/schema";
import type { PrivacyCaseState } from "@/lib/db/schema/enums";
import { notifyPrivacyInbox, privacyInbox } from "./inbox";
import { newReference, recordEvent, subjectHash } from "./ledger";
import { PRIVACY_RESPONSE_DAYS } from "./response-period";

/** The states in which a case is finished — decided, or withdrawn. Anything else is still open. */
const CLOSED_STATES: PrivacyCaseState[] = ["fulfilled", "refused", "withdrawn"];

/** What pressing "Request deletion" did. Only `opened` created a case. */
export type ErasureRequestResult =
	| { outcome: "opened"; reference: string }
	| { outcome: "already_open"; reference: string }
	| { outcome: "no_privacy_contact" };

/**
 * Opens an ERASURE request about the signed-in user, from their own console session, and emails it
 * to the privacy inbox.
 *
 * This is the account dialog's "Request deletion" button. It OPENS A CASE and erases nothing. It
 * does not call `fulfilErasure` — a person fulfils the case through the steps in `cases.ts`, and
 * `fulfilErasure` itself has no executor yet (#4854). The copy at the call site says the same.
 *
 * What makes it safe to expose without `org:edit`, each with what enforces it:
 *
 *   · THE SUBJECT IS THE CALLER, AND NOTHING ELSE CAN BE. The action takes no arguments. The
 *     subject's user id and address are read from the Better Auth session on the request, so a
 *     client has no parameter through which to name somebody else. (`openPrivacyCase` takes an
 *     `email`, which is why this does not reuse it.)
 *   · ONLY A BROWSER SESSION. An actor injected by `runWithActor` — the MCP / API-token path — is
 *     refused before the session is read. The maintainer's ruling on #4273 (2026-09-18) is that an
 *     authenticated console SESSION meets the identity bar; it says nothing about tokens, so a
 *     token does not inherit it.
 *   · IDENTITY IS RECORDED AS SESSION-VERIFIED, on the case AND in the ledger. `identityVerifiedAt`
 *     is set at receipt, and an `identity_verified` event states that the check was the session,
 *     so whoever fulfils the case can see it was not the privileged `verifyPrivacyCaseIdentity`
 *     step. A case opened any other way still has to go through that step.
 *   · ONE OPEN REQUEST PER PERSON. A press while an erasure case of theirs is still open returns
 *     that case's reference instead of opening another. It is a read-then-insert, not a
 *     constraint: two requests racing in the same instant can still open two cases. Nothing in the
 *     schema prevents that; the dialog disabling its button while a press is in flight only
 *     narrows it.
 *
 * And the reason a person hears about it (#4875): the case row reaches nobody by itself. So:
 *
 *   · NO INBOX, NO CASE. When `privacyInbox()` has no address — a self-managed deployment with no
 *     `PRIVACY_EMAIL` — nothing is written and the result says so. A case nobody is told about
 *     would start the one-month response clock where nobody can see it.
 *   · THE EMAIL IS PART OF OPENING THE CASE. The insert, both ledger events and the send run in
 *     one transaction, so a send that throws rolls the case back and the user is told to try again.
 *     The reverse gap remains: if the commit fails AFTER the send succeeded, the inbox holds an
 *     email about a reference that was never stored. That is the side a person can notice.
 *   · A case that is already open is NOT emailed again. Every case this action opens was emailed
 *     when it was opened, by the rule above.
 *
 * `organizationId` is null on purpose. The subject is the ACCOUNT — data Alethia controls, not a
 * tenant's records — and the column's doc comment in `lib/db/schema/privacy.ts` is that distinction.
 *
 * It takes no `now`, unlike the steps in `cases.ts`: every export of a `"use server"` module can be
 * called from the browser with arguments the browser chooses, and a caller-supplied clock would let
 * the caller move the statutory deadline.
 */
export async function requestMyErasure(): Promise<ErasureRequestResult> {
	if (getInjectedActor()) {
		throw new Error(
			"An erasure request about yourself can only be opened from a signed-in console session.",
		);
	}
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	const userId = session.user.id;
	const email = session.user.email;
	const now = new Date();
	const db = getServiceDb();

	const [open] = await db
		.select({ reference: privacyCase.reference })
		.from(privacyCase)
		.where(
			and(
				eq(privacyCase.subjectUserId, userId),
				eq(privacyCase.kind, "erasure"),
				notInArray(privacyCase.state, CLOSED_STATES),
			),
		)
		.limit(1);
	if (open) return { outcome: "already_open", reference: open.reference };

	const inbox = privacyInbox();
	if (!inbox) return { outcome: "no_privacy_contact" };

	const reference = newReference();
	const dueAt = new Date(now.getTime() + PRIVACY_RESPONSE_DAYS * 86_400_000);
	await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(privacyCase)
			.values({
				reference,
				kind: "erasure",
				// `in_review`, the state `verifyPrivacyCaseIdentity` moves a case to: identity is
				// settled at receipt here, so the case starts where a verified one stands.
				state: "in_review",
				subjectUserId: userId,
				subjectEmailSha256: subjectHash(email),
				organizationId: null,
				receivedAt: now,
				dueAt,
				identityVerifiedAt: now,
			})
			.returning({ id: privacyCase.id });
		if (!row) throw new Error("Could not open the request.");

		await recordEvent(
			row.id,
			"received",
			{
				summary:
					"Request received (erasure), opened by the subject from the console's account settings " +
					`and emailed to the privacy inbox. Response due within ${PRIVACY_RESPONSE_DAYS} days.`,
			},
			userId,
			tx,
		);
		await recordEvent(
			row.id,
			"identity_verified",
			{
				summary:
					"Identity verified by the subject's own authenticated console session (a self-serve request: " +
					"the requester and the subject are the same signed-in account). Nothing has been erased; the " +
					"request may now be acted on.",
			},
			userId,
			tx,
		);
		await notifyPrivacyInbox(inbox, {
			reference,
			subjectUserId: userId,
			subjectEmail: email,
			receivedAt: now,
			dueAt,
		});
	});
	return { outcome: "opened", reference };
}
