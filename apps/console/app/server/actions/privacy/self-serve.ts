"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privacy rights a person exercises about THEMSELVES, from the console's account settings:
// deleting their account (with a 14-day grace period) and downloading their data.
//
// Separate from `cases.ts` because the two answer different questions about who may act. Every
// handling step there is gated on standing over a case about someone else. The actions here need
// no org permission at all, and must not: the person asking is the person the request is about, and
// the only thing that has to be proved is that they are that person. So:
//
//   · THE SUBJECT IS THE CALLER, AND NOTHING ELSE CAN BE. No action takes a subject argument; the
//     user id and address are read from the Better Auth session on the request.
//   · ONLY A BROWSER SESSION. An actor injected by `runWithActor` — the MCP / API-token path — is
//     refused before the session is read. The maintainer's ruling on #4273 is that an authenticated
//     console SESSION meets the identity bar; a machine credential does not inherit it.
//   · NO CALLER-SUPPLIED CLOCK. Every export of a `"use server"` module can be called from the
//     browser with arguments the browser chooses; a `now` parameter would let it move a deadline.
//
// The deletion itself follows the maintainer's ruling that a self-serve deletion runs by itself once
// the grace period ends (lib/privacy/self-deletion.ts). What stands between this action and an
// irreversible erasure is therefore not a second person but TIME and a CHANNEL the person controls:
// 14 days, a confirmation email with a cancel link, a reminder a week before, and "signing in
// cancels it" — with every session revoked at scheduling so that last one is real.

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { createDataExport } from "@/lib/privacy/export";
import {
	type DeletionBlocker,
	deletionBlockers,
	type ScheduleErasureResult,
	scheduleSelfErasure,
} from "@/lib/privacy/self-deletion";
import { checkRateLimit } from "@/lib/rate-limit";

/** The signed-in subject, from the session — never from an argument. Refuses a machine credential. */
async function sessionSubject(): Promise<{ userId: string; email: string }> {
	if (getInjectedActor()) {
		throw new Error("This can only be done from a signed-in console session.");
	}
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	return { userId: session.user.id, email: session.user.email };
}

/**
 * What would stop the signed-in account being deleted right now, for the account dialog to show
 * BEFORE the person confirms. The same check runs again when they do.
 */
export async function myDeletionBlockers(): Promise<DeletionBlocker[]> {
	const subject = await sessionSubject();
	return deletionBlockers(subject.userId);
}

/**
 * Schedules the deletion of the signed-in account, 14 days out. See the module header for what
 * makes it safe to expose without a second party, and `scheduleSelfErasure` for the steps.
 */
export async function scheduleMyAccountDeletion(): Promise<ScheduleErasureResult> {
	const subject = await sessionSubject();
	return scheduleSelfErasure(subject, new Date());
}

/** What "Download my data" did. */
export type DataExportResult =
	| { outcome: "emailed"; reference: string; expiresAt: Date }
	| { outcome: "rate_limited" };

/** At most this many exports per account per day: each one reads and stores the whole account. */
const EXPORTS_PER_DAY = 3;

/**
 * Builds a JSON export of the signed-in account's data and emails it a download link that works
 * for 72 hours (`EXPORT_LINK_HOURS`), only while signed in to the same account.
 */
export async function requestMyDataExport(): Promise<DataExportResult> {
	const subject = await sessionSubject();
	const limit = await checkRateLimit(`privacy-export:${subject.userId}`, EXPORTS_PER_DAY, 86_400_000);
	if (!limit.ok) return { outcome: "rate_limited" };
	const { reference, expiresAt } = await createDataExport(subject, new Date());
	return { outcome: "emailed", reference, expiresAt };
}
