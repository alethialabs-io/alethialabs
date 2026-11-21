// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse ceilings — ONE typed table (beta seam REL-S3, #6775).
//
// Every number that bounds what a free or new account can do at platform cost lives here: sign-up,
// the trial, the free AI pool, free runner jobs and repository scans. Each row carries its default,
// its unit and window, who it is counted against, and the environment variable an operator sets to
// change it without a code change. The docs limits page is GENERATED from this table
// (`scripts/gen-abuse-limits.mjs` → `apps/docs/generated/abuse-limits.json`), so the page and the
// enforcement read one source. A unit test fails when the committed JSON drifts from this file.
//
// WHAT THIS FILE IS NOT. It does not enforce anything. The lanes that do read from it:
//   - sign-up ceilings      → REL-L10 (`lib/auth/**`)
//   - trial ceilings        → REL-L19 (`lib/billing/trial/**`)
//   - free AI pool          → REL-L11 (`lib/abuse/free-ai-pool.ts`, gated in `lib/billing/ai-guard.ts`)
//   - free daily jobs       → REL-L11 (`lib/billing/job-quota.ts`, through `abuseLimit("free_daily_jobs")`;
//                             the unit test fails if that file grows its own copy again)
//   - scans, repository size → GIT-A1 (`lib/scanner/**`)
// A row whose enforcer has not landed is still documented, which is why `enforcedBy` names the
// unit rather than claiming a file.
//
// NO IMPORTS, ERASABLE SYNTAX ONLY. The generator loads this file with Node's built-in type
// stripping (no build step, no `tsx` dependency), which cannot resolve `@/` aliases and rejects
// enums and parameter properties. Keep it plain data plus two pure functions.
//
// ENV OVERRIDES follow the rule job-quota.ts used before it read this table: a positive number is floored and used; unset,
// blank, zero, negative or non-numeric falls back to the default. Zero is NOT "refuse everything" —
// stopping a surface is a kill switch (REL-L11), not a ceiling, so a typo cannot silently close sign-up.

/** Every ceiling's stable key. Lanes and the docs page address a row by this. */
export type AbuseLimitKey =
	| "signup_accounts_per_network_daily"
	| "trial_per_person"
	| "trial_per_network_monthly"
	| "free_ai_global_daily_credits"
	| "free_daily_jobs"
	| "scans_per_org_daily"
	| "repository_size_mb";

/** The product surface a ceiling protects; the docs page groups rows by it. */
export type AbuseLimitSurface = "sign-up" | "trial" | "ai" | "jobs" | "scans";

/** What one unit of a ceiling counts. */
export type AbuseLimitUnit = "accounts" | "trials" | "credits" | "jobs" | "scans" | "megabytes";

/**
 * The window a ceiling is counted over. `utc-day` resets at 00:00 UTC; `trailing-24h` and
 * `trailing-30d` slide; `lifetime` never resets; `per-item` bounds a single object (one repository).
 */
export type AbuseLimitWindow = "utc-day" | "trailing-24h" | "trailing-30d" | "lifetime" | "per-item";

/**
 * Who the count is kept against. `network` is the client network the edge reports (the trusted
 * `cf-connecting-ip`); `person` is a verified email address; `platform` is one count across every
 * free organization.
 */
export type AbuseLimitScope = "network" | "person" | "organization" | "platform";

/** Which plans a ceiling binds. `free` is Hobby (`community`) and an unpaid trial; `all` is every plan. */
export type AbuseLimitAppliesTo = "free" | "all";

/** One row of the ceilings table. */
export interface AbuseLimit {
	/** Stable key, equal to the row's key in {@link ABUSE_LIMITS}. */
	key: AbuseLimitKey;
	surface: AbuseLimitSurface;
	/** The value used when no override is set. A positive integer. */
	defaultValue: number;
	unit: AbuseLimitUnit;
	window: AbuseLimitWindow;
	scope: AbuseLimitScope;
	appliesTo: AbuseLimitAppliesTo;
	/** The environment variable that overrides {@link AbuseLimit.defaultValue}. `ALETHIA_` prefixed. */
	env: string;
	/** One sentence for the docs limits page: what is bounded, in the reader's terms. */
	description: string;
	/** What the person sees, or can do, when the ceiling is reached. Shown on the docs page. */
	whenReached: string;
	/** The board unit that enforces this row (it may not have landed yet). */
	enforcedBy: string;
}

/** The ceilings table. Ordered as the docs page lists it. */
export const ABUSE_LIMITS: Readonly<Record<AbuseLimitKey, Readonly<AbuseLimit>>> = {
	signup_accounts_per_network_daily: {
		key: "signup_accounts_per_network_daily",
		surface: "sign-up",
		defaultValue: 10,
		unit: "accounts",
		window: "utc-day",
		scope: "network",
		appliesTo: "all",
		env: "ALETHIA_SIGNUP_ACCOUNTS_PER_NETWORK_DAILY",
		description: "New accounts created from one network in one day.",
		whenReached: "Sign-up from that network is refused until the next UTC day. Existing accounts can still sign in.",
		enforcedBy: "REL-L10",
	},
	trial_per_person: {
		key: "trial_per_person",
		surface: "trial",
		defaultValue: 1,
		unit: "trials",
		window: "lifetime",
		scope: "person",
		appliesTo: "all",
		env: "ALETHIA_TRIAL_PER_PERSON",
		description: "Pro trials one person can start, across every organization they belong to.",
		whenReached: "The trial offer is not shown. The organization can still buy a plan.",
		enforcedBy: "REL-L19",
	},
	trial_per_network_monthly: {
		key: "trial_per_network_monthly",
		surface: "trial",
		defaultValue: 3,
		unit: "trials",
		window: "trailing-30d",
		scope: "network",
		appliesTo: "all",
		env: "ALETHIA_TRIAL_PER_NETWORK_MONTHLY",
		description: "Pro trials started from one network in 30 days.",
		whenReached: "A new trial from that network is refused with the reason stated. Buying a plan is not affected.",
		enforcedBy: "REL-L19",
	},
	free_ai_global_daily_credits: {
		key: "free_ai_global_daily_credits",
		surface: "ai",
		defaultValue: 20_000,
		unit: "credits",
		window: "utc-day",
		scope: "platform",
		appliesTo: "free",
		env: "ALETHIA_FREE_AI_GLOBAL_DAILY_CREDITS",
		description: "AI credits all free organizations together can spend in one day. Each organization's own session and weekly allowance still applies.",
		whenReached: "Free AI turns pause until the next UTC day, with the reason shown. Paid AI plans are not affected.",
		enforcedBy: "REL-L11",
	},
	free_daily_jobs: {
		key: "free_daily_jobs",
		surface: "jobs",
		defaultValue: 25,
		unit: "jobs",
		window: "trailing-24h",
		scope: "organization",
		appliesTo: "free",
		// The variable job-quota.ts already reads; kept so an existing override survives the move.
		env: "ALETHIA_FREE_DAILY_JOB_QUOTA",
		description: "Provisioning jobs a Hobby organization can start in 24 hours. Kubeconfig requests and system jobs do not count.",
		whenReached: "New jobs are refused until older ones leave the 24-hour window, or the organization upgrades.",
		enforcedBy: "REL-L11",
	},
	scans_per_org_daily: {
		key: "scans_per_org_daily",
		surface: "scans",
		defaultValue: 20,
		unit: "scans",
		window: "utc-day",
		scope: "organization",
		appliesTo: "free",
		env: "ALETHIA_SCANS_PER_ORG_DAILY",
		description: "Repository scans a Hobby organization can run in one day.",
		whenReached: "New scans are refused until the next UTC day, or the organization upgrades.",
		enforcedBy: "GIT-A1",
	},
	repository_size_mb: {
		key: "repository_size_mb",
		surface: "scans",
		defaultValue: 500,
		unit: "megabytes",
		window: "per-item",
		scope: "organization",
		appliesTo: "all",
		env: "ALETHIA_REPOSITORY_SIZE_MB",
		description: "The largest repository a scan will read.",
		whenReached: "The scan is refused with the repository's size and the ceiling stated.",
		enforcedBy: "GIT-A1",
	},
};

/** Every ceiling's key, in table order. */
export const ABUSE_LIMIT_KEYS: readonly AbuseLimitKey[] = [
	"signup_accounts_per_network_daily",
	"trial_per_person",
	"trial_per_network_monthly",
	"free_ai_global_daily_credits",
	"free_daily_jobs",
	"scans_per_org_daily",
	"repository_size_mb",
];

/**
 * Parses an override value: a positive finite number is floored and returned; anything else
 * (undefined, blank, zero, negative, non-numeric) returns null so the caller keeps the default.
 */
export function parseAbuseLimitOverride(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 1) return null;
	return Math.floor(n);
}

/**
 * The effective value of one ceiling: its environment override when that is a positive number,
 * otherwise the table default. `env` defaults to `process.env`; tests pass their own map.
 */
export function abuseLimit(
	key: AbuseLimitKey,
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const row = ABUSE_LIMITS[key];
	return parseAbuseLimitOverride(env[row.env]) ?? row.defaultValue;
}
