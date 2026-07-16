// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, gte, sql, sum } from "drizzle-orm";
import {
	AI_SESSION_WINDOW_MS,
	aiTierSpec,
	effectiveAiTierSpec,
	resolveAiPlan,
	resolveAiTier,
} from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import {
	type AiUsageKind,
	type CreditSource,
	oldestUsageForUserSince,
	oldestUsageSince,
	purchasedBalance,
	recordAiUsage,
	sumCredits,
	sumCreditsForUser,
} from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";

/**
 * Credits a metered (settle) turn HOLDS while it is in flight (≈$0.10). Written to the ledger
 * up front as a provisional row so concurrent turns in the same org SEE the reservation and are
 * denied once the window's cap (outstanding holds included) is reached; the hold is reconciled
 * to the turn's real cost-of-serve on finish (or released to 0 on error/abort/empty turn). Chosen
 * small enough that a single legit turn always fits an `ai_free` session/week (130/510) — do NOT
 * raise it, or `ai_free`'s small cap would admit no turn at all.
 *
 * **Honest overspend bound.** The reserve is a placeholder, NOT a ceiling: a real agent turn often
 * costs MORE than the reserve (100 cr ≈ $0.10; real turns run 300–900+ cr). While such a turn is in
 * flight it under-books the window by `realCost - reserve`, so the window can transiently overspend.
 * The bound is `Σ over concurrently-admitted turns of max(0, realCost - reserve)`, where concurrency
 * is capped at `ceil(cap / reserve)` (that many holds fit before the headroom check blocks the next
 * turn). It is NOT "≤ 1 hold" — that only holds when every turn costs ≤ the reserve. Each turn's hold
 * reconciles to its real cost on finish, so the overspend is transient (the window self-corrects as
 * turns settle) and bounded; it is the accepted cost of gating a metered turn on headroom.
 */
export const METERED_RESERVE_CREDITS = 100;

/** Thrown when an org is out of AI credits; mapped to an upgrade / buy-credits CTA. */
export class AiBudgetError extends Error {
	constructor(
		message: string,
		readonly reason: "not_enabled" | "session" | "weekly" | "out",
		/** ISO time the blocking window clears (null when only buying credits helps). */
		readonly resetAt: string | null,
		/** Whether upgrading the AI plan would lift the block. */
		readonly upgradable: boolean,
	) {
		super(message);
		this.name = "AiBudgetError";
	}
}

/**
 * Decision returned by the guard: how to charge the allowed action. Two shapes:
 *  - **fixed** `{ source, credits }` — a reservation booked up front (only `scan` today).
 *  - **settle** `{ source, settle: true }` — a metered turn whose real cost-of-serve is only
 *    known AFTER it runs; the caller records it (credits derived from `cost_micros`).
 * `settle` is the discriminant (absent/false ⇒ the fixed shape carries `credits`).
 */
export type AiCharge =
	| { source: CreditSource; credits: number; settle?: false }
	| { source: CreditSource; settle: true; holdId: string };

/** Context needed to release a metered hold: whose/which turn's row to reconcile. */
export interface AiHoldContext {
	orgId: string;
	userId: string;
	kind: AiUsageKind;
	/** Optional ledger `ref_id` to stamp on the released row (thread/agent/project id). */
	refId?: string;
}

/**
 * Release a metered (settle) turn's provisional HOLD to **0 credits**, restoring the window's
 * headroom. A metered turn reserves a `METERED_RESERVE_CREDITS` hold up front (see
 * {@link assertAiAllowed}); that hold MUST be reconciled to real cost on finish OR released here on
 * any path that ends the turn without settling — a throw BETWEEN the gate and `streamText`
 * registration, or a client disconnect / abort mid-stream (`onAbort`). Passing the `holdId` with no
 * tokens/model makes {@link recordAiUsage} overwrite the reserved estimate with 0 (an absolute-value
 * UPDATE), so the hold never leaks headroom.
 *
 * No-op for a fixed (reservation) charge — it holds no row. Idempotent-safe: the UPDATE is
 * last-writer-wins, so releasing an already-reconciled hold to 0 is harmless — but callers wire this
 * ONLY to the mutually-exclusive abort / pre-stream-throw paths (never after a successful `onFinish`
 * already reconciled), so it does not double-fire the normal path.
 */
export async function releaseAiHold(
	charge: AiCharge,
	ctx: AiHoldContext,
): Promise<void> {
	if (!charge.settle) return;
	await recordAiUsage({
		orgId: ctx.orgId,
		userId: ctx.userId,
		kind: ctx.kind,
		source: charge.source,
		holdId: charge.holdId,
		refId: ctx.refId,
	});
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Fixed week bucket (epoch-aligned) → a clean shared weekly reset + simple sums. */
function bucketStart(now: number, sizeMs: number): Date {
	return new Date(Math.floor(now / sizeMs) * sizeMs);
}

/**
 * When a blocked ROLLING session fully clears: the oldest included usage inside the
 * trailing 5-hour window + the window size (capacity actually frees gradually as usage
 * ages out; this is the conservative "all clear" moment). Per-seat when `userId` is
 * given. Null-defensive — a blocked caller has usage in the window by definition, but a
 * racing window edge must not turn the budget error into a crash.
 */
async function sessionResetIso(
	orgId: string,
	userId?: string,
): Promise<string | null> {
	const since = new Date(Date.now() - AI_SESSION_WINDOW_MS);
	const oldest = userId
		? await oldestUsageForUserSince(orgId, userId, "included", since)
		: await oldestUsageSince(orgId, "included", since);
	return oldest
		? new Date(oldest.getTime() + AI_SESSION_WINDOW_MS).toISOString()
		: null;
}

/**
 * Throw the **per-seat** (personal) budget error — this seat has exhausted its personal
 * session/weekly sub-cap while the ORG still has included room. Not upgradable (buying
 * org credits / upgrading doesn't lift a personal cap; it clears as the window rolls).
 */
function throwPersonalCap(weeklyHit: boolean, resetAt: string | null): never {
	throw new AiBudgetError(
		weeklyHit
			? "You've reached your personal AI usage limit for this week. It resets soon — an admin can raise the per-seat limit."
			: "You've reached your personal AI usage limit for this session. It frees up as usage rolls out of the 5-hour window — an admin can raise the per-seat limit.",
		weeklyHit ? "weekly" : "session",
		resetAt,
		false,
	);
}

/**
 * Throw the **org-level** budget error — the org's included allowance for this window is
 * spent (and no purchased top-up covers it). Upgradable: a higher tier lifts it.
 */
function throwOrgCap(weeklyHit: boolean, resetAt: string | null): never {
	throw new AiBudgetError(
		weeklyHit
			? "You're out of included AI usage for this week. Upgrade your AI plan or wait for the weekly reset."
			: "You're out of included AI usage for this session. It frees up as usage rolls out of the 5-hour window.",
		weeklyHit ? "weekly" : "session",
		resetAt,
		true,
	);
}

/**
 * Coarse access gate for the AI *surface* (the MCP endpoint): is AI enabled for this
 * org at all? Unlike assertAiAllowed it charges nothing — per-call metering still
 * rides each tool (e.g. scanner → assertAiAllowed("scan")). AI is a standalone product
 * now: every org has at least the `ai_free` tier, so this is true unless a tier is
 * explicitly disabled. **Self-host bypass:** no hosted billing → always enabled
 * (open-core; the operator pays their own gateway).
 */
export async function isAiSurfaceEnabled(orgId: string): Promise<boolean> {
	if (!isStripeConfigured()) return true;
	const tier = await resolveAiTier(orgId).catch(() => "ai_free" as const);
	return aiTierSpec(tier).enabled;
}

/**
 * Gate a metered AI action against the org's AI-tier budget — a rolling **5-hour session**
 * cap + a fixed **weekly** cap (both from the org's standalone AI tier, INDEPENDENT of the
 * org plan), spending **included** credits first, then **purchased** top-ups. The two
 * windows are independent, Anthropic-style: sessions roll continuously, so a heavy day can
 * legitimately exhaust the whole week. Returns how to charge it (caller records via
 * `recordAiUsage`); throws `AiBudgetError` when out.
 *
 * Two charge models by kind:
 *  - **Fixed (`scan`)** — a nominal cost (`creditsFor`) is *reserved* up front: allowed only
 *    if `used + cost <= cap`. The returned charge carries that `credits` figure.
 *  - **Metered (`agent`/`support`)** — the real cost-of-serve is only known AFTER the turn, so
 *    the gate checks **headroom** instead: allowed if the window still has ANY room
 *    (`used < cap`). To keep concurrent turns from all reading the same headroom and racing past
 *    the cap, the metered check runs inside a **per-org advisory-locked transaction** that
 *    re-reads under the lock and RESERVES a provisional `METERED_RESERVE_CREDITS` hold row — so
 *    the next turn's re-read sees the reservation. The returned charge is `{ settle: true, holdId }`;
 *    the caller RECONCILES that hold to the turn's real cost (derived from `cost_micros`) on finish,
 *    or RELEASES it (to 0) on error / abort / a throw before the stream registers. A turn that starts
 *    with headroom may TRANSIENTLY overshoot its window while in flight — the reserve is a placeholder,
 *    not a ceiling, so a turn costing more than the reserve under-books by `realCost - reserve` until
 *    it settles. The overspend is bounded by `Σ over concurrently-admitted turns of max(0, realCost -
 *    reserve)`, concurrency ≤ `ceil(cap / reserve)` (see {@link METERED_RESERVE_CREDITS}); it is NOT
 *    "≤ 1 hold". Each hold reconciles to real cost on finish, so the window self-corrects.
 *
 * When `userId` is supplied, an additional **per-seat** session + weekly sub-cap is enforced on
 * top of the org caps (a fraction of the org allowance — see `AiTierSpec.perUser*`), so one
 * member can't drain the whole workspace's included budget. A seat that has exhausted its
 * personal share while the org still has room is blocked (buying org credits doesn't lift a
 * per-seat cap; it clears as usage rolls out of the window). Omitting `userId` preserves the
 * org-only behaviour (back-compat).
 *
 * Respects the org's **AI-spend hard cap** (`organization_billing.usageHardCap`, shared with
 * the runner-minutes guard): when on, the guard pauses at the included allowance instead of
 * auto-spending purchased top-up packs.
 *
 * **Self-host bypass:** no hosted billing → unlimited (the operator pays their own gateway
 * tokens; the open-core deal).
 */
export async function assertAiAllowed(
	orgId: string,
	kind: AiUsageKind,
	userId?: string,
): Promise<AiCharge> {
	if (!isStripeConfigured()) return { source: "included", credits: 0 };

	const plan = await resolveAiPlan(orgId);
	const { tier, hardCap } = plan;
	// The effective caps fold in any admin org/per-seat spend limits (min(tier, limit)), so
	// every downstream org + per-seat check below enforces them automatically.
	const spec = effectiveAiTierSpec(aiTierSpec(tier), plan);
	if (!spec.enabled) {
		throw new AiBudgetError(
			"AI features are not enabled for this workspace.",
			"not_enabled",
			null,
			true,
		);
	}

	const now = Date.now();
	const sessionSince = new Date(now - AI_SESSION_WINDOW_MS);
	const weekStart = bucketStart(now, WEEK_MS);
	const weekResetIso = new Date(weekStart.getTime() + WEEK_MS).toISOString();

	const [sessionUsed, weekUsed, userSessionUsed, userWeekUsed] =
		await Promise.all([
			sumCredits(orgId, "included", sessionSince),
			sumCredits(orgId, "included", weekStart),
			userId
				? sumCreditsForUser(orgId, userId, "included", sessionSince)
				: Promise.resolve(0),
			userId
				? sumCreditsForUser(orgId, userId, "included", weekStart)
				: Promise.resolve(0),
		]);

	// FIXED-cost kinds (scan): reserve the nominal cost up front — allowed only if it fits.
	if (kind === "scan") {
		const cost = creditsFor(kind);
		const orgSessionOk = sessionUsed + cost <= spec.sessionCredits;
		const orgWeekOk = weekUsed + cost <= spec.weeklyCredits;
		const userSessionOk =
			!userId || userSessionUsed + cost <= spec.perUserSessionCredits;
		const userWeekOk =
			!userId || userWeekUsed + cost <= spec.perUserWeeklyCredits;

		if (orgSessionOk && orgWeekOk && userSessionOk && userWeekOk) {
			return { source: "included", credits: cost };
		}
		// Per-seat fairness cap is the binding limit while the ORG still has included room.
		if (orgSessionOk && orgWeekOk && (!userSessionOk || !userWeekOk)) {
			throwPersonalCap(
				!userWeekOk,
				!userWeekOk ? weekResetIso : await sessionResetIso(orgId, userId),
			);
		}
		// Org included budget exhausted — spend purchased top-ups unless the hard cap says pause.
		if (!hardCap && (await purchasedBalance(orgId)) >= cost) {
			return { source: "purchased", credits: cost };
		}
		throwOrgCap(
			!orgWeekOk,
			!orgWeekOk ? weekResetIso : await sessionResetIso(orgId),
		);
	}

	// METERED kinds (agent/support): the real cost isn't known yet → gate on HEADROOM. The turn
	// settles its actual cost-of-serve afterward. Because the settle row is written only AFTER the
	// stream ends, N concurrent turns would otherwise all read the same pre-settle headroom and all
	// pass (free overspend). So we SERIALIZE per org: take a per-org advisory xact lock, re-read the
	// window sums INSIDE the lock (prior admitted turns' hold rows are now visible), then RESERVE a
	// provisional hold row before releasing the lock. The hold is reconciled to real cost on finish.
	//
	// The hold row's `user_id` is NOT NULL and every metered call site supplies the actor's id, so
	// require it here (the org-only, userId-less path is the fixed/scan surface, handled above).
	if (!userId) {
		throw new Error(
			"assertAiAllowed: a metered AI turn requires the actor's userId (the hold row is per-seat).",
		);
	}
	const seatId = userId;

	// Decide inside a serialized transaction, then compute reset times / throw OUTSIDE it. Every read
	// inside the txn uses `tx` (the txn's single connection) — never a second pooled connection — so a
	// burst of concurrent gate checks (each holding one pool slot while it waits on the advisory lock)
	// can't deadlock the pool on a nested read. The deny→resetAt reads run after the lock is released.
	type Decision =
		| { outcome: "charge"; charge: AiCharge }
		| { outcome: "personal"; weeklyHit: boolean }
		| { outcome: "org"; weeklyHit: boolean };

	const decision: Decision = await getServiceDb().transaction(
		async (tx): Promise<Decision> => {
			// Serialize every AI-budget gate check for THIS org — auto-released at commit/rollback.
			// Sub-ms gate checks ⇒ negligible contention; only one org's gate is ever serialized.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('ai_budget'), hashtext(${orgId}))`,
			);

			/** Σ included credits (org, or one seat) in [since, now) — re-read under the lock. */
			const usedInWindow = async (
				since: Date,
				perSeat: boolean,
			): Promise<number> => {
				const [row] = await tx
					.select({ s: sum(aiUsageLedger.credits) })
					.from(aiUsageLedger)
					.where(
						and(
							eq(aiUsageLedger.org_id, orgId),
							eq(aiUsageLedger.source, "included"),
							gte(aiUsageLedger.created_at, since),
							perSeat ? eq(aiUsageLedger.user_id, seatId) : undefined,
						),
					);
				return Number(row?.s ?? 0);
			};

			/** Remaining purchased top-ups, computed on the txn connection (Σ grants − Σ purchased). */
			const purchasedAvailable = async (): Promise<number> => {
				const [granted] = await tx
					.select({ s: sum(aiCreditGrant.credits) })
					.from(aiCreditGrant)
					.where(eq(aiCreditGrant.org_id, orgId));
				const [spent] = await tx
					.select({ s: sum(aiUsageLedger.credits) })
					.from(aiUsageLedger)
					.where(
						and(
							eq(aiUsageLedger.org_id, orgId),
							eq(aiUsageLedger.source, "purchased"),
						),
					);
				return Number(granted?.s ?? 0) - Number(spent?.s ?? 0);
			};

			const [sUsed, wUsed, uSUsed, uWUsed] = await Promise.all([
				usedInWindow(sessionSince, false),
				usedInWindow(weekStart, false),
				usedInWindow(sessionSince, true),
				usedInWindow(weekStart, true),
			]);

			const orgSessionOk = sUsed < spec.sessionCredits;
			const orgWeekOk = wUsed < spec.weeklyCredits;
			const userSessionOk = uSUsed < spec.perUserSessionCredits;
			const userWeekOk = uWUsed < spec.perUserWeeklyCredits;

			/** Write the provisional hold row and return the settle charge that carries its id. */
			const reserve = async (source: CreditSource): Promise<Decision> => {
				const [row] = await tx
					.insert(aiUsageLedger)
					.values({
						org_id: orgId,
						user_id: seatId,
						kind,
						credits: METERED_RESERVE_CREDITS,
						source,
					})
					.returning({ id: aiUsageLedger.id });
				return {
					outcome: "charge",
					charge: { source, settle: true, holdId: row.id },
				};
			};

			if (orgSessionOk && orgWeekOk && userSessionOk && userWeekOk) {
				return reserve("included");
			}
			// Per-seat fairness cap is the binding limit while the ORG still has included headroom:
			// block THIS seat (don't silently divert to purchased packs). Fail-closed.
			if (orgSessionOk && orgWeekOk && (!userSessionOk || !userWeekOk)) {
				return { outcome: "personal", weeklyHit: !userWeekOk };
			}
			// Org included headroom is gone for this window — reserve against purchased top-ups if
			// any, unless the org's hard-cap policy says to pause at the included allowance instead.
			if (!hardCap && (await purchasedAvailable()) > 0) {
				return reserve("purchased");
			}
			return { outcome: "org", weeklyHit: !orgWeekOk };
		},
	);

	// Lock released — safe to spend a pooled connection on the reset-time reads before throwing.
	if (decision.outcome === "charge") return decision.charge;
	if (decision.outcome === "personal") {
		throwPersonalCap(
			decision.weeklyHit,
			decision.weeklyHit ? weekResetIso : await sessionResetIso(orgId, seatId),
		);
	}
	throwOrgCap(
		decision.weeklyHit,
		decision.weeklyHit ? weekResetIso : await sessionResetIso(orgId),
	);
}
