"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pre-auth gate for the passwordless email flow. On the login page we refuse to
// silently create an account: an unknown address gets a "no account — sign up"
// email instead of a sign-in code. Signup proceeds normally (emailOTP creates the
// user on verify).
//
// action-boundary-ok: this is the PRE-auth surface — there is by definition no actor to
// resolve and nothing to authorize yet, so it cannot satisfy check-action-boundary.mjs. It
// reads `user` through the service client only to answer "does this address exist?".
// Note that the answer IS observable to the client (auth-form.tsx branches to a "no-account"
// step), i.e. this endpoint distinguishes registered from unregistered addresses. That is the
// deliberate cost of refusing to silently create an account on the login path, not an
// oversight — but it does mean this action wants a rate limit before it wants anything else.

import { eq, sql } from "drizzle-orm";
import { getAuthConfig } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { sendNoAccountEmail } from "@/lib/email/auth-email";

export type AuthMode = "login" | "signup";

export interface RequestEmailCodeResult {
	/** "send-otp": caller should send the verification code. "no-account": a
	 *  sign-up email was sent instead — do not send a code. */
	outcome: "send-otp" | "no-account";
}

/** Whether an account exists for the given (already-normalized) email. */
async function emailHasAccount(email: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: user.id })
		.from(user)
		.where(eq(sql`lower(${user.email})`, email))
		.limit(1);
	return Boolean(row);
}

/**
 * Decides whether to proceed with an email sign-in code. On `login`, an address
 * with no account is emailed a "create an account" message and we return
 * `no-account` (no user is created). `signup` always proceeds.
 */
export async function requestEmailCode({
	email,
	mode,
}: {
	email: string;
	mode: AuthMode;
}): Promise<RequestEmailCodeResult> {
	const normalized = email.trim().toLowerCase();

	if (mode === "login" && !(await emailHasAccount(normalized))) {
		await sendNoAccountEmail(
			normalized,
			`${getAuthConfig().baseURL}/signup`,
		).catch((e) => console.error("[auth] no-account email failed:", e));
		return { outcome: "no-account" };
	}

	return { outcome: "send-otp" };
}
