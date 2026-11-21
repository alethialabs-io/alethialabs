// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// REL-L10 (#6911): the decision on whether a new account may be created. Every control is shown
// refusing on TWO fixture values (spec 6 L10), so a check hard-wired to the first one fails here.
// The database and the request are injected; the counter below is a faithful in-memory stand-in for
// the bucket table (a refused hit is not counted).

import { describe, expect, it, vi } from "vitest";
import { ABUSE_LIMITS, abuseLimit } from "@/lib/abuse/limits";
import { SIGNUP_DISPOSABLE_EMAIL, SIGNUP_NETWORK_LIMIT } from "@/lib/auth/signup-guard/codes";
import { checkNewAccount, type SignupGuardDeps } from "@/lib/auth/signup-guard/guard";
import { networkOf, SIGNUP_NETWORK_KEY_PREFIX, signupNetworkKey } from "@/lib/auth/signup-guard/network";

const SECRET = "test-secret-test-secret-test-secret-0123";

/** A request context whose trusted client address is `ip`. */
function fromIp(ip: string, path = "/sign-in/email-otp") {
	return { path, headers: new Headers({ "cf-connecting-ip": ip }) };
}

/** Injected deps with an in-memory counter and a configurable invitation list. */
function makeDeps(opts: { invited?: string[]; env?: Record<string, string | undefined> } = {}) {
	const counts = new Map<string, number>();
	const countSignupForNetwork = vi.fn(async (key: string, limit: number) => {
		const n = counts.get(key) ?? 0;
		if (n >= limit) return false;
		counts.set(key, n + 1);
		return true;
	});
	const hasPendingInvitation = vi.fn(async (email: string) => (opts.invited ?? []).includes(email));
	const deps: SignupGuardDeps = {
		clientIp: (h) => h.get("cf-connecting-ip"),
		secret: SECRET,
		hasPendingInvitation,
		countSignupForNetwork,
		env: opts.env ?? {},
	};
	return { deps, countSignupForNetwork, hasPendingInvitation };
}

/** Creates `n` accounts from `ip` and returns the last answer. */
async function signUps(n: number, ip: string, deps: SignupGuardDeps, domain = "example.com") {
	let last = null;
	for (let i = 0; i < n; i++) {
		last = await checkNewAccount(`person${i}@${domain}`, fromIp(ip), deps);
	}
	return last;
}

describe("the ceiling it reads", () => {
	it("is the table's row, counted per UTC day — the window store.ts counts in", () => {
		const row = ABUSE_LIMITS.signup_accounts_per_network_daily;
		expect(row.enforcedBy).toBe("REL-L10");
		expect(row.window).toBe("utc-day");
	});
});

describe("temporary-inbox refusal", () => {
	it.each(["someone@mailinator.com", "Other.Person@YOPMAIL.com"])("refuses %s", async (email) => {
		const { deps, countSignupForNetwork } = makeDeps();
		expect(await checkNewAccount(email, fromIp("198.51.100.4"), deps)).toEqual({
			code: SIGNUP_DISPOSABLE_EMAIL,
		});
		// A refused address spends none of the network's slots.
		expect(countSignupForNetwork).not.toHaveBeenCalled();
	});

	it.each(["dev@acme.io", "ops@example.org"])("allows a permanent address (%s)", async (email) => {
		const { deps } = makeDeps();
		expect(await checkNewAccount(email, fromIp("198.51.100.4"), deps)).toBeNull();
	});

	it("allows a temporary-inbox address an organization invited", async () => {
		const { deps } = makeDeps({ invited: ["contractor@mailinator.com"] });
		expect(await checkNewAccount("contractor@mailinator.com", fromIp("198.51.100.4"), deps)).toBeNull();
	});
});

describe("per-network daily ceiling", () => {
	const limit = abuseLimit("signup_accounts_per_network_daily", {});

	it.each(["198.51.100.7", "2001:db8:1:2::9"])(
		"admits the table's number of accounts from %s, then refuses the next",
		async (ip) => {
			const { deps } = makeDeps();
			expect(await signUps(limit, ip, deps)).toBeNull();
			expect(await checkNewAccount("one-more@example.com", fromIp(ip), deps)).toEqual({
				code: SIGNUP_NETWORK_LIMIT,
			});
		},
	);

	it.each([
		["3", 3],
		["7", 7],
	])("follows the operator override %s", async (raw, n) => {
		const { deps } = makeDeps({ env: { [ABUSE_LIMITS.signup_accounts_per_network_daily.env]: raw } });
		expect(await signUps(n, "203.0.113.20", deps)).toBeNull();
		expect(await checkNewAccount("next@example.com", fromIp("203.0.113.20"), deps)).toEqual({
			code: SIGNUP_NETWORK_LIMIT,
		});
	});

	it("counts each network on its own", async () => {
		const { deps } = makeDeps();
		await signUps(limit, "198.51.100.7", deps);
		expect(await checkNewAccount("a@example.com", fromIp("198.51.100.8"), deps)).toBeNull();
	});

	it("counts a whole IPv6 /64 as one network", async () => {
		const { deps } = makeDeps();
		await signUps(limit, "2001:db8:aa:bb::1", deps);
		expect(await checkNewAccount("x@example.com", fromIp("2001:db8:aa:bb:ffff::2"), deps)).toEqual({
			code: SIGNUP_NETWORK_LIMIT,
		});
		// A different /64 is a different network.
		expect(await checkNewAccount("y@example.com", fromIp("2001:db8:aa:bc::1"), deps)).toBeNull();
	});

	it("does not count an invited address", async () => {
		const { deps, countSignupForNetwork } = makeDeps({ invited: ["teammate@acme.io"] });
		await signUps(limit, "198.51.100.30", deps);
		countSignupForNetwork.mockClear();
		expect(await checkNewAccount("teammate@acme.io", fromIp("198.51.100.30"), deps)).toBeNull();
		expect(countSignupForNetwork).not.toHaveBeenCalled();
	});

	it.each(["/sso/callback/acme", "/sso/saml2/sp/acs/acme"])("does not count enterprise SSO (%s)", async (path) => {
		const { deps, countSignupForNetwork } = makeDeps();
		await signUps(limit, "198.51.100.40", deps);
		countSignupForNetwork.mockClear();
		expect(await checkNewAccount("emp@acme.io", fromIp("198.51.100.40", path), deps)).toBeNull();
		expect(countSignupForNetwork).not.toHaveBeenCalled();
	});

	it("does not count a creation with no request behind it, or one with no client address", async () => {
		const { deps, countSignupForNetwork } = makeDeps();
		expect(await checkNewAccount("a@example.com", null, deps)).toBeNull();
		expect(await checkNewAccount("b@example.com", { path: "/sign-in/email-otp" }, deps)).toBeNull();
		expect(countSignupForNetwork).not.toHaveBeenCalled();
	});

	it("still refuses a temporary inbox when there is no client address", async () => {
		const { deps } = makeDeps();
		expect(await checkNewAccount("a@mailinator.com", { path: "/sign-in/email-otp" }, deps)).toEqual({
			code: SIGNUP_DISPOSABLE_EMAIL,
		});
	});
});

describe("the network key", () => {
	it.each([
		["198.51.100.7", "v4:198.51.100.7"],
		["::ffff:198.51.100.7", "v4:198.51.100.7"],
		["2001:db8:1:2:3:4:5:6", "v6:2001:db8:1:2"],
		["2001:DB8::1", "v6:2001:db8:0:0"],
		["::1", "v6:0:0:0:0"],
	])("reads %s as %s", (ip, network) => {
		expect(networkOf(ip)).toBe(network);
	});

	it.each(["", "not-an-ip", "300.1.1.1"])("has no network for %j", (ip) => {
		expect(networkOf(ip)).toBeNull();
		expect(signupNetworkKey(ip, SECRET)).toBeNull();
	});

	it.each(["198.51.100.7", "2001:db8:1:2::9"])("never carries the address itself (%s)", (ip) => {
		const key = signupNetworkKey(ip, SECRET);
		expect(key).toMatch(new RegExp(`^${SIGNUP_NETWORK_KEY_PREFIX}[0-9a-f]{32}$`));
		expect(key).not.toContain(ip);
		// Keyed: another deployment's secret gives another key for the same network.
		expect(signupNetworkKey(ip, `${SECRET}-other`)).not.toBe(key);
	});
});
