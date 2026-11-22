// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card-less Pro trial's server seams (REL-L19, #6907; decision M12):
//
//   - trialSalesOpen()      whether the trial may be OFFERED at all. It reads the launch state
//                           (`paidLaunchState`, REL-S2), whose trial state is the paid state by
//                           construction, plus the console's test-mode waiver — the same two inputs
//                           `paidSalesOpen` reads. While no paid market is open, no trial is offered.
//   - personTrialAvailable  whether this person still has a trial under the per-person ceiling.
//   - reserveTrial()        spends one trial against the organization, the person and the network,
//                           or throws TrialNotAllowedError naming the first ceiling that is full.
//   - releaseTrial()        gives a reservation back when the trial was not created after all.
//
// THE PURCHASE GATE IS NOT HERE. `startProTrial` calls the same `gatePaidConversion` every purchase
// calls (lib/billing/eligibility.ts), so a trial is refused for exactly the reasons a purchase is.
// These ceilings are checked after it, only for a start the gate allowed.

import { headers } from "next/headers";
import { paidLaunchState } from "@repo/legal/launch";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { testModeMarketOpen } from "@/lib/billing/eligibility";
import {
	personCounter,
	TRIAL_REFUSAL_MESSAGES,
	type TrialRefusal,
	trialCounters,
} from "@/lib/billing/trial/ceilings";
import { peekFullCounter, releaseTrialSlots, reserveTrialSlots, type TrialSlot } from "@/lib/billing/trial/store";
import { getAuthConfig } from "@/lib/config/auth";
import { errorName } from "@/lib/errors";
import { log } from "@/lib/observability/log";

/** A trial start refused by one of the ceilings, carrying the reason and a message safe to show. */
export class TrialNotAllowedError extends Error {
	readonly reason: TrialRefusal;

	constructor(reason: TrialRefusal) {
		super(TRIAL_REFUSAL_MESSAGES[reason]);
		this.name = "TrialNotAllowedError";
		this.reason = reason;
	}
}

/** A spent trial: the slots to give back if the trial is not created. */
export interface TrialReservation {
	readonly slots: readonly TrialSlot[];
}

/**
 * Whether the trial may be offered: the launch state's trial is open somewhere, or this console is a
 * Stripe test-mode console carrying the release gate's waiver. Global, not per payer — the purchase
 * gate stays the authority for each declared payer.
 */
export function trialSalesOpen(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	return paidLaunchState().trial.status === "open" || testModeMarketOpen(env);
}

/**
 * The client address of the current request, from the deployment's trusted header, or null when there
 * is no request (a script, a test) or no valid address on it.
 */
async function requestClientIp(): Promise<string | null> {
	try {
		return trustedClientIp(await headers());
	} catch {
		return null;
	}
}

/**
 * Whether the person behind `email` still has a trial under the per-person ceiling. Read without
 * reserving anything.
 */
export async function personTrialAvailable(email: string | null | undefined): Promise<boolean> {
	const counter = personCounter({ email, secret: getAuthConfig().secret });
	return (await peekFullCounter([counter])) === null;
}

/**
 * Spends one trial for `orgId` started by the person behind `email`, from the current request's
 * network. Throws TrialNotAllowedError for the first full ceiling — the organization's one trial, the
 * person's ceiling, then the network's — having spent none of them.
 */
export async function reserveTrial(args: {
	orgId: string;
	email: string | null | undefined;
}): Promise<TrialReservation> {
	const clientIp = await requestClientIp();
	if (clientIp === null) {
		// Not counted against a network, as with the sign-up ceiling: there is none to count.
		log.warn("[billing] trial start carried no trusted client address; the network ceiling is not counted");
	}
	const counters = trialCounters({
		orgId: args.orgId,
		email: args.email,
		clientIp,
		secret: getAuthConfig().secret,
	});
	const result = await reserveTrialSlots(counters);
	if (!result.ok) {
		// The reason only — never the address, the network or a key.
		log.warn("[billing] trial start refused by a ceiling", { reason: result.refused.refusal });
		throw new TrialNotAllowedError(result.refused.refusal);
	}
	return { slots: result.slots };
}

/**
 * Gives a reservation back. Logged and swallowed on failure: the caller is already reporting the
 * failure that made it give the trial back, and a lost release only errs toward refusing.
 */
export async function releaseTrial(reservation: TrialReservation): Promise<void> {
	try {
		await releaseTrialSlots(reservation.slots);
	} catch (err) {
		log.error("[billing] trial reservation release failed", { error: errorName(err) });
	}
}
