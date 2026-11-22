// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The trial ceilings' pure half (lib/billing/trial/ceilings.ts, REL-L19 #6907): which counters a
// trial start must fit under, the keys they are counted under, and the numbers they read from the
// REL-S3 table. The table is imported for real — a copy of a number in this file would agree with the
// enforcement by construction and prove nothing.

import { describe, expect, it } from "vitest";
import { ABUSE_LIMITS } from "@/lib/abuse/limits";
import {
	firstFullCounter,
	normaliseTrialEmail,
	TRIAL_REFUSAL_MESSAGES,
	trialCounters,
	trialNetworkKey,
	trialOrgKey,
	trialPersonKey,
	trialWindowDays,
} from "@/lib/billing/trial/ceilings";

const SECRET = "unit-secret";
const base = { orgId: "org-1", email: "Ada@Example.test", clientIp: "198.51.100.7", secret: SECRET, env: {} };

describe("the trial counters", () => {
	it("are the organization, the person and the network, in that order", () => {
		const counters = trialCounters(base);
		expect(counters.map((c) => c.refusal)).toEqual(["trial_org_used", "trial_person_limit", "trial_network_limit"]);
	});

	it("allow ONE trial per organization, for its lifetime, whatever the environment says", () => {
		const [org] = trialCounters({ ...base, env: { ALETHIA_TRIAL_PER_PERSON: "9", ALETHIA_TRIAL_PER_NETWORK_MONTHLY: "9" } });
		expect(org).toMatchObject({ key: "trial:org:org-1", limit: 1, windowDays: null });
	});

	it("read the per-person and per-network numbers and windows from the REL-S3 table", () => {
		const [, person, network] = trialCounters(base);
		expect(person?.limit).toBe(ABUSE_LIMITS.trial_per_person.defaultValue);
		expect(person?.windowDays).toBe(trialWindowDays(ABUSE_LIMITS.trial_per_person.window));
		expect(network?.limit).toBe(ABUSE_LIMITS.trial_per_network_monthly.defaultValue);
		expect(network?.windowDays).toBe(trialWindowDays(ABUSE_LIMITS.trial_per_network_monthly.window));
	});

	it("honour the table's environment overrides", () => {
		const env = {
			[ABUSE_LIMITS.trial_per_person.env]: "2",
			[ABUSE_LIMITS.trial_per_network_monthly.env]: "7",
		};
		const [, person, network] = trialCounters({ ...base, env });
		expect(person?.limit).toBe(2);
		expect(network?.limit).toBe(7);
	});

	it("leave the network out when the request carried no client address", () => {
		expect(trialCounters({ ...base, clientIp: null }).map((c) => c.refusal)).toEqual([
			"trial_org_used",
			"trial_person_limit",
		]);
		expect(trialCounters({ ...base, clientIp: "not-an-ip" })).toHaveLength(2);
	});

	it("refuse to build a person counter for an account with no usable address", () => {
		expect(() => trialCounters({ ...base, email: null })).toThrow(/no email address/);
		expect(() => trialCounters({ ...base, email: "nobody" })).toThrow(/no email address/);
	});
});

describe("the windows the store can count", () => {
	it("are lifetime and trailing 30 days — the two the trial rows use", () => {
		expect(trialWindowDays("lifetime")).toBeNull();
		expect(trialWindowDays("trailing-30d")).toBe(30);
		expect(() => trialWindowDays("utc-day")).toThrow(/cannot count/);
	});

	it("cover every trial row in the table, so a table edit cannot silently change what a row means", () => {
		for (const row of Object.values(ABUSE_LIMITS).filter((r) => r.surface === "trial")) {
			expect(() => trialWindowDays(row.window)).not.toThrow();
			expect(row.enforcedBy).toBe("REL-L19");
		}
	});
});

describe("the keys", () => {
	it("hold no raw address or network", () => {
		const person = trialPersonKey("ada@example.test", SECRET);
		const network = trialNetworkKey("198.51.100.7", SECRET);
		expect(person).toMatch(/^trial:person:[0-9a-f]{32}$/);
		expect(network).toMatch(/^trial:network:[0-9a-f]{32}$/);
		expect(person).not.toContain("ada");
		expect(network).not.toContain("198.51");
	});

	it("depend on the deployment secret", () => {
		expect(trialPersonKey("ada@example.test", "a")).not.toBe(trialPersonKey("ada@example.test", "b"));
		expect(trialNetworkKey("198.51.100.7", "a")).not.toBe(trialNetworkKey("198.51.100.7", "b"));
	});

	it("are separated from each other and from the sign-up network key", () => {
		const network = trialNetworkKey("198.51.100.7", SECRET) ?? "";
		expect(network.startsWith("signup:")).toBe(false);
		expect(trialOrgKey("x")).toBe("trial:org:x");
	});

	it("count one person under one key however the address is written", () => {
		const k = trialPersonKey("ada@example.test", SECRET);
		expect(trialPersonKey("  ADA@Example.TEST ", SECRET)).toBe(k);
		expect(trialPersonKey("ada+trial@example.test", SECRET)).toBe(k);
		expect(trialPersonKey("bob@example.test", SECRET)).not.toBe(k);
	});

	it("count an IPv6 /64 as one network, and a mapped IPv4 address as that address", () => {
		expect(trialNetworkKey("2001:db8:1:2::1", SECRET)).toBe(trialNetworkKey("2001:db8:1:2:ffff::9", SECRET));
		expect(trialNetworkKey("2001:db8:1:3::1", SECRET)).not.toBe(trialNetworkKey("2001:db8:1:2::1", SECRET));
		expect(trialNetworkKey("::ffff:198.51.100.7", SECRET)).toBe(trialNetworkKey("198.51.100.7", SECRET));
		expect(trialNetworkKey(null, SECRET)).toBeNull();
	});
});

describe("normaliseTrialEmail", () => {
	it("rejects what is not local@domain", () => {
		expect(normaliseTrialEmail(undefined)).toBeNull();
		expect(normaliseTrialEmail("@example.test")).toBeNull();
		expect(normaliseTrialEmail("ada@")).toBeNull();
		expect(normaliseTrialEmail("+tag@example.test")).toBeNull();
		expect(normaliseTrialEmail("Ada@Example.test")).toBe("ada@example.test");
	});
});

describe("firstFullCounter", () => {
	const counters = trialCounters({ ...base, env: { [ABUSE_LIMITS.trial_per_network_monthly.env]: "3" } });
	const [org, person, network] = counters;
	if (!org || !person || !network) throw new Error("fixture: expected three counters");

	it("admits a start that fits under every counter", () => {
		expect(firstFullCounter(counters, new Map([[network.key, 2]]))).toBeNull();
	});

	it("names the first full counter in order, so the organization's refusal wins over the network's", () => {
		expect(firstFullCounter(counters, new Map([[network.key, 3]]))?.refusal).toBe("trial_network_limit");
		expect(firstFullCounter(counters, new Map([[person.key, 1], [network.key, 3]]))?.refusal).toBe("trial_person_limit");
		expect(firstFullCounter(counters, new Map([[org.key, 1], [person.key, 1]]))?.refusal).toBe("trial_org_used");
	});

	it("states what is still possible in every refusal", () => {
		for (const message of Object.values(TRIAL_REFUSAL_MESSAGES)) {
			expect(message).toMatch(/still subscribe/);
		}
	});
});
