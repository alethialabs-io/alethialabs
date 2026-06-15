"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type React from "react";

import {
	signInWithMagicLink,
	signInWithOAuth,
} from "@/app/(public)/auth/signin/actions";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2, Mail } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";

const oauthProviders: AuthProvider[] = ["github", "google", "gitlab", "bitbucket"];

export function SignInForm() {
	const [isLoading, setIsLoading] = useState(false);
	const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [emailExpanded, setEmailExpanded] = useState(false);
	const [emailSent, setEmailSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const searchParams = useSearchParams();
	const next = searchParams.get("next");

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setLoadingProvider(provider);
		setError(null);

		try {
			await signInWithOAuth(provider, next);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: `Failed to sign in with ${provider}`
			);
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	const handleMagicLinkLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setLoadingProvider("email");
		setError(null);

		try {
			await signInWithMagicLink(email, next);
			setEmailSent(true);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to send magic link"
			);
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	if (emailSent) {
		return (
			<div className="text-center space-y-6">
				<div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto border border-border">
					<Mail className="w-5 h-5 text-foreground" />
				</div>
				<div className="space-y-2">
					<h3 className="text-lg font-medium text-foreground tracking-tight">
						Check your email
					</h3>
					<p className="text-sm text-muted-foreground">
						We sent a magic link to{" "}
						<span className="font-medium text-foreground">{email}</span>
					</p>
					<p className="text-xs text-muted-foreground pt-2">
						Click the link in the email to sign in.
					</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setEmailSent(false);
						setEmail("");
						setEmailExpanded(false);
					}}
					className="text-muted-foreground"
				>
					Back to login
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{error && (
				<div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-lg text-sm">
					{error}
				</div>
			)}

			<div className="space-y-2">
				{oauthProviders.map((provider) => (
					<Button
						key={provider}
						onClick={() => handleOAuthLogin(provider)}
						disabled={isLoading}
						variant="outline"
						className="w-full h-10 font-normal justify-center gap-2 hover:bg-muted/50 transition-colors"
					>
						{loadingProvider === provider ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<ProviderIcon provider={provider as Provider} size={16} />
						)}
						Continue with {PROVIDER_LABELS[provider as Provider]}
					</Button>
				))}
			</div>

			<div className="relative py-2">
				<div className="absolute inset-0 flex items-center">
					<Separator className="w-full" />
				</div>
				<div className="relative flex justify-center text-xs uppercase">
					<span className="bg-background px-2 text-muted-foreground">
						or
					</span>
				</div>
			</div>

			{!emailExpanded ? (
				<Button
					variant="ghost"
					onClick={() => setEmailExpanded(true)}
					disabled={isLoading}
					className="w-full h-10 font-normal text-muted-foreground hover:text-foreground"
				>
					<Mail className="w-4 h-4 mr-2" />
					Continue with Email
				</Button>
			) : (
				<form onSubmit={handleMagicLinkLogin} className="space-y-2">
					<Input
						type="email"
						placeholder="name@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						disabled={isLoading}
						autoFocus
						className="h-10 transition-colors focus-visible:ring-1"
					/>
					<Button
						type="submit"
						disabled={isLoading || !email}
						className="w-full h-10 font-medium"
					>
						{loadingProvider === "email" ? (
							<>
								<Loader2 className="w-4 h-4 mr-2 animate-spin" />
								Sending link…
							</>
						) : (
							"Send Magic Link"
						)}
					</Button>
				</form>
			)}
		</div>
	);
}
