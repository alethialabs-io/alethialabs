"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import type React from "react";

import { authClient } from "@/lib/auth/client";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@/components/provider-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";
type Step = "providers" | "email" | "code";

const oauthProviders: AuthProvider[] = ["github", "google", "gitlab", "bitbucket"];

export function SignInForm() {
	const [step, setStep] = useState<Step>("providers");
	const [isLoading, setIsLoading] = useState(false);
	const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const searchParams = useSearchParams();
	const router = useRouter();
	const next = searchParams.get("next");

	// OAuth-resume context: Better Auth's mcp() plugin redirects an unauthenticated
	// /api/auth/mcp/authorize request here with the original authorize query appended
	// (client_id, response_type, redirect_uri, …). After we sign the user in, the flow
	// must return to the authorize endpoint to mint the code. Social login resumes
	// automatically (the callback is a full-page nav the plugin's after-hook catches);
	// email-OTP verifies over XHR, so we must navigate back ourselves.
	const isOAuthResume =
		searchParams.has("client_id") && searchParams.has("response_type");
	const resumeUrl = `/api/auth/mcp/authorize?${searchParams.toString()}`;

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setLoadingProvider(provider);
		setError(null);

		// Native providers go through signIn.social; self-hosted GitLab +
		// Bitbucket are wired via the genericOAuth plugin (signIn.oauth2). Both
		// redirect the browser, so control only returns here on error.
		const callbackURL = isOAuthResume ? resumeUrl : (next ?? "/dashboard");
		const { error } =
			provider === "github" || provider === "google"
				? await authClient.signIn.social({ provider, callbackURL })
				: await authClient.signIn.oauth2({ providerId: provider, callbackURL });

		if (error) {
			setError(error.message ?? `Failed to sign in with ${provider}`);
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	const sendCode = async () => {
		const { error } = await authClient.emailOtp.sendVerificationOtp({
			email,
			type: "sign-in",
		});
		if (error) throw new Error(error.message ?? "Failed to send code");
	};

	const handleSendCode = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setLoadingProvider("email");
		setError(null);

		try {
			await sendCode();
			setCode("");
			setStep("code");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to send code");
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	const handleVerify = async (value: string) => {
		if (value.length < 6 || isLoading) return;
		setIsLoading(true);
		setLoadingProvider("verify");
		setError(null);

		const { error } = await authClient.signIn.emailOtp({ email, otp: value });
		if (error) {
			setError("That code didn’t work — try again.");
			setCode("");
			setIsLoading(false);
			setLoadingProvider(null);
			return;
		}
		// Resume the OAuth authorize flow with a full-page navigation (the user now
		// has a session) so the redirect to the connector lands in the browser.
		if (isOAuthResume) {
			window.location.href = resumeUrl;
			return;
		}
		router.push(next ?? "/dashboard");
	};

	const handleResend = async () => {
		setIsLoading(true);
		setError(null);
		try {
			await sendCode();
			setCode("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to resend code");
		} finally {
			setIsLoading(false);
		}
	};

	const errorBanner = error ? (
		<div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded-none text-sm">
			{error}
		</div>
	) : null;

	// Step 3 — enter the 6-digit code.
	if (step === "code") {
		return (
			<div className="space-y-8">
				<div className="space-y-3">
					<p className="vx-eyebrow">Verify</p>
					<h1 className="text-3xl font-extrabold tracking-[-0.03em] text-foreground">
						Enter your code
					</h1>
					<p className="text-[15px] text-muted-foreground">
						We sent a 6-digit code to{" "}
						<span className="font-medium text-foreground">{email}</span>.
					</p>
				</div>

				<div className="space-y-4">
					{errorBanner}

					<InputOTP
						maxLength={6}
						value={code}
						onChange={setCode}
						onComplete={handleVerify}
						pattern={REGEXP_ONLY_DIGITS}
						disabled={isLoading}
						containerClassName="w-full"
						autoFocus
					>
						<InputOTPGroup className="grid w-full grid-cols-6 gap-2">
							{[0, 1, 2, 3, 4, 5].map((i) => (
								<InputOTPSlot key={i} index={i} />
							))}
						</InputOTPGroup>
					</InputOTP>

					<Button
						type="button"
						onClick={() => handleVerify(code)}
						disabled={isLoading || code.length < 6}
						className="w-full h-12 text-sm font-medium"
					>
						{loadingProvider === "verify" ? (
							<>
								<Loader2 className="w-4 h-4 mr-2 animate-spin" />
								Verifying…
							</>
						) : (
							<>
								Continue
								<span aria-hidden="true" className="ml-1">
									→
								</span>
							</>
						)}
					</Button>

					<div className="flex items-center justify-between text-sm">
						<button
							type="button"
							onClick={() => {
								setStep("email");
								setCode("");
								setError(null);
							}}
							className="text-muted-foreground hover:text-foreground transition-colors"
						>
							← Use a different email
						</button>
						<button
							type="button"
							onClick={handleResend}
							disabled={isLoading}
							className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
						>
							Resend code
						</button>
					</div>
				</div>
			</div>
		);
	}

	// Step 2 — enter email.
	if (step === "email") {
		return (
			<div className="space-y-8">
				<div className="space-y-3">
					<p className="vx-eyebrow">Sign in</p>
					<h1 className="text-3xl font-extrabold tracking-[-0.03em] text-foreground">
						Sign in with Email
					</h1>
				</div>

				<form onSubmit={handleSendCode} className="space-y-4">
					{errorBanner}

					<div className="space-y-2">
						<label htmlFor="email" className="vx-eyebrow block">
							Work email
						</label>
						<Input
							id="email"
							type="email"
							placeholder="name@company.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							disabled={isLoading}
							autoFocus
							className="h-12 transition-colors focus-visible:ring-1"
						/>
					</div>

					<Button
						type="submit"
						disabled={isLoading || !email}
						className="w-full h-12 text-sm font-medium"
					>
						{loadingProvider === "email" ? (
							<>
								<Loader2 className="w-4 h-4 mr-2 animate-spin" />
								Sending code…
							</>
						) : (
							<>
								Continue
								<span aria-hidden="true" className="ml-1">
									→
								</span>
							</>
						)}
					</Button>

					<button
						type="button"
						onClick={() => {
							setStep("providers");
							setError(null);
						}}
						className="block mx-auto text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						← Other sign-in options
					</button>
				</form>
			</div>
		);
	}

	// Step 1 — provider list.
	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<p className="vx-eyebrow">Welcome back</p>
				<h1 className="text-3xl font-extrabold tracking-[-0.03em] text-foreground">
					Log in to Alethia
				</h1>
				<p className="text-[15px] text-muted-foreground">
					Configure multi-cloud infrastructure in the browser. Deploy
					from the terminal.
				</p>
			</div>

			<div className="space-y-4">
				{errorBanner}

				<div className="space-y-3">
					{oauthProviders.map((provider) => (
						<Button
							key={provider}
							onClick={() => handleOAuthLogin(provider)}
							disabled={isLoading}
							variant="outline"
							className="relative w-full h-12 justify-center gap-0 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
						>
							<span className="absolute left-4 inline-flex items-center">
								{loadingProvider === provider ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<ProviderIcon
										provider={provider as Provider}
										size={16}
									/>
								)}
							</span>
							Continue with {PROVIDER_LABELS[provider as Provider]}
						</Button>
					))}
				</div>

				<div className="relative py-2">
					<div className="absolute inset-0 flex items-center">
						<Separator className="w-full" />
					</div>
					<div className="relative flex justify-center text-xs uppercase tracking-wider">
						<span className="bg-background px-3 text-muted-foreground">
							or
						</span>
					</div>
				</div>

				<Button
					onClick={() => {
						setStep("email");
						setError(null);
					}}
					disabled={isLoading}
					className="w-full h-12 text-sm font-medium"
				>
					Continue with Email
					<span aria-hidden="true" className="ml-1">
						→
					</span>
				</Button>
			</div>
		</div>
	);
}
