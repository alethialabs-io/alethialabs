// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: Better Auth's built-in, DB-backed rate limiter on /api/auth/*.
// Proves the brute-force throttle actually fires and PERSISTS its counter in the
// rate_limit table (so it's replica-consistent, not the per-process in-memory
// limiter). Two halves:
//   1. Config assertions — the REAL auth instance (@/lib/auth) is wired with
//      storage:"database", enabled, and the strict OTP customRules. Runs without a DB.
//   2. Behavioural proof (describeIfDb) — drive a Better Auth handler built from the
//      SAME getAuthRateLimit() policy against real Postgres: N rapid POSTs to
//      /sign-in/email-otp get throttled (429) after the rule's max, the counter lands
//      in rate_limit, and a single legitimate OTP-send is NOT throttled.
//
// The behavioural half drives a dedicated betterAuth() instance (identical adapter +
// rateLimit policy) rather than the app `auth`, because the app instance's nextCookies
// plugin reaches for next/headers, which has no request scope under vitest. The policy
// object is asserted to be identical, so this exercises the exact production policy.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { getAuthRateLimit } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { account, rateLimit, session, user, verification } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// ── 1. Config wiring (no DB needed) ──────────────────────────────────────────

describe("auth rate-limit config", () => {
	it("the real auth instance is DB-backed + enabled with strict OTP customRules", () => {
		const rl = auth.options.rateLimit;
		expect(rl).toBeDefined();
		// DB-backed ⇒ counters shared across replicas / survive restarts.
		expect(rl?.storage).toBe("database");
		// Forced on in every env (Better Auth otherwise only enforces in production).
		expect(rl?.enabled).toBe(true);
		// The brute-force-sensitive paths carry stricter buckets than the global.
		expect(rl?.customRules?.["/sign-in/email-otp"]).toEqual({ window: 60, max: 5 });
		expect(rl?.customRules?.["/email-otp/send-verification-otp"]).toEqual({
			window: 60,
			max: 5,
		});
		expect(rl?.customRules?.["/email-otp/verify-email"]).toEqual({ window: 60, max: 5 });
	});

	it("keys the limiter on the trusted client IP (cf-connecting-ip), not spoofable X-Forwarded-For", () => {
		// Without this, Better Auth keys on the leftmost XFF, which is attacker-controlled behind
		// Cloudflare → the throttle is bypassable by rotating the header. Regression guard for that fix.
		expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
	});

	it("the driven policy is the exact production policy (getAuthRateLimit)", () => {
		expect(auth.options.rateLimit).toEqual(getAuthRateLimit());
	});
});

// ── 2. Behavioural proof against real Postgres ───────────────────────────────

// A Better Auth handler built from the SAME rate-limit policy + a real drizzle
// adapter, so the check-and-increment runs through the database storage wrapper.
const testAuth = betterAuth({
	secret: "test-secret-auth-rate-limit",
	baseURL: "http://localhost:3000",
	database: drizzleAdapter(getServiceDb(), {
		provider: "pg",
		schema: { user, session, account, verification, rateLimit },
	}),
	advanced: { database: { generateId: "uuid" } },
	emailAndPassword: { enabled: false },
	plugins: [
		emailOTP({
			otpLength: 6,
			expiresIn: 600,
			// No-op: the test never needs a real code delivered.
			async sendVerificationOTP() {},
		}),
	],
	rateLimit: getAuthRateLimit(),
});

/** POST an /api/auth/* path through the test handler, returning the HTTP status. */
async function hit(path: string, body: unknown): Promise<number> {
	const res = await testAuth.handler(
		new Request(`http://localhost:3000/api/auth${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return res.status;
}

// Better Auth keys the bucket as `${ip}|${normalizedPath}`. The IP prefix varies by
// runtime (e.g. "127.0.0.1" under vitest, "no-trusted-ip" when no client IP resolves),
// so scenarios match on the normalized-path suffix rather than a hardcoded IP.
const SIGN_IN_KEY_LIKE = "%|/sign-in/email-otp";
const SEND_KEY_LIKE = "%|/email-otp/send-verification-otp";

describeIfDb("auth rate-limit (DB-backed throttle)", () => {
	const db = getServiceDb();

	/** Rows in the rate_limit table whose key ends with the given normalized path. */
	async function rowsForPath(pathLike: string) {
		return db.select().from(rateLimit).where(like(rateLimit.key, pathLike));
	}

	beforeEach(async () => {
		// Isolate each scenario from prior rows for the same bucket.
		await db.delete(rateLimit).where(like(rateLimit.key, SIGN_IN_KEY_LIKE));
		await db.delete(rateLimit).where(like(rateLimit.key, SEND_KEY_LIKE));
	});

	afterAll(async () => {
		await db.delete(rateLimit).where(like(rateLimit.key, SIGN_IN_KEY_LIKE));
		await db.delete(rateLimit).where(like(rateLimit.key, SEND_KEY_LIKE));
	});

	it("throttles rapid OTP-verify hits (429 after max=5) and persists the counter", async () => {
		// The /sign-in/email-otp customRule allows 5 per 60s. Fire 6 with a bogus code.
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			statuses.push(
				await hit("/sign-in/email-otp", { email: "attacker@example.com", otp: "000000" }),
			);
		}

		// First 5 are let through to the handler (which rejects the bogus code); the 6th
		// is blocked by the rate limiter itself.
		expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
		expect(statuses[5]).toBe(429);

		// The counter is DB-backed: exactly one row for the bucket, count clamped at max.
		const rows = await rowsForPath(SIGN_IN_KEY_LIKE);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(5);
		expect(typeof rows[0].lastRequest).toBe("number");
		expect(rows[0].lastRequest).toBeGreaterThan(0);
	});

	it("does NOT throttle a single legitimate OTP-send", async () => {
		const status = await hit("/email-otp/send-verification-otp", {
			email: "user@example.com",
		});
		// A lone request is well under the max=3 send rule — never a 429.
		expect(status).not.toBe(429);

		const rows = await rowsForPath(SEND_KEY_LIKE);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(1);
	});
});
