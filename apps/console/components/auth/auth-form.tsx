"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { lookup } from "@/lib/typed-object";
import type React from "react";

import { authClient } from "@/lib/auth/client";
import {
	CHALLENGE_REFUSAL_CODES,
	CHALLENGE_REFUSED_MESSAGE,
	SIGNUP_CHALLENGE_ACTION,
	SIGNUP_DISPOSABLE_EMAIL,
	SIGNUP_NETWORK_LIMIT,
	SIGNUP_REFUSAL_MESSAGES,
	isSignupRefusalCode,
} from "@/lib/auth/signup-guard/codes";
import { requestEmailCode } from "@/app/server/actions/auth";
import { track } from "@/lib/analytics/track";
import { safeNext } from "@/lib/auth/safe-next";
import { useAuthPrefsStore, type AuthMethod } from "@/lib/stores/use-auth-prefs-store";
import { arrayIncludes } from "@/lib/type-guards";
import { AuthCard } from "@/components/auth/auth-shell";
import {
	OAUTH_PROVIDERS,
	arrangeSignInMethods,
	type AuthProvider,
} from "@/components/auth/sign-in-methods";
import { ProviderIcon, PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@repo/ui/input-otp";
import { ArrowRight, KeyRound, Lock } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { env } from "next-runtime-env";
import { useHydrated } from "@repo/ui/use-hydrated";
import { isOrgSlug } from "@repo/org-slug";
import { hardNavigate } from "@/components/shell/hard-navigate";

type Step = "providers" | "email" | "code" | "no-account";

export type AuthMode = "login" | "signup";

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
	}
> = {
	login: {
		eyebrow: "Welcome back",
		title: "Sign in to Alethia",
		sub: "Your clusters are where you left them.",
		emailEyebrow: "Sign in",
		emailTitle: "Sign in with email",
		verifyCta: "Continue",
	},
	signup: {
		eyebrow: "Get started",
		title: "Create your account",
		sub: "Your first cluster, on any cloud.",
		emailEyebrow: "Get started",
		emailTitle: "Sign up with email",
		verifyCta: "Create account",
	},
};

/**
 * The query parameter that records "the code step is open" (R6 A-25). With `email` beside it, a
 * refresh on "Enter your code" reopens that step for that address instead of dropping the person
 * back on the provider grid with a code in their inbox and nowhere to type it.
 */
export const CODE_STEP_PARAM = "step";

/**
 * The query string of `current` with the code step recorded for `email`, or cleared when `email` is
 * null. Every other parameter (`next`, an invitation's token, …) is kept as it was.
 */
export function codeStepSearch(current: string, email: string | null): string {
	const params = new URLSearchParams(current);
	if (email === null) {
		params.delete(CODE_STEP_PARAM);
	} else {
		params.set("email", email);
		params.set(CODE_STEP_PARAM, "code");
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

/**
 * Writes the code step into the address bar without a navigation: `history.replaceState`, which the
 * App Router observes, so nothing re-fetches and no history entry is added.
 */
function recordCodeStep(email: string | null): void {
	const search = codeStepSearch(window.location.search, email);
	window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
}

/** Resend cooldown (seconds) — escalates with each resend (30s → 1m → 2m → 5m);
 *  the last value repeats. Guards against spamming the code-send endpoint. */
const RESEND_COOLDOWNS = [30, 60, 120, 300];

/** Formats a remaining-seconds count as `m:ss` (e.g. 29 → "0:29"). */
function fmtCountdown(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return `${m}:${s}`;
}

/**
 * Pulls a 6-digit code out of whatever was pasted — "418 902", "code: 418902", a whole
 * line lifted out of the email. Shared by the OTP field's own paste handling and the
 * step-level listener, so there is one definition of what a pasted code looks like.
 */
function digitsOnly(pasted: string): string {
	return pasted.replace(/\D/g, "").slice(0, 6);
}

/** Shown when the sign-in code email could not be sent (or the request failed outright). */
const SEND_FAILED_MESSAGE = "We couldn’t send the code — try again.";

/** Shown when the auth server is rate-limiting this browser. */
const RATE_LIMITED_MESSAGE = "Too many attempts — wait a minute, then try again.";

/**
 * What the form says when a code is refused, keyed by the email-OTP plugin's error code. Each says
 * what to do next: a wrong code can be corrected, but an expired or exhausted one is gone, and
 * retyping it can never work — those point at Resend. `clear` empties the field only where the
 * code in it is dead; a mistyped digit is easier to fix in place.
 */
const VERIFY_FAILURES: Record<string, { message: string; clear: boolean }> = {
	INVALID_OTP: { message: "That code didn’t work — try again.", clear: false },
	OTP_EXPIRED: {
		message: "That code has expired. Use Resend code to get a new one.",
		clear: true,
	},
	TOO_MANY_ATTEMPTS: {
		message: "Too many wrong tries — that code no longer works. Use Resend code to get a new one.",
		clear: true,
	},
};

/** The refusal for any other code the verify call answers with: never the server's own text. */
const VERIFY_FAILED = { message: "That code didn’t work — try again.", clear: false };

/** The email step's one field. `type="email"` and `required` stay on the input as well. */
const emailSchema = z.object({
	email: z.string().trim().email("Enter a valid email address."),
});
type EmailValues = z.infer<typeof emailSchema>;

/** The code step's one field: exactly six digits. */
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
type CodeValues = z.infer<typeof codeSchema>;

/**
 * The organization name as typed into the SSO entry. A pasted sign-in URL
 * (`https://…/sso/acme`) is reduced to its last segment, because that URL is what the SSO
 * settings page hands out and what people will have to hand.
 */
export function ssoSlugFrom(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	const marker = trimmed.lastIndexOf("/sso/");
	const tail = marker >= 0 ? trimmed.slice(marker + "/sso/".length) : trimmed;
	return tail.split(/[/?#]/)[0] ?? "";
}

/** The SSO entry's one field: something that reduces to a well-formed organization slug. */
const ssoSchema = z.object({
	slug: z
		.string()
		.refine((raw) => ssoSlugFrom(raw).length > 0, "Enter your organization’s name in Alethia.")
		.refine(
			(raw) => isOrgSlug(ssoSlugFrom(raw)),
			"Use the name from your organization’s sign-in link — lowercase letters, numbers and hyphens.",
		),
});
type SsoValues = z.infer<typeof ssoSchema>;

/** The banner for a provider hand-off that never left the page, naming the provider by its label. */
function oauthFailedMessage(provider: AuthProvider): string {
	return `We couldn’t start sign-in with ${lookup(PROVIDER_LABELS, provider)} — try again.`;
}

/**
 * Where a NEW account goes after its first sign-in. Every new account passes through
 * `/onboarding` carrying `next`, by email and by provider alike — except an invitation: an invitee
 * is joining an organization that already exists, so they go straight to the invitation, and
 * accepting it is what completes their setup.
 */
export function newAccountDestination(next: string | null): string {
	if (next === null) return "/onboarding";
	if (next === "/invites/accept" || next.startsWith("/invites/accept?")) return next;
	return `/onboarding?next=${encodeURIComponent(next)}`;
}

/** Allowlisted banner copy keyed by `?error=` / `?message=`. Arbitrary querystring
 *  text is never rendered (anti-phishing) — unknown codes show no banner. */
const AUTH_MESSAGES: Record<string, string> = {
	oauth: "We couldn’t sign you in with that provider — try again.",
	access_denied: "Sign-in was cancelled.",
	session_expired: "Your session expired — please sign in again.",
	verify_email: "Check your email to finish signing in.",
	// The four reasons app/(public)/sso/[slug]/route.ts can bounce back with. They
	// arrive under `sso_error`, and none of them had an entry here — so every SP-
	// initiated SSO failure redirected to a login page that looked completely normal
	// and said nothing at all. An allowlist that silently drops a code its own
	// codebase emits is not an allowlist, it is a dropped error.
	unknown_org: "We don’t recognize that organization.",
	no_provider: "Single sign-on isn’t set up for that organization.",
	sso_unavailable: "Single sign-on is temporarily unavailable — try again shortly.",
	sign_in_unavailable: "We couldn’t start single sign-on — try again shortly.",
	// The sign-up controls (lib/auth/signup-guard). An OAuth sign-up they refuse comes back here
	// as `?error=<code>`; the copy is the server's own, from the one shared module.
	[SIGNUP_DISPOSABLE_EMAIL]: SIGNUP_REFUSAL_MESSAGES[SIGNUP_DISPOSABLE_EMAIL],
	[SIGNUP_NETWORK_LIMIT]: SIGNUP_REFUSAL_MESSAGES[SIGNUP_NETWORK_LIMIT],
};

/**
 * The banner for a `?error=` / `?message=` / `?sso_error=` redirect, or null.
 *
 * Every `error` value is read, last first, because Better Auth APPENDS its own `error` to the
 * errorCallbackURL it was given, which already carries `?error=oauth`. A refused OAuth sign-up
 * therefore arrives as `?error=oauth&error=SIGNUP_NETWORK_LIMIT`, and reading only the first value
 * would show the generic provider message instead of the reason. Only allowlisted codes render;
 * `error_description` never does.
 */
function bannerFor(searchParams: URLSearchParams): string | null {
	const codes = [
		...searchParams.getAll("error").reverse(),
		searchParams.get("message"),
		searchParams.get("sso_error"),
	];
	for (const code of codes) {
		if (code && Object.hasOwn(AUTH_MESSAGES, code)) return AUTH_MESSAGES[code] ?? null;
	}
	return null;
}

/** Turnstile's explicit-render script. Loaded only when the sign-up challenge is configured. */
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The slice of the Turnstile browser API the form uses. */
interface TurnstileApi {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string;
			action: string;
			appearance: "always" | "execute" | "interaction-only";
			callback: (token: string) => void;
			"expired-callback": () => void;
			"error-callback": () => void;
		},
	) => string | undefined;
	remove: (widgetId: string) => void;
}

/** Narrows an unknown value to the Turnstile API by the two methods the form calls. */
function isTurnstileApi(v: unknown): v is TurnstileApi {
	return (
		typeof v === "object" &&
		v !== null &&
		"render" in v &&
		typeof v.render === "function" &&
		"remove" in v &&
		typeof v.remove === "function"
	);
}

/** The Turnstile API the script installed on `window`, or null before it has loaded. */
function turnstileApi(): TurnstileApi | null {
	const api: unknown = Reflect.get(window, "turnstile");
	return isTurnstileApi(api) ? api : null;
}

let turnstileLoad: Promise<TurnstileApi> | null = null;

/** Loads the Turnstile script once per page and resolves with its API. */
function loadTurnstile(): Promise<TurnstileApi> {
	const ready = turnstileApi();
	if (ready) return Promise.resolve(ready);
	turnstileLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = TURNSTILE_SCRIPT_SRC;
		script.async = true;
		script.onload = () => {
			const api = turnstileApi();
			if (api) resolve(api);
			else reject(new Error("challenge unavailable"));
		};
		script.onerror = () => {
			turnstileLoad = null;
			reject(new Error("challenge unavailable"));
		};
		document.head.appendChild(script);
	});
	return turnstileLoad;
}

/**
 * The sign-up challenge (REL-L10). Renders a Turnstile widget and reports its token — or null when
 * the token expires or the widget fails. A token is single-use: the parent remounts this (a new
 * `key`) after every send so the next send gets a fresh one. `interaction-only` keeps it invisible
 * unless Cloudflare decides the visitor must click.
 */
function SignupChallenge({
	siteKey,
	onToken,
	onUnavailable,
}: {
	siteKey: string;
	onToken: (token: string | null) => void;
	onUnavailable: () => void;
}) {
	const el = useRef<HTMLDivElement>(null);
	// The callbacks change identity every render; the widget must not be re-rendered for that.
	const handlers = useRef({ onToken, onUnavailable });
	useEffect(() => {
		handlers.current = { onToken, onUnavailable };
	});

	useEffect(() => {
		let cancelled = false;
		let widgetId: string | undefined;
		loadTurnstile()
			.then((api) => {
				if (cancelled || !el.current) return;
				widgetId = api.render(el.current, {
					sitekey: siteKey,
					action: SIGNUP_CHALLENGE_ACTION,
					appearance: "interaction-only",
					callback: (token) => handlers.current.onToken(token),
					"expired-callback": () => handlers.current.onToken(null),
					"error-callback": () => handlers.current.onToken(null),
				});
			})
			.catch(() => {
				if (!cancelled) handlers.current.onUnavailable();
			});
		return () => {
			cancelled = true;
			if (widgetId) turnstileApi()?.remove(widgetId);
		};
	}, [siteKey]);

	return <div ref={el} className="flex justify-center empty:hidden" />;
}

/** Shown when the challenge script could not load (an extension or a network blocking it). */
const CHALLENGE_UNAVAILABLE_MESSAGE =
	"The security check couldn’t load. Allow challenges.cloudflare.com, or sign in with a provider above.";

/**
 * One OAuth provider tile — spinner while its own sign-in is in flight.
 *
 * `compact` is the three-up row. Each of its tiles is a third of the card, which is about 60px
 * wide at a 320px viewport: no label fits beside the icon there, so below 400px the label goes
 * screen-reader-only and the tile is its icon. `min-w-0` + `truncate` is the backstop for the
 * widths in between — the Button is `whitespace-nowrap`, so without them a long label does not
 * wrap or shrink, it paints past the border.
 */
function ProviderButton({
	provider,
	isLoading,
	loadingProvider,
	compact = false,
	onSelect,
}: {
	provider: AuthProvider;
	isLoading: boolean;
	loadingProvider: string | null;
	/** Rendered in the three-up row rather than on its own full-width line. */
	compact?: boolean;
	onSelect: (provider: AuthProvider) => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			onClick={() => onSelect(provider)}
			disabled={isLoading}
			pending={loadingProvider === provider}
			// The three-up tiles take tighter padding and gap: at the card's desktop width a tile is
			// ~105px, and the default 16px sides left "Bitbucket" ~47px of the ~60px it needs.
			className={
				compact
					? "h-[46px] w-full min-w-0 gap-[6px] border-border-strong px-2 text-ui-md hover:border-ring hover:bg-surface-muted"
					: "h-[46px] w-full min-w-0 gap-[9px] border-border-strong text-ui-md hover:border-ring hover:bg-surface-muted"
			}
		>
			<ProviderIcon provider={provider} size={17} decorative mono={false} />
			<span className={compact ? "min-w-0 truncate max-[399px]:sr-only" : "min-w-0 truncate"}>
				{lookup(PROVIDER_LABELS, provider)}
			</span>
		</Button>
	);
}

/**
 * The remembered method, leading the provider step as the full-width primary button.
 *
 * The "Last used" badge used to sit INLINE after the label, inside a Button that is
 * `whitespace-nowrap`. On the three-up row a tile is ~100px wide at the card's full width, and
 * icon + "Bitbucket" + badge needed roughly twice that — nowrap forbids wrapping and nothing let
 * the content shrink, so the badge painted out past the tile's border. The badge now sits on the
 * button's top edge, out of the label's flow, so the two cannot collide at any width; the label
 * drops "Continue with" below 400px and truncates as a last resort.
 *
 * The badge is aria-hidden and the BUTTON names itself — "<Method> (last used)". Letting the
 * badge text join the name by itself announced "GitHubLast used": the accessible name
 * concatenates descendant text and knows nothing about spacing.
 */
function LeadMethodButton({
	method,
	isLoading,
	loadingProvider,
	onSelect,
}: {
	method: AuthMethod;
	isLoading: boolean;
	loadingProvider: string | null;
	onSelect: (method: AuthMethod) => void;
}) {
	const name = method === "email" ? "email" : lookup(PROVIDER_LABELS, method);
	const spinning = loadingProvider === method;
	return (
		<Button
			type="button"
			onClick={() => onSelect(method)}
			disabled={isLoading}
			pending={spinning}
			variant="outline"
			aria-label={`Continue with ${name} (last used)`}
			className="relative h-[46px] w-full min-w-0 gap-[9px] border-ring bg-surface-muted text-ui-md hover:bg-surface-muted"
		>
			{method === "email" ? (
				<KeyRound className="size-4 opacity-80" />
			) : (
				<ProviderIcon provider={method} size={17} decorative mono={false} />
			)}
			<span className="min-w-0 truncate">
				{/* "Continue with Bitbucket" does not fit a 320px viewport's card; the
				    provider's name alone does. Email keeps the phrase — it fits. */}
				<span className={method === "email" ? undefined : "max-[399px]:hidden"}>
					Continue with{" "}
				</span>
				{name}
			</span>
			<span
				aria-hidden="true"
				className="vx-badge-mono pointer-events-none absolute -top-[7px] right-3 border bg-background px-1.5 py-px leading-none"
			>
				Last used
			</span>
		</Button>
	);
}

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

	// What the browser remembers from last time. Read AFTER mount, never during render:
	// this form is server-prerendered and then hydrated, so a first client render that
	// consulted localStorage would not match the server's HTML. The DOM is identical on the
	// first client render and the remembered marks appear on the second.
	const rememberedMethod = useAuthPrefsStore((s) => s.lastMethod);
	const rememberedEmail = useAuthPrefsStore((s) => s.lastEmail);
	const remember = useAuthPrefsStore((s) => s.remember);
	const forget = useAuthPrefsStore((s) => s.forget);
	const mounted = useHydrated();
	/** Wraps the OTP field, so the window paste listener can tell "already handled" from "not". */
	const otpRef = useRef<HTMLDivElement>(null);
	const lastMethod = mounted ? rememberedMethod : null;

	// `?provider=github` (etc.) auto-starts that OAuth provider once — one-click deep links from
	// marketing/docs. Validated against the allowlist, and read once: the form opens already
	// "signing in with" it, and the effect below starts the hand-off.
	const [hintedProvider] = useState<AuthProvider | null>(() => {
		const hinted = searchParams.get("provider");
		return hinted && arrayIncludes(OAUTH_PROVIDERS, hinted) ? hinted : null;
	});

	// A recorded code step (`?email=…&step=code`, written when the code was sent) reopens on the code
	// field, so a refresh there keeps the person where they were (A-25).
	const [step, setStep] = useState<Step>(
		prefillEmail && searchParams.get(CODE_STEP_PARAM) === "code"
			? "code"
			: prefillEmail
				? "email"
				: "providers",
	);
	const [isLoading, setIsLoading] = useState(hintedProvider !== null);
	const [loadingProvider, setLoadingProvider] = useState<string | null>(hintedProvider);

	// The two golden-path fields are react-hook-form + zod (A-18): the address on the email step
	// and the six digits on the code step. `email` / `code` below are their watched values, for
	// the copy and the disabled states that read them.
	const emailForm = useForm<EmailValues>({
		resolver: zodResolver(emailSchema),
		defaultValues: { email: prefillEmail },
	});
	const email = useWatch({ control: emailForm.control, name: "email" });
	const codeForm = useForm<CodeValues>({
		resolver: zodResolver(codeSchema),
		defaultValues: { code: "" },
	});
	const code = useWatch({ control: codeForm.control, name: "code" });
	/** Replaces the code field's value (a paste, a reset). */
	const setCode = (value: string) => codeForm.setValue("code", value);

	// Pre-fill the remembered address once, after mount, and only when the field is
	// still empty — a `?email=` param, or anything already typed, wins.
	//
	// The VALUE only. `step` is initialised from `prefillEmail`, and feeding remembered
	// state into that would move a returning user off the provider tiles and onto the
	// email form a beat after the page settled, which is a worse experience than the one
	// this is meant to improve. The field is not on screen until the email step opens (a
	// prefilled address opens on it, and then this never writes), so the write is not seen.
	const emailSeeded = useRef(false);
	useEffect(() => {
		if (!mounted || emailSeeded.current) return;
		emailSeeded.current = true;
		if (!prefillEmail && rememberedEmail && !emailForm.getValues("email")) {
			emailForm.setValue("email", rememberedEmail);
		}
	}, [mounted, prefillEmail, rememberedEmail, emailForm]);

	// SSO entry (A-13): a slug field revealed under the provider tiles, which hands off to the
	// SP-initiated route `/sso/<slug>` — the same address the SSO settings page gives out.
	const [ssoOpen, setSsoOpen] = useState(false);
	const ssoForm = useForm<SsoValues>({
		resolver: zodResolver(ssoSchema),
		defaultValues: { slug: "" },
	});
	const [error, setError] = useState<string | null>(() => {
		// An auto-started provider clears any banner, as a click on its tile does.
		if (hintedProvider !== null) return null;
		return bannerFor(new URLSearchParams(searchParams.toString()));
	});

	// The sign-up challenge on code issuance (REL-L10): on only when the deployment configured a
	// Turnstile site key (lib/config/auth.ts `getSignupChallengeConfig`, which also needs the
	// server's secret). `challengeRound` remounts the widget after each send, because a token is
	// single-use; `challengeToken` is the current round's token, null until the widget yields one.
	const challengeSiteKey = env("NEXT_PUBLIC_TURNSTILE_SITE_KEY")?.trim() || null;
	const [challengeToken, setChallengeToken] = useState<string | null>(null);
	const [challengeRound, setChallengeRound] = useState(0);
	const challengePending = challengeSiteKey !== null && challengeToken === null;
	/** Spends the current token: clears it and remounts the widget for a fresh one. */
	const nextChallengeRound = () => {
		setChallengeToken(null);
		setChallengeRound((r) => r + 1);
	};
	const challenge =
		challengeSiteKey !== null ? (
			<SignupChallenge
				key={challengeRound}
				siteKey={challengeSiteKey}
				onToken={setChallengeToken}
				onUnavailable={() => setError(CHALLENGE_UNAVAILABLE_MESSAGE)}
			/>
		) : null;

	// Resend guard: number of resends so far + seconds left before resend re-enables.
	const [resendCount, setResendCount] = useState(0);
	const [cooldown, setCooldown] = useState(0);

	// Tick the cooldown down once per second while it's active.
	useEffect(() => {
		if (cooldown <= 0) return;
		const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [cooldown]);

	/** Arms the cooldown for the given (cumulative) resend count, escalating the wait. */
	const armCooldown = (count: number) =>
		setCooldown(RESEND_COOLDOWNS[Math.min(count, RESEND_COOLDOWNS.length - 1)]);

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
			? newAccountDestination(next)
			: (next ?? "/dashboard");

	/**
	 * The OAuth hand-off itself, for a form already marked as signing in with `provider` (by a
	 * click, or by the `?provider=` hint's initial state). Every exit that does not reach the
	 * provider rolls the form back.
	 */
	const startOAuth = async (provider: AuthProvider) => {
		// Native providers go through signIn.social; self-hosted GitLab +
		// Bitbucket are wired via the genericOAuth plugin (signIn.oauth2). Both
		// redirect the browser, so control only returns here on error.
		// First-time OAuth users land in onboarding (carrying `next`); existing users
		// resume `next`/dashboard. Provider failures bounce back with ?error=oauth.
		const callbackURL = successDestination;
		const newUserCallbackURL = isOAuthResume ? resumeUrl : newAccountDestination(next);
		const errorCallbackURL = `${mode === "signup" ? "/signup" : "/login"}?error=oauth`;
		// 1.7 promoted the generic providers (gitlab, bitbucket) to first-class social
		// providers and deleted `signIn.oauth2`, so the github/google split is gone —
		// one call now covers every provider.
		// Remember the choice before handing off. OAuth leaves the page, so there is no
		// "after" to run here — this is the last moment this code is alive.
		//
		// That makes the write optimistic, so EVERY path that does not reach the provider
		// has to roll it back: the error branch below, and the no-url/no-error branch at
		// the end. Both call forget(). Only the `window.location.href` hand-off keeps the
		// mark. This comment used to assert that a failed attempt never leaves a mark
		// while the third branch quietly did — the invariant is only worth stating if
		// every exit actually holds it.
		remember(provider);

		const { data, error } = await authClient.signIn.social({
			provider,
			callbackURL,
			newUserCallbackURL,
			errorCallbackURL,
		});

		if (error) {
			// The hand-off never happened — don't leave "Last used" on a tile that failed. The
			// copy is the form's own, naming the provider by its label: the auth server's message
			// is not written for this screen, and the raw id ("github") is not a name.
			forget();
			setError(oauthFailedMessage(provider));
			setIsLoading(false);
			setLoadingProvider(null);
			return;
		}
		// Better Auth's redirect plugin normally navigates on `{ url, redirect: true }`,
		// but don't depend on it — redirect explicitly so the button never hangs on the
		// spinner. If there's neither a url nor an error, surface it instead of spinning.
		if (data && "url" in data && typeof data.url === "string" && data.url) {
			window.location.href = data.url;
			return;
		}
		// Third exit, and the one the rollback originally missed: no url AND no error, so
		// the hand-off never happened either. Without this the tile keeps its "Last used"
		// mark and the form goes on recommending the provider that most recently failed.
		forget();
		setError(oauthFailedMessage(provider));
		setIsLoading(false);
		setLoadingProvider(null);
	};

	/** A provider tile's click: marks the form as signing in with it, then hands off. */
	const handleOAuthLogin = async (provider: AuthProvider) => {
		setIsLoading(true);
		setLoadingProvider(provider);
		setError(null);
		await startOAuth(provider);
	};

	// Start the `?provider=` hint's hand-off once. The form's initial state already says it is
	// signing in with that provider, so nothing is set here before the request.
	const providerHintFired = useRef(false);
	useEffect(() => {
		if (providerHintFired.current || hintedProvider === null) return;
		providerHintFired.current = true;
		void startOAuth(hintedProvider);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/**
	 * Asks the server to email a sign-in code. Answers the sentence to show when it was not sent,
	 * or null when it was — so neither caller advances to (or resets) the code step on a send that
	 * never happened. Every sentence is the form's own: a provider failure answers
	 * SIGN_IN_CODE_SEND_FAILED (lib/auth/index.ts), a refused challenge or sign-up has shared copy,
	 * and anything else — including a call that throws — is the generic "couldn't send". The auth
	 * server's `message` is never shown.
	 */
	const sendCode = async (): Promise<string | null> => {
		const type: "sign-in" = "sign-in";
		const body = { email: emailForm.getValues("email").trim(), type };
		// With the challenge on, the token rides in the header Better Auth's captcha plugin reads,
		// and is spent whatever the answer — the next send needs a new one.
		const token = challengeToken;
		if (challengeSiteKey !== null) nextChallengeRound();
		try {
			const { error } = token
				? await authClient.emailOtp.sendVerificationOtp(body, {
						headers: { "x-captcha-response": token },
					})
				: await authClient.emailOtp.sendVerificationOtp(body);
			if (!error) return null;
			if (error.code && CHALLENGE_REFUSAL_CODES.includes(error.code)) {
				return CHALLENGE_REFUSED_MESSAGE;
			}
			if (isSignupRefusalCode(error.code)) return SIGNUP_REFUSAL_MESSAGES[error.code];
			if (error.status === 429) return RATE_LIMITED_MESSAGE;
			return SEND_FAILED_MESSAGE;
		} catch {
			return SEND_FAILED_MESSAGE;
		}
	};

	/** The email step's submit, after its schema passed: the account check, then the send. */
	const handleSendCode = async (values: EmailValues) => {
		if (challengePending) return;
		setIsLoading(true);
		setLoadingProvider("email");
		setError(null);

		try {
			// Gate the login flow: an unknown email is emailed a "sign up" message
			// instead of silently creating an account. Signup always proceeds.
			//
			// A server action that THROWS reaches the browser as the framework's masked
			// production sentence, so a throw here is "couldn't send", never its message.
			let outcome: "send-otp" | "no-account";
			try {
				({ outcome } = await requestEmailCode({ email: values.email, mode }));
			} catch {
				setError(SEND_FAILED_MESSAGE);
				return;
			}
			if (outcome === "no-account") {
				setStep("no-account");
				return;
			}
			const failure = await sendCode();
			if (failure) {
				setError(failure);
				return;
			}
			track("signup_email_requested", { mode });
			setCode("");
			setStep("code");
			// Not on an OAuth resume: there the whole query string is the authorize request, handed
			// back to the authorize endpoint verbatim, and must not carry this form's own keys.
			if (!isOAuthResume) recordCodeStep(values.email.trim());
			setResendCount(0);
			armCooldown(0);
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	const handleVerify = async (value: string) => {
		if (!codeSchema.safeParse({ code: value }).success || isLoading) return;
		setIsLoading(true);
		setLoadingProvider("verify");
		setError(null);

		// A call that throws (the connection dropped) is a failed verify like any other, with no
		// code to branch on — it must not leave the form stuck on "Verifying…".
		let error: { code?: string; status?: number } | null;
		try {
			({ error } = await authClient.signIn.emailOtp({
				email: emailForm.getValues("email").trim(),
				otp: value,
			}));
		} catch {
			error = { status: 0 };
		}
		if (error) {
			// A refused NEW account (lib/auth/signup-guard) is not a wrong code: say why, from the
			// shared copy. An expired or exhausted code points at Resend, because retyping it can
			// never work; anything else is still "that code didn't work".
			const failure: { message: string; clear: boolean } = isSignupRefusalCode(error.code)
				? { message: SIGNUP_REFUSAL_MESSAGES[error.code], clear: true }
				: error.status === 429
					? { message: RATE_LIMITED_MESSAGE, clear: false }
					: (lookup(VERIFY_FAILURES, error.code ?? "") ?? VERIFY_FAILED);
			setError(failure.message);
			if (failure.clear) setCode("");
			setIsLoading(false);
			setLoadingProvider(null);
			return;
		}
		track("login_succeeded", { method: "otp" });
		// Verified, so this address is worth keeping — see the note on `lastEmail`.
		remember("email", email);
		// Resume the OAuth authorize flow with a full-page navigation (the user now
		// has a session) so the redirect to the connector lands in the browser.
		if (isOAuthResume) {
			window.location.href = resumeUrl;
			return;
		}
		router.push(successDestination);
	};

	// Paste anywhere on the code step. The OTP field handles its own paste, but only
	// while one of its slots holds focus — and the natural gesture after switching to the
	// mail app and back is Cmd-V against a page nobody has clicked. This catches that.
	//
	// It defers to the field whenever the paste is already headed there (checked via the
	// event target, not activeElement, so a slot that is focused but not the target still
	// resolves correctly), so a code is never applied twice.
	useEffect(() => {
		if (step !== "code") return;
		const onPaste = (e: ClipboardEvent) => {
			const target = e.target;
			if (target instanceof Node && otpRef.current?.contains(target)) return;
			const pasted = digitsOnly(e.clipboardData?.getData("text") ?? "");
			if (pasted.length < 6) return;
			e.preventDefault();
			setCode(pasted);
			void handleVerify(pasted);
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [step, email, isLoading]);

	const handleResend = async () => {
		if (cooldown > 0 || isLoading || challengePending) return;
		setIsLoading(true);
		setLoadingProvider("resend");
		setError(null);
		try {
			const failure = await sendCode();
			if (failure) {
				setError(failure);
				return;
			}
			setCode("");
			const next = resendCount + 1;
			setResendCount(next);
			armCooldown(next);
		} finally {
			setIsLoading(false);
			setLoadingProvider(null);
		}
	};

	/** Back to the email step, clearing the half-typed code and any stale error. */
	const backToEmail = () => {
		setStep("email");
		if (!isOAuthResume) recordCodeStep(null);
		setCode("");
		setError(null);
	};

	const emailError = emailForm.formState.errors.email?.message;
	const ssoError = ssoForm.formState.errors.slug?.message;

	/** The SSO entry's submit: hands off to the organization's SP-initiated sign-in route. */
	const handleSsoContinue = (values: SsoValues) => {
		setIsLoading(true);
		setLoadingProvider("sso");
		setError(null);
		const slug = ssoSlugFrom(values.slug);
		const query = next ? `?next=${encodeURIComponent(next)}` : "";
		// A full document load: `/sso/<slug>` is a route handler that redirects to the identity
		// provider, which a client-side push cannot follow.
		hardNavigate(`/sso/${encodeURIComponent(slug)}${query}`);
	};

	// `role="alert"`: on a failed verification the text swaps in place (and, for a dead
	// code, the OTP field clears underneath it). A sighted user sees both; without a live
	// region a screen-reader user got neither.
	const errorBanner = error ? (
		<div
			role="alert"
			className="border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
		>
			{error}
		</div>
	) : null;

	// Step 3 — enter the 6-digit code.
	if (step === "code") {
		return (
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">Verify</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						Enter your code
					</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">
						We sent a 6-digit code to{" "}
						<span className="font-medium text-text-primary">{email}</span>.{" "}
						<button
							type="button"
							onClick={backToEmail}
							className="text-text-tertiary underline underline-offset-2 transition-colors hover:text-text-primary"
						>
							Change
						</button>
					</p>
				</div>

				<div className="space-y-4">
					{errorBanner}

					{/* The wrapper carries the ref the window paste listener tests against —
					    InputOTP renders a hidden field plus the slots, so there is no single
					    node of its own to point at. */}
					<div ref={otpRef}>
						<Controller
							control={codeForm.control}
							name="code"
							render={({ field }) => (
								<InputOTP
									maxLength={6}
									value={field.value}
									onChange={field.onChange}
									onComplete={handleVerify}
									pattern={REGEXP_ONLY_DIGITS}
									// Strip spaces/labels so pasting the grouped code from the email
									// ("418 902") or "code: 418902" fills all six boxes.
									pasteTransformer={digitsOnly}
									disabled={isLoading}
									aria-label="6-digit sign-in code"
									// Never let session replay capture the login code (OTP digits render as text, not
									// a masked <input>, so maskAllInputs alone wouldn't hide them).
									data-ph-mask
									containerClassName="w-full"
									autoFocus
								>
									<InputOTPGroup className="grid w-full grid-cols-6 gap-[9px]">
										{[0, 1, 2, 3, 4, 5].map((i) => (
											<InputOTPSlot
												key={i}
												index={i}
												className="h-14 w-full border-border-strong bg-surface-sunken font-mono text-[22px] font-medium"
											/>
										))}
									</InputOTPGroup>
								</InputOTP>
							)}
						/>
					</div>

					<PrimaryButton
						type="button"
						onClick={() => handleVerify(code)}
						disabled={isLoading || code.length < 6}
						loading={loadingProvider === "verify"}
						loadingLabel="Verifying…"
					>
						{copy.verifyCta}
					</PrimaryButton>

					{challenge}

					<div className="flex items-center justify-between text-ui-md">
						<button
							type="button"
							onClick={backToEmail}
							className="text-text-tertiary transition-colors hover:text-text-primary"
						>
							← Use a different email
						</button>
						<button
							type="button"
							onClick={handleResend}
							disabled={isLoading || cooldown > 0 || challengePending}
							className="text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
						>
							{cooldown > 0
								? `Resend in ${fmtCountdown(cooldown)}`
								: loadingProvider === "resend"
									? "Sending…"
									: "Resend code"}
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
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">No account</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						No account for this email
					</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">
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
						className="mx-auto block text-ui-md text-text-tertiary transition-colors hover:text-text-primary"
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
			<AuthCard key={step}>
				<div className="mb-6 flex flex-col gap-2.5">
					<p className="vx-eyebrow">{copy.emailEyebrow}</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						{copy.emailTitle}
					</h1>
				</div>

				<form
					onSubmit={emailForm.handleSubmit(handleSendCode)}
					className="flex flex-col gap-[9px]"
				>
					{errorBanner}

					<div className="flex flex-col gap-2">
						<label
							htmlFor="email"
							className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary"
						>
							Work email
						</label>
						{/* The clamp is on this wrapper, not on the Input: a replaced
						    element renders no ::before, so an <input> cannot draw its own
						    corner marks. --field makes the wrapper answer to the focus of
						    the input inside it. */}
						<div className="vx-clamp vx-clamp--tight vx-clamp--field">
							<Input
								id="email"
								type="email"
								placeholder="name@company.com"
								autoComplete="email"
								{...emailForm.register("email")}
								required
								// Read-only rather than disabled while sending: a disabled field
								// drops focus, and the value is react-hook-form's either way.
								readOnly={isLoading}
								aria-invalid={emailError ? true : undefined}
								aria-describedby={emailError ? "email-error" : undefined}
								autoFocus
								className="h-[46px] w-full border-border-strong bg-surface-sunken text-sm"
							/>
						</div>
						{emailError ? (
							<p id="email-error" className="text-ui-sm text-destructive">
								{emailError}
							</p>
						) : null}
					</div>

					{challenge}

					<PrimaryButton
						type="submit"
						disabled={isLoading || !email || challengePending}
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
						className="mx-auto mt-2 block text-ui-md text-text-tertiary transition-colors hover:text-text-primary"
					>
						← Other sign-in options
					</button>
				</form>
			</AuthCard>
		);
	}

	// Step 1 — provider list, arranged around the remembered method (sign-in-methods.ts).
	const layout = arrangeSignInMethods(lastMethod);
	/** Opens the email step from either email button. */
	const openEmailStep = () => {
		setStep("email");
		setError(null);
	};
	const orDivider = (
		<div className="flex items-center gap-3.5 py-2">
			<span className="h-px flex-1 bg-border" />
			<span className="font-mono text-ui-2xs uppercase tracking-[0.18em] text-text-disabled">
				or
			</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
	return (
		<AuthCard key={step}>
			<div className="mb-6 flex flex-col gap-2.5">
				<p className="vx-eyebrow">{copy.eyebrow}</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
					{copy.title}
				</h1>
				<p className="text-ui-lg leading-[1.55] text-text-secondary">
					{copy.sub}
				</p>
			</div>

			<div className="space-y-[9px]">
				{errorBanner}

				{layout.lead !== null ? (
					// The "Last used" badge straddles the lead's top border; mt-2 keeps it off
					// whatever sits above (the heading block or an error banner).
					<div className="mt-2">
					<LeadMethodButton
						method={layout.lead}
						isLoading={isLoading}
						loadingProvider={loadingProvider}
						onSelect={(method) => {
							if (method === "email") openEmailStep();
							else void handleOAuthLogin(method);
						}}
					/>
					</div>
				) : null}

				{layout.lead === "email" ? orDivider : null}

				{/* A flat 2x2 of four equal tiles said "we have no idea which one you
				    want". For a Kubernetes control plane it is overwhelmingly GitHub, so
				    on a fresh browser it leads at full width and the other three share a
				    row. A remembered provider takes the lead instead (above), and the
				    three it leaves share the row. The e2e specs select by accessible
				    name, so nothing here is position-dependent. */}
				{layout.wide !== null ? (
					<ProviderButton
						provider={layout.wide}
						isLoading={isLoading}
						loadingProvider={loadingProvider}
						onSelect={handleOAuthLogin}
					/>
				) : null}
				<div className="grid grid-cols-3 gap-[9px]">
					{layout.grid.map((provider) => (
						<ProviderButton
							key={provider}
							provider={provider}
							isLoading={isLoading}
							loadingProvider={loadingProvider}
							compact
							onSelect={handleOAuthLogin}
						/>
					))}
				</div>

				{layout.emailBelow ? (
					<>
						{orDivider}
						<Button
							type="button"
							variant="outline"
							onClick={openEmailStep}
							disabled={isLoading}
							className="group h-[46px] w-full gap-[9px] border-border-strong text-ui-md hover:border-ring hover:bg-surface-muted"
						>
							<KeyRound className="size-4 opacity-80" />
							Continue with email
						</Button>
					</>
				) : null}

				{/* SSO (A-13). It was a disabled "Soon" tile while SP-initiated sign-in already
				    shipped at /sso/<slug>; it now opens a field for the organization's name and
				    hands off to that route, whose refusals come back as `?sso_error=` and render in
				    the banner above. It follows the live providers rather than leading them: most
				    people arriving here sign in with one of those.

				    The raw <button>s elsewhere in this file are inline TEXT affordances
				    — "← Other sign-in options", "Resend", the back-links. They are
				    deliberately not `Button`: they have no box for the clamp to grip,
				    and the `link` variant would underline them. */}
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						setSsoOpen((open) => !open);
						setError(null);
					}}
					disabled={isLoading}
					aria-expanded={ssoOpen}
					aria-controls="sso-entry"
					className="h-[46px] w-full gap-[9px] border-border-strong text-ui-md hover:border-ring hover:bg-surface-muted"
				>
					<Lock className="size-4 opacity-80" />
					Continue with SSO
				</Button>

				{ssoOpen ? (
					<form
						id="sso-entry"
						onSubmit={ssoForm.handleSubmit(handleSsoContinue)}
						className="flex flex-col gap-2 pt-1"
						noValidate
					>
						<label
							htmlFor="sso-slug"
							className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary"
						>
							Organization
						</label>
						<div className="flex gap-[9px]">
							<div className="vx-clamp vx-clamp--tight vx-clamp--field flex-1">
								<Input
									id="sso-slug"
									placeholder="acme"
									autoComplete="organization"
									autoCapitalize="none"
									spellCheck={false}
									{...ssoForm.register("slug")}
									readOnly={isLoading}
									aria-invalid={ssoError ? true : undefined}
									aria-describedby={ssoError ? "sso-slug-error" : "sso-slug-help"}
									autoFocus
									className="h-[46px] w-full border-border-strong bg-surface-sunken text-sm"
								/>
							</div>
							<Button
								type="submit"
								disabled={isLoading}
								pending={loadingProvider === "sso"}
								className="h-[46px] px-4 text-sm"
							>
								Continue
							</Button>
						</div>
						{ssoError ? (
							<p id="sso-slug-error" className="text-ui-sm text-destructive">
								{ssoError}
							</p>
						) : (
							<p id="sso-slug-help" className="text-ui-sm text-text-tertiary">
								The name in your organization’s sign-in link — /sso/<span className="font-mono">name</span>.
								You can paste the whole link.
							</p>
						)}
					</form>
				) : null}

			</div>
		</AuthCard>
	);
}

/**
 * The primary action, 46px with an arrow that nudges on hover.
 *
 * It used to pass `bg-ink text-ink-foreground hover:bg-ink-hover`, which is the
 * `default` variant restated by hand — so the variant was overridden with a copy of
 * itself and drifted from it for free. Only the size and the group hook are local now.
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
			pending={loading ?? false}
			className="group relative h-[46px] w-full text-sm"
		>
			{loading ? (
				loadingLabel
			) : (
				<>
					{children}
					<ArrowRight className="ml-1 size-4 transition-transform group-hover:translate-x-[3px]" />
					{/* Every form this button ends submits on Enter; the affordance just
					    says so. aria-hidden and absolutely positioned on purpose: the
					    accessible name has to stay exactly "Continue with email" /
					    "Create account", because the e2e fixtures match those and
					    capture.setup.ts needs /continue with email/i to resolve to one
					    node per step. Hidden below `sm` — on a touch keyboard there is
					    no Enter key to point at. */}
					<span
						aria-hidden="true"
						className="vx-badge-mono absolute right-3 hidden border border-current/25 px-1 py-px opacity-45 sm:inline"
					>
						↵
					</span>
				</>
			)}
		</Button>
	);
}
