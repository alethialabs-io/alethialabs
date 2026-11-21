// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The free AI pool — one platform-wide ceiling on what every free organization's AI turns cost us
// in a UTC day, and the operator's switch that pauses free AI outright (REL-L11, #6912; spec
// release-and-billing §4.5 "Free AI"). Each organization's own session, weekly and per-seat caps
// (ai-guard.ts) still apply underneath; this bounds the SUM, which no per-org cap can.
//
// WHO IT BINDS. An organization whose EFFECTIVE AI tier is `ai_free` (ai-plan.ts: no billing row,
// `ai_tier = 'ai_free'`, or a paid tier whose AI subscription is not active/trialing). Paid AI tiers
// are never paused here. A free organization with purchased top-up credits can still spend THOSE
// while the pool is paused (unless its hard cap says pause at the included allowance): only the
// included allowance is ours to bound. The gate itself is in ai-guard.ts; this file decides.
//
// THE COUNT. Σ `ai_usage_ledger.credits` from the `included` source since 00:00 UTC, over rows whose
// organization is free by the rule above as it reads NOW (a row of an org that upgraded at noon is no
// longer counted). Outstanding holds are rows too, so in-flight turns count at their reserve.
// The ceiling is `abuseLimit("free_ai_global_daily_credits")` from the typed table (lib/abuse/limits.ts).
//
// CACHE AND OVERSPEND BOUND. The ledger has no index that leads with `created_at` for the included
// source (its index leads with `org_id`), so the sum is a scan of today's rows. It is therefore read
// at most once per {@link FREE_AI_POOL_CACHE_MS} per process. Once the pool is SPENT it stays spent
// for the rest of the UTC day (the count only grows), so a paused pool is never re-read until the day
// turns. The honest bound: the pool can overrun by whatever free turns are admitted in one cache window
// across all replicas, plus the overrun of in-flight turns past their reserve (ai-guard.ts states that
// one). That is a soft cost ceiling, which is what the spec asks for; it is not a hard one.
//
// THE KILL SWITCH. `ALETHIA_FREE_AI_PAUSED` set to `1`, `true`, `on` or `yes` (any case) pauses every
// free AI turn, with the reason stated, regardless of the count. It is read from the process
// environment on EVERY call — never captured at module load — so flipping it is an environment change
// and a restart of the console process, not a code change, a build or a deploy. A hot flip with no
// restart needs a platform-settings row, which needs a migration this unit was not allocated; see the
// PR (#6912) for that open question.
//
// FAIL OPEN, LOUDLY. A count query that errors admits the turn (a soft cost guard must not take free
// AI down with a database hiccup) and raises `system.platform.cost_guard_failed_open` on the operator
// org. The kill switch never depends on the database, so the operator can always close the pool.

import "server-only";
import { and, eq, gte, isNull, notInArray, or, sum } from "drizzle-orm";
import { abuseLimit } from "@/lib/abuse/limits";
import {
	COST_GUARD_FAILED_OPEN_EVENT,
	FREE_AI_PAUSED_EVENT,
	raisePlatformAbuseAlert,
} from "@/lib/abuse/platform-alert";
import type { Db } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import { aiUsageLedger, organizationBilling } from "@/lib/db/schema";

/** The environment variable that is the operator's kill switch for free AI. */
export const FREE_AI_PAUSED_ENV = "ALETHIA_FREE_AI_PAUSED";

/** How long one read of the pool's daily total is reused, per process. */
export const FREE_AI_POOL_CACHE_MS = 30_000;

const DAY_MS = 24 * 3_600_000;

/** The billing statuses under which a paid AI tier is effective (ai-plan.ts · effectiveAiTier). */
const LIVE_AI_STATUSES = ["active", "trialing"] as const;

/** Why free AI is paused: the operator's switch, or the platform's daily ceiling. */
export type FreeAiPauseCause = "switch" | "ceiling";

/** What the pool says about one more free AI turn right now. */
export type FreeAiPoolState =
	| { open: true }
	| {
			open: false;
			cause: FreeAiPauseCause;
			/** When the pause lifts by itself: next 00:00 UTC for the ceiling, null for the switch. */
			resetAt: string | null;
	  };

/** True when the kill switch is set: `1`, `true`, `on` or `yes`, any case, surrounding spaces ignored. */
export function isFreeAiSwitchedOff(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const raw = env[FREE_AI_PAUSED_ENV];
	if (raw === undefined) return false;
	return ["1", "true", "on", "yes"].includes(raw.trim().toLowerCase());
}

/** 00:00 UTC of the day containing `now`. */
export function utcDayStart(now: number): Date {
	return new Date(Math.floor(now / DAY_MS) * DAY_MS);
}

/**
 * The pure decision: the switch first (it needs no count), then the ceiling. `used` null means the
 * count could not be read, which is open (fail-open; the caller alerts).
 */
export function decideFreeAiPool(input: {
	switchedOff: boolean;
	used: number | null;
	ceiling: number;
	now: number;
}): FreeAiPoolState {
	if (input.switchedOff) return { open: false, cause: "switch", resetAt: null };
	if (input.used !== null && input.used >= input.ceiling) {
		return {
			open: false,
			cause: "ceiling",
			resetAt: new Date(utcDayStart(input.now).getTime() + DAY_MS).toISOString(),
		};
	}
	return { open: true };
}

/**
 * Σ included credits booked since `since` by organizations whose effective AI tier is free — the
 * pool's count. Runs on whatever handle it is given (a pooled `Db`, or a transaction / savepoint).
 */
export async function readFreeAiPoolUsed(db: Pick<Db, "select">, since: Date): Promise<number> {
	const [row] = await db
		.select({ s: sum(aiUsageLedger.credits) })
		.from(aiUsageLedger)
		.leftJoin(organizationBilling, eq(organizationBilling.organizationId, aiUsageLedger.org_id))
		.where(
			and(
				eq(aiUsageLedger.source, "included"),
				gte(aiUsageLedger.created_at, since),
				or(
					isNull(organizationBilling.id),
					eq(organizationBilling.aiTier, "ai_free"),
					notInArray(organizationBilling.aiSubscriptionStatus, [...LIVE_AI_STATUSES]),
				),
			),
		);
	return Number(row?.s ?? 0);
}

/** The last count this process read: which UTC day it belongs to, its value, and when it was read. */
let cached: { dayStartMs: number; used: number; readAtMs: number } | null = null;

/** The UTC day this process last raised the ceiling alert for (one alert per day per process). */
let ceilingAlertedForDay: number | null = null;

/** Forgets the cached count and the ceiling-alert latch. Tests only: a fresh process has neither. */
export function resetFreeAiPoolCache(): void {
	cached = null;
	ceilingAlertedForDay = null;
}

/** Options for {@link freeAiPoolState}. */
export interface FreeAiPoolOptions {
	/**
	 * Read the count on this handle instead of a pooled connection. A caller INSIDE a transaction
	 * must pass one (ai-guard.ts passes a savepoint): a pooled read while that transaction holds its
	 * connection and the AI-budget lock is the pool deadlock ai-guard.ts describes.
	 */
	read?: (since: Date) => Promise<number>;
	now?: number;
	env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Whether one more free AI turn may draw on the included allowance right now. Never throws: a count
 * that cannot be read is open, and raises the fail-open platform alert. The first time this process
 * sees the pool spent on a given UTC day it raises the `free_ai_paused` platform alert.
 */
export async function freeAiPoolState(opts: FreeAiPoolOptions = {}): Promise<FreeAiPoolState> {
	const env = opts.env ?? process.env;
	const now = opts.now ?? Date.now();
	const switchedOff = isFreeAiSwitchedOff(env);
	const ceiling = abuseLimit("free_ai_global_daily_credits", env);
	if (switchedOff) return decideFreeAiPool({ switchedOff, used: null, ceiling, now });

	const dayStart = utcDayStart(now);
	const dayStartMs = dayStart.getTime();
	let used: number | null = null;
	const fresh =
		cached !== null &&
		cached.dayStartMs === dayStartMs &&
		(cached.used >= ceiling || now - cached.readAtMs < FREE_AI_POOL_CACHE_MS);
	if (fresh && cached !== null) {
		used = cached.used;
	} else {
		try {
			const read = opts.read ?? ((since: Date) => readFreeAiPoolUsed(getServiceDb(), since));
			used = await read(dayStart);
			cached = { dayStartMs, used, readAtMs: now };
		} catch (err) {
			raisePlatformAbuseAlert(
				{
					event: COST_GUARD_FAILED_OPEN_EVENT,
					subject: "free_ai_pool",
					title: "Free AI pool check failed open",
					summary: `The free AI pool's daily count could not be read, so free AI turns are being admitted without the global ceiling (${ceiling} credits a day). Set ${FREE_AI_PAUSED_ENV}=1 to pause free AI while this lasts. Error: ${err instanceof Error ? err.message : String(err)}`,
					severity: "critical",
				},
				now,
			);
			used = null;
		}
	}

	const state = decideFreeAiPool({ switchedOff, used, ceiling, now });
	if (!state.open && state.cause === "ceiling" && ceilingAlertedForDay !== dayStartMs) {
		ceilingAlertedForDay = dayStartMs;
		raisePlatformAbuseAlert(
			{
				event: FREE_AI_PAUSED_EVENT,
				subject: "free_ai_pool",
				title: "Free AI paused: daily ceiling reached",
				summary: `Free organizations together have used ${used ?? "?"} of the ${ceiling} free AI credits allowed today, so free AI turns are paused until ${state.resetAt}. Paid AI plans and purchased credits are not affected. Raise ALETHIA_FREE_AI_GLOBAL_DAILY_CREDITS to reopen.`,
				severity: "warning",
			},
			now,
		);
	}
	return state;
}
