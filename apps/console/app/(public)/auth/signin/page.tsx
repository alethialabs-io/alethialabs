// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SignInForm } from "@/components/forms/signin-form";
import { AlethiaLogo } from "@/components/alethia-logo";
import Link from "next/link";

export default function SignInPage() {
	return (
		<div className="min-h-screen bg-background flex flex-col">
			<div className="absolute top-6 left-6">
				<Link href="/" className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity">
					<AlethiaLogo withText className="h-6 w-auto text-foreground" />
				</Link>
			</div>

			<div className="flex-1 flex flex-col items-center justify-center px-4">
				<div className="w-full max-w-sm space-y-8">
					<div className="text-center">
						<h1 className="text-2xl font-semibold tracking-tight text-foreground">
							Log in to Alethia
						</h1>
					</div>

					<SignInForm />

					<p className="text-center text-xs text-muted-foreground">
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
					</p>
				</div>
			</div>
		</div>
	);
}
