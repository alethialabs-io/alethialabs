"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The signed-in person's own email choices (`/email/preferences`). The address is the session's —
// there is no argument through which to name somebody else's — and only the optional categories
// can be set here; transactional mail has no switch (lib/email/preferences.ts).

import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { setEmailPreference } from "@/lib/email/preferences";

const preferencesSchema = z.object({ product_updates: z.boolean() }).strict();

/** The input of {@link saveMyEmailPreferences}. */
export type EmailPreferencesInput = z.infer<typeof preferencesSchema>;

/** Saves the signed-in account's optional email choices. */
export async function saveMyEmailPreferences(input: EmailPreferencesInput): Promise<{ ok: true }> {
	if (getInjectedActor()) {
		throw new Error("Email preferences are changed from a signed-in console session.");
	}
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");
	const parsed = preferencesSchema.parse(input);
	await setEmailPreference({
		email: session.user.email,
		category: "product_updates",
		enabled: parsed.product_updates,
		source: "preferences_page",
		userId: session.user.id,
	});
	return { ok: true };
}
