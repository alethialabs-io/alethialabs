// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { SignInForm } from "@/components/forms/signin-form";
import { AlethiaLogo } from "@/components/alethia-logo";
import Link from "next/link";
import { getOwner } from "@/lib/auth/owner";

export default async function SignInPage() {
	// Already signed in (validated — a stale/expired cookie resolves to null and falls
	// through to the form) → skip the form and land in the console.
	if (await getOwner()) redirect("/dashboard");

	return (
		<div className="relative min-h-screen bg-background">
			<div className="absolute top-10 left-10">
				<Link
					href="/"
					className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity"
				>
					<AlethiaLogo withText className="h-6 w-auto text-foreground" />
				</Link>
			</div>

			<div className="min-h-screen flex items-center justify-center px-6">
				<div className="w-full max-w-[360px]">
					<SignInForm />
				</div>
			</div>

			<footer className="absolute bottom-10 left-10 max-w-[360px] pr-6 text-xs text-muted-foreground">
				By continuing, you agree to our{" "}
				<Link
					href="/terms"
					className="underline underline-offset-4 hover:text-foreground transition-colors"
				>
					Terms of Service
				</Link>{" "}
				and{" "}
				<Link
					href="/privacy"
					className="underline underline-offset-4 hover:text-foreground transition-colors"
				>
					Privacy Policy
				</Link>
			</footer>
		</div>
	);
}
