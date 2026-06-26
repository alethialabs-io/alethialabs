"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";

import { authClient } from "@/lib/auth/client";
import { requestEmailCode } from "@/app/server/actions/auth";
import { safeNext } from "@/lib/auth/safe-next";
import { AuthCard } from "@/components/auth/auth-shell";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@repo/ui/input-otp";
import { ArrowRight, KeyRound, Loader2, Lock } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type AuthProvider = "github" | "gitlab" | "bitbucket" | "google";
type Step = "providers" | "email" | "code" | "no-account";

export type AuthMode = "login" | "signup";

const oauthProviders: AuthProvider[] = ["github", "google", "gitlab", "bitbucket"];

/** Per-mode copy. Logic is identical — email-OTP (type "sign-in") creates the
 * user on first verify, so signup and login share the same code paths. */
const COPY: Record<
	AuthMode,
	{
		eyebrow: string;
		title: string;
		sub: string;
		emailEyebrow: string;
		emailTitle: string;
		verifyCta: string;
		note: string;
	}
> = {
	login: {
		eyebrow: "Welcome back",
		title: "Log in to Alethia",
		sub: "Configure multi-cloud infrastructure in the browser. Deploy from the terminal.",
		emailEyebrow: "Sign in",
		emailTitle: "Sign in with email",
		verifyCta: "Continue",
		note: "No passwords. We email you a one-time code to verify it’s you.",
	},
	signup: {
		eyebrow: "Get started",
		title: "Create your account",
		sub: "Configure multi-cloud infrastructure in the browser. Deploy from the terminal. Free to start — no card required.",
		emailEyebrow: "Get started",
		emailTitle: "Sign up with email",
		verifyCta: "Create account",
		note: "No passwords, ever. We email you a one-time code to verify it’s you.",
	},
};

/** Allowlisted banner copy keyed by `?error=` / `?message=`. Arbitrary querystring
 *  text is never rendered (anti-phishing) — unknown codes show no banner. */
const AUTH_MESSAGES: Record<string, string> = {
	oauth: "We couldn’t sign you in with that provider — try again.",
	access_denied: "Sign-in was cancelled.",
	session_expired: "Your session expired — please sign in again.",
	verify_email: "Check your email to finish signing in.",
};

interface AuthFormProps {
	mode: AuthMode;
}

/**
 * Passwordless auth form for both `/login` and `/signup`. Three steps —
 * providers → email → code — keeping the email entry on its own card (Alethia's
 * variant of the design, which inlines it). On success a new account lands in
 * the `/onboarding` flow; an existing sign-in resumes `next` / `/dashboard`.
 */
export function AuthForm({ mode }: AuthFormProps) {
	const copy = COPY[mode];
	const searchParams = useSearchParams();
	const router = useRouter();

	// URL params: prefill the email (and skip the provider grid), validate `next`,
	// and surface an allowlisted banner message.
	const prefillEmail = searchParams.get("email") ?? "";
	const next = safeNext(searchParams.get("next"));

	const [step, setStep] = useState<Step>(prefillEmail ? "email" : "providers");
	const [isLoading, setIsLoading] = useState(false);
	const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
	const [email, setEmail] = useState(prefillEmail);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(() => {
		const code = searchParams.get("error") ?? searchParams.get("message");
		return code ? (AUTH_MESSAGES[code] ?? null) : null;
	});

	// OAuth-resume context: Better Auth's mcp() plugin redirects an unauthenticated
	// /api/auth/mcp/authorize request here with the original authorize query appended
	// (client_id, response_type, redirect_uri, …). After we sign the user in, the flow
	// must return to the authorize endpoint to mint the code. Social login resumes
	// automatically (the callback is a full-page nav the plugin's after-hook catches);
	// email-OTP verifies over XHR, so we must navigate back ourselves.
	const isOAuthResume =
		searchParams.has("client_id") && searchParams.has("response_type");
	const resumeUrl = `/api/auth/mcp/authorize?${searchParams.toString()}`;

	// Where a successful auth lands. New accounts (signup) go to the onboarding
	// wizard; the wizard itself is also gated server-side as a safety net.
	const successDestination = isOAuthResume
		? resumeUrl
		: mode === "signup"
			? (next ?? "/onboarding")
			: (next ?? "/dashboard");

	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setLoadingProvider(provider);
		setError(null);

		// Native providers go through signIn.social; self-hosted GitLab +
		// Bitbucket are wired via the genericOAuth plugin (signIn.oauth2). Both
		// redirect the browser, so control only returns here on error.
		// First-time OAuth users land in onboarding (carrying `next`); existing users
		// resume `next`/dashboard. Provider failures bounce back with ?error=oauth.
		const callbackURL = successDestination;
		const newUserCallbackURL = isOAuthResume
			? resumeUrl
			: next
				? `/onboarding?next=${encodeURIComponent(next)}`
				: "/onboarding";
		const errorCallbackURL = `${mode === "signup" ? "/signup" : "/login"}?error=oauth`;
		const { error } =
			provider === "github" || provider === "google"
				? await authClient.signIn.social({
						provider,
						callbackURL,
						newUserCallbackURL,
						errorCallbackURL,
					})
				: await authClient.signIn.oauth2({
						providerId: provider,
						callbackURL,
						newUserCallbackURL,
						errorCallbackURL,
					});

		if (error) {
			setError(error.message ?? `Failed to sign in with ${provider}`);
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	// `?provider=github` (etc.) auto-starts that OAuth provider once — one-click
	// deep links from marketing/docs. Validated against the allowlist.
	const providerHintFired = useRef(false);
	useEffect(() => {
		if (providerHintFired.current) return;
		const hinted = searchParams.get("provider");
		if (hinted && (oauthProviders as string[]).includes(hinted)) {
			providerHintFired.current = true;
			void handleOAuthLogin(hinted as AuthProvider);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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
			// Gate the login flow: an unknown email is emailed a "sign up" message
			// instead of silently creating an account. Signup always proceeds.
			const { outcome } = await requestEmailCode({ email, mode });
			if (outcome === "no-account") {
				setStep("no-account");
				return;
			}
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
		router.push(successDestination);
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
		<div className="rounded-sm border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
			{error}
		</div>
	) : null;

	// Step 3 — enter the 6-digit code.
	if (step === "code") {
		return (
			<AuthCard>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">Verify</p>
					<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
						Enter your code
					</h1>
					<p className="text-[14.5px] leading-[1.55] text-text-secondary">
						We sent a 6-digit code to{" "}
						<span className="font-medium text-text-primary">{email}</span>.
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
						// Strip spaces/labels so pasting the grouped code from the email
						// ("418 902") or "code: 418902" fills all six boxes.
						pasteTransformer={(pasted) =>
							pasted.replace(/\D/g, "").slice(0, 6)
						}
						disabled={isLoading}
						containerClassName="w-full"
						autoFocus
					>
						<InputOTPGroup className="grid w-full grid-cols-6 gap-[9px]">
							{[0, 1, 2, 3, 4, 5].map((i) => (
								<InputOTPSlot
									key={i}
									index={i}
									className="h-14 w-full rounded-sm border-border-strong bg-surface-sunken font-mono text-[22px] font-medium"
								/>
							))}
						</InputOTPGroup>
					</InputOTP>

					<PrimaryButton
						type="button"
						onClick={() => handleVerify(code)}
						disabled={isLoading || code.length < 6}
						loading={loadingProvider === "verify"}
						loadingLabel="Verifying…"
					>
						{copy.verifyCta}
					</PrimaryButton>

					<div className="flex items-center justify-between text-[13px]">
						<button
							type="button"
							onClick={() => {
								setStep("email");
								setCode("");
								setError(null);
							}}
							className="text-text-tertiary transition-colors hover:text-text-primary"
						>
							← Use a different email
						</button>
						<button
							type="button"
							onClick={handleResend}
							disabled={isLoading}
							className="text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50"
						>
							Resend code
						</button>
					</div>
				</div>
			</AuthCard>
		);
	}

	// No account for this email (login only) — we emailed a sign-up prompt.
	if (step === "no-account") {
		const signupParams = new URLSearchParams();
		if (email) signupParams.set("email", email);
		if (next) signupParams.set("next", next);
		const signupHref = signupParams.toString()
			? `/signup?${signupParams.toString()}`
			: "/signup";
		return (
			<AuthCard>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">No account</p>
					<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
						No account for this email
					</h1>
					<p className="text-[14.5px] leading-[1.55] text-text-secondary">
						We couldn’t find an Alethia account for{" "}
						<span className="font-medium text-text-primary">{email}</span>. We’ve
						emailed you a link to create one.
					</p>
				</div>

				<div className="space-y-4">
					<PrimaryButton
						type="button"
						onClick={() => router.push(signupHref)}
						loadingLabel="Redirecting…"
					>
						Create an account
					</PrimaryButton>

					<button
						type="button"
						onClick={() => {
							setStep("email");
							setError(null);
						}}
						className="mx-auto block text-[13px] text-text-tertiary transition-colors hover:text-text-primary"
					>
						← Use a different email
					</button>
				</div>
			</AuthCard>
		);
	}

	// Step 2 — enter email.
	if (step === "email") {
		return (
			<AuthCard>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">{copy.emailEyebrow}</p>
					<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
						{copy.emailTitle}
					</h1>
				</div>

				<form onSubmit={handleSendCode} className="flex flex-col gap-[9px]">
					{errorBanner}

					<div className="flex flex-col gap-2">
						<label
							htmlFor="email"
							className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-tertiary"
						>
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
							className="h-[46px] rounded-sm border-border-strong bg-surface-sunken text-sm"
						/>
					</div>

					<PrimaryButton
						type="submit"
						disabled={isLoading || !email}
						loading={loadingProvider === "email"}
						loadingLabel="Sending code…"
					>
						Continue with email
					</PrimaryButton>

					<button
						type="button"
						onClick={() => {
							setStep("providers");
							setError(null);
						}}
						className="mx-auto mt-2 block text-[13px] text-text-tertiary transition-colors hover:text-text-primary"
					>
						← Other sign-in options
					</button>
				</form>
			</AuthCard>
		);
	}

	// Step 1 — provider list.
	return (
		<AuthCard>
			<div className="mb-6 flex flex-col gap-2.5">
				<p className="vx-eyebrow">{copy.eyebrow}</p>
				<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
					{copy.title}
				</h1>
				<p className="text-[14.5px] leading-[1.55] text-text-secondary">
					{copy.sub}
				</p>
			</div>

			<div className="space-y-[9px]">
				{errorBanner}

				<div className="grid grid-cols-2 gap-[9px]">
					{oauthProviders.map((provider) => (
						<button
							key={provider}
							type="button"
							onClick={() => handleOAuthLogin(provider)}
							disabled={isLoading}
							className="inline-flex h-[46px] items-center justify-center gap-[9px] rounded-sm border border-border-strong text-[13.5px] font-medium text-text-primary transition-colors hover:border-ring hover:bg-surface-muted disabled:opacity-50"
						>
							{loadingProvider === provider ? (
								<Loader2 className="size-[17px] animate-spin" />
							) : (
								<ProviderIcon provider={provider as Provider} size={17} />
							)}
							{PROVIDER_LABELS[provider as Provider]}
						</button>
					))}
				</div>

				{/* SSO — not wired yet; visible but disabled (coming soon). */}
				<button
					type="button"
					disabled
					title="SSO is coming soon"
					aria-label="Continue with SSO (coming soon)"
					className="inline-flex h-[46px] w-full cursor-not-allowed items-center justify-center gap-[9px] rounded-sm border border-border-strong text-[13.5px] font-medium text-text-primary opacity-55"
				>
					<Lock className="size-4 opacity-80" />
					Continue with SSO
					<span className="ml-1 rounded-full border border-border-strong px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.12em] text-text-tertiary">
						Soon
					</span>
				</button>

				<div className="flex items-center gap-3.5 py-2">
					<span className="h-px flex-1 bg-border" />
					<span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-disabled">
						or
					</span>
					<span className="h-px flex-1 bg-border" />
				</div>

				<button
					type="button"
					onClick={() => {
						setStep("email");
						setError(null);
					}}
					disabled={isLoading}
					className="group inline-flex h-[46px] w-full items-center justify-center gap-[9px] rounded-sm border border-border-strong text-[13.5px] font-medium text-text-primary transition-colors hover:border-ring hover:bg-surface-muted disabled:opacity-50"
				>
					<KeyRound className="size-4 opacity-80" />
					Continue with email
				</button>

				<p className="mt-4 flex items-start gap-2 text-xs leading-[1.55] text-text-tertiary">
					<Lock className="mt-0.5 size-3.5 shrink-0 opacity-70" />
					{copy.note}
				</p>
			</div>
		</AuthCard>
	);
}

/**
 * Ink primary button matching the design's `.btn-primary` (46px, arrow that
 * nudges on hover), with a spinner + label while loading.
 */
function PrimaryButton({
	loading,
	loadingLabel,
	children,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	loading?: boolean;
	loadingLabel: string;
}) {
	return (
		<Button
			{...props}
			className="group h-[46px] w-full rounded-sm bg-ink text-sm font-medium text-ink-foreground hover:bg-ink-hover"
		>
			{loading ? (
				<>
					<Loader2 className="mr-1 size-4 animate-spin" />
					{loadingLabel}
				</>
			) : (
				<>
					{children}
					<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-[3px]" />
				</>
			)}
		</Button>
	);
}
