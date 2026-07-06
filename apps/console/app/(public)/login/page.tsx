// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getOwner } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";

interface LoginPageProps {
	searchParams: Promise<{ next?: string; email?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
	const { next, email } = await searchParams;

	// Already signed in (validated — a stale/expired cookie resolves to null and falls
	// through to the form) → honor `next`, else land in the console.
	if (await getOwner()) redirect(safeNext(next) ?? "/dashboard");

	// Carry intent onto the "create an account" switch link.
	const qs = new URLSearchParams();
	if (next) qs.set("next", next);
	if (email) qs.set("email", email);
	const switchHref = qs.toString() ? `/signup?${qs.toString()}` : "/signup";

	return (
		<AuthShell
			switchPrompt="New to Alethia?"
			switchHref={switchHref}
			switchLabel="Create an account"
		>
			<AuthForm mode="login" />
		</AuthShell>
	);
}
