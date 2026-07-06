// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getOwner } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";

interface SignUpPageProps {
	searchParams: Promise<{ next?: string; email?: string }>;
}

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
	const { next, email } = await searchParams;

	// Already signed in → there's nothing to create; honor `next`, else the console.
	// New accounts created here are routed onward to the /onboarding flow.
	if (await getOwner()) redirect(safeNext(next) ?? "/dashboard");

	// Carry intent onto the "sign in" switch link.
	const qs = new URLSearchParams();
	if (next) qs.set("next", next);
	if (email) qs.set("email", email);
	const switchHref = qs.toString() ? `/login?${qs.toString()}` : "/login";

	return (
		<AuthShell
			switchPrompt="Already have an account?"
			switchHref={switchHref}
			switchLabel="Sign in"
		>
			<AuthForm mode="signup" />
		</AuthShell>
	);
}
