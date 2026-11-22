// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card-less Pro trial's three ceilings (REL-L19, #6907; decision M12) — the pure half: what is
// counted, under which key, against which number. ./store.ts does the counting; ./index.ts wires
// the two to the request.
//
//   1. ONE TRIAL PER ORGANIZATION. A fixed rule, not a tunable ceiling: the decision says one, so
//      there is no environment override for it.
//   2. PER PERSON. `abuseLimit("trial_per_person")`, counted over the row's window (lifetime), keyed
//      on the person's email address — so deleting an account and signing up again with the same
//      address does not hand back a trial. `startProTrial` keeps the account's own
//      `pro_trial_consumed_at` flag as well, which refuses before this counter is read.
//   3. PER NETWORK. `abuseLimit("trial_per_network_monthly")`, counted over the row's window
//      (trailing 30 days), keyed on the client network exactly as the sign-up ceiling defines one
//      (lib/auth/signup-guard/network.ts: an IPv4 address, or an IPv6 /64).
//
// The numbers and windows live in lib/abuse/limits.ts; this file holds no copy of either. A unit test
// fails if a trial row's window becomes one the store cannot count.
//
// NEVER STORED RAW. The person and network keys are HMACs under the deployment's auth secret,
// truncated to 128 bits, with their own domain-separation prefix — the same construction as the
// sign-up network key, so a key read out of the bucket table cannot be turned back into an address.
// The organization key is the organization id, which is not personal data.

import { createHmac } from "node:crypto";
import { ABUSE_LIMITS, type AbuseLimitWindow, abuseLimit } from "@/lib/abuse/limits";
import { networkOf } from "@/lib/auth/signup-guard/network";

/** The prefix of every trial counter key in the shared bucket table. */
export const TRIAL_KEY_PREFIX = "trial:";

/** Why a trial start was refused by a ceiling — a closed set, so callers branch without parsing prose. */
export type TrialRefusal = "trial_org_used" | "trial_person_limit" | "trial_network_limit";

/**
 * What the person is told for each refusal. Each one says what is still possible, because the
 * ceilings table promises it ("The organization can still buy a plan").
 */
export const TRIAL_REFUSAL_MESSAGES: Readonly<Record<TrialRefusal, string>> = {
	trial_org_used:
		"This organization has already used its free Pro trial. You can still subscribe to Pro from billing.",
	trial_person_limit:
		"Your account has already used its free Pro trial. You can still subscribe to Pro from billing.",
	trial_network_limit:
		"Too many Pro trials have been started from your network recently, so a new one can't start now. " +
		"You can still subscribe to Pro from billing.",
};

/** One counter a trial start must fit under, and the refusal it gives when it does not. */
export interface TrialCounter {
	/** The bucket key. */
	readonly key: string;
	/** How many trials the key may have in its window. */
	readonly limit: number;
	/** The window in whole days, or null for a lifetime count. */
	readonly windowDays: number | null;
	readonly refusal: TrialRefusal;
}

/**
 * The window of a ceilings-table row in whole days, or null for `lifetime`. Throws for a window the
 * trial store does not count in, so a table edit cannot silently change what a trial row means.
 */
export function trialWindowDays(window: AbuseLimitWindow): number | null {
	if (window === "lifetime") return null;
	if (window === "trailing-30d") return 30;
	throw new Error(`the trial ceilings cannot count a "${window}" window`);
}

/** A keyed, truncated hash under `secret`, domain-separated by `purpose`. */
function keyedDigest(purpose: string, value: string, secret: string): string {
	return createHmac("sha256", secret).update(`${purpose}|${value}`).digest("hex").slice(0, 32);
}

/** The counter key for one organization's lifetime trial. */
export function trialOrgKey(orgId: string): string {
	return `${TRIAL_KEY_PREFIX}org:${orgId}`;
}

/**
 * The canonical form of an email address for the per-person count: trimmed, lower-cased, and with
 * any `+suffix` on the local part removed. Null for anything that is not `local@domain`.
 */
export function normaliseTrialEmail(email: string | null | undefined): string | null {
	const lowered = email?.trim().toLowerCase() ?? "";
	const at = lowered.lastIndexOf("@");
	if (at <= 0 || at === lowered.length - 1) return null;
	const local = lowered.slice(0, at).split("+")[0] ?? "";
	if (local === "") return null;
	return `${local}@${lowered.slice(at + 1)}`;
}

/** The counter key for one person, or null when the address is not one. */
export function trialPersonKey(email: string | null | undefined, secret: string): string | null {
	const normalised = normaliseTrialEmail(email);
	if (normalised === null) return null;
	return `${TRIAL_KEY_PREFIX}person:${keyedDigest("trial-person", normalised, secret)}`;
}

/** The counter key for the network a client address belongs to, or null when it is not an IP address. */
export function trialNetworkKey(ip: string | null | undefined, secret: string): string | null {
	if (!ip) return null;
	const network = networkOf(ip);
	if (network === null) return null;
	return `${TRIAL_KEY_PREFIX}network:${keyedDigest("trial-network", network, secret)}`;
}

/** What the counters for one trial start are built from. */
export interface TrialSubject {
	readonly orgId: string;
	/** The starting person's email address. */
	readonly email: string | null | undefined;
	/** The client address the deployment's edge reported, or null when there is none. */
	readonly clientIp: string | null;
	/** The secret the person and network keys are hashed under. */
	readonly secret: string;
	/** The environment the ceilings' overrides are read from. Defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The person counter alone — what the trial offer peeks at. Throws when the address cannot be keyed:
 * an account with no usable address is refused rather than counted against nothing.
 */
export function personCounter(subject: Omit<TrialSubject, "orgId" | "clientIp">): TrialCounter {
	const key = trialPersonKey(subject.email, subject.secret);
	if (key === null) throw new Error("the account has no email address to count a trial against");
	return {
		key,
		limit: abuseLimit("trial_per_person", subject.env ?? process.env),
		windowDays: trialWindowDays(ABUSE_LIMITS.trial_per_person.window),
		refusal: "trial_person_limit",
	};
}

/**
 * Every counter one trial start must fit under, in the order their refusals are reported: the
 * organization, the person, then the network. The network counter is left out when the request
 * carried no client address — there is no network to count, as with the sign-up ceiling.
 */
export function trialCounters(subject: TrialSubject): TrialCounter[] {
	const counters: TrialCounter[] = [
		{ key: trialOrgKey(subject.orgId), limit: 1, windowDays: null, refusal: "trial_org_used" },
		personCounter(subject),
	];
	const networkKey = trialNetworkKey(subject.clientIp, subject.secret);
	if (networkKey !== null) {
		counters.push({
			key: networkKey,
			limit: abuseLimit("trial_per_network_monthly", subject.env ?? process.env),
			windowDays: trialWindowDays(ABUSE_LIMITS.trial_per_network_monthly.window),
			refusal: "trial_network_limit",
		});
	}
	return counters;
}

/**
 * The first counter that is already full, given how many trials each key has used, or null when the
 * start fits under all of them. A counter is full when its count has reached its limit.
 */
export function firstFullCounter(
	counters: readonly TrialCounter[],
	used: ReadonlyMap<string, number>,
): TrialCounter | null {
	for (const counter of counters) {
		if ((used.get(counter.key) ?? 0) >= counter.limit) return counter;
	}
	return null;
}
