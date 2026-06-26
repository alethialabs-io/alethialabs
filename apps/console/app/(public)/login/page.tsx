// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getOwner } from "@/lib/auth/owner";

export default async function LoginPage() {
	// Already signed in (validated — a stale/expired cookie resolves to null and falls
	// through to the form) → skip the form and land in the console.
	if (await getOwner()) redirect("/dashboard");

	return (
		<AuthShell
			switchPrompt="New to Alethia?"
			switchHref="/signup"
			switchLabel="Create an account"
		>
			<AuthForm mode="login" />
		</AuthShell>
	);
}
