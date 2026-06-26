// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getOwner } from "@/lib/auth/owner";

export default async function SignUpPage() {
	// Already signed in → there's nothing to create; send them into the console.
	// New accounts created here are routed onward to the /onboarding flow.
	if (await getOwner()) redirect("/dashboard");

	return (
		<AuthShell
			switchPrompt="Already have an account?"
			switchHref="/login"
			switchLabel="Sign in"
		>
			<AuthForm mode="signup" />
		</AuthShell>
	);
}
