// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse ceilings table (REL-S3, #6775): override parsing, the table's own invariants, and the
// docs JSON staying in step with it. The drift case is the one that matters most — it is the only
// thing that stops the docs limits page from quoting a number the console no longer enforces.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	ABUSE_LIMIT_KEYS,
	ABUSE_LIMITS,
	abuseLimit,
	parseAbuseLimitOverride,
} from "@/lib/abuse/limits";
import { OUT, renderAbuseLimits } from "../../../scripts/gen-abuse-limits.mjs";

describe("parseAbuseLimitOverride", () => {
	it("floors a positive number", () => {
		expect(parseAbuseLimitOverride("40")).toBe(40);
		expect(parseAbuseLimitOverride("7.9")).toBe(7);
		expect(parseAbuseLimitOverride(" 12 ")).toBe(12);
	});

	it("ignores unset, blank, zero, negative, fractional-below-one and non-numeric values", () => {
		for (const raw of [undefined, "", "   ", "0", "-3", "0.5", "abc", "Infinity", "NaN"]) {
			expect(parseAbuseLimitOverride(raw)).toBeNull();
		}
	});
});

describe("abuseLimit", () => {
	it("returns the default when the override is absent", () => {
		expect(abuseLimit("free_daily_jobs", {})).toBe(25);
		expect(abuseLimit("repository_size_mb", {})).toBe(500);
	});

	it("uses a valid override read from the row's own variable", () => {
		expect(abuseLimit("free_daily_jobs", { ALETHIA_FREE_DAILY_JOB_QUOTA: "40" })).toBe(40);
		expect(abuseLimit("scans_per_org_daily", { ALETHIA_SCANS_PER_ORG_DAILY: "3" })).toBe(3);
	});

	it("does not read another row's variable", () => {
		expect(abuseLimit("scans_per_org_daily", { ALETHIA_FREE_DAILY_JOB_QUOTA: "3" })).toBe(
			ABUSE_LIMITS.scans_per_org_daily.defaultValue,
		);
	});

	it("keeps the default when the override is zero — a ceiling is not a kill switch", () => {
		expect(abuseLimit("signup_accounts_per_network_daily", { ALETHIA_SIGNUP_ACCOUNTS_PER_NETWORK_DAILY: "0" })).toBe(
			ABUSE_LIMITS.signup_accounts_per_network_daily.defaultValue,
		);
	});
});

describe("ABUSE_LIMITS", () => {
	it("lists every row exactly once in ABUSE_LIMIT_KEYS", () => {
		expect([...ABUSE_LIMIT_KEYS].sort()).toEqual(Object.keys(ABUSE_LIMITS).sort());
		expect(new Set(ABUSE_LIMIT_KEYS).size).toBe(ABUSE_LIMIT_KEYS.length);
	});

	it("gives every row a matching key, a positive integer default and a unique ALETHIA_ variable", () => {
		const envs = new Set<string>();
		for (const key of ABUSE_LIMIT_KEYS) {
			const row = ABUSE_LIMITS[key];
			expect(row.key).toBe(key);
			expect(Number.isInteger(row.defaultValue) && row.defaultValue > 0).toBe(true);
			expect(row.env).toMatch(/^ALETHIA_[A-Z0-9_]+$/);
			envs.add(row.env);
			expect(row.description.length).toBeGreaterThan(0);
			expect(row.whenReached.length).toBeGreaterThan(0);
		}
		expect(envs.size).toBe(ABUSE_LIMIT_KEYS.length);
	});

	it("job-quota.ts reads the free job cap from this table and keeps no copy of its own", () => {
		// REL-L11 (#6912) removed job-quota.ts's DEFAULT_FREE_DAILY_JOB_QUOTA and its own env parse.
		// A second copy is how the docs page and the enforcement drift apart, so its return fails here.
		const src = readFileSync(path.resolve(__dirname, "../../../lib/billing/job-quota.ts"), "utf8");
		expect(src).toContain(`abuseLimit("free_daily_jobs")`);
		expect(src).not.toMatch(/DEFAULT_FREE_DAILY_JOB_QUOTA/);
		expect(src).not.toMatch(/process\.env\./);
		expect(src).not.toMatch(/=\s*25\b/);
	});
});

describe("gen-abuse-limits.mjs", () => {
	it("the committed docs JSON is what the generator writes for this table", () => {
		const committed = readFileSync(OUT, "utf8");
		expect(committed).toBe(renderAbuseLimits(ABUSE_LIMITS, ABUSE_LIMIT_KEYS));
	});

	it("writes defaults, never the running environment", () => {
		const doc: unknown = JSON.parse(renderAbuseLimits(ABUSE_LIMITS, ABUSE_LIMIT_KEYS));
		expect(doc).toMatchObject({
			schemaVersion: 1,
			limits: ABUSE_LIMIT_KEYS.map((key) => ({ key, default: ABUSE_LIMITS[key].defaultValue })),
		});
	});

	it("refuses a table whose keys and key list disagree", () => {
		expect(() => renderAbuseLimits(ABUSE_LIMITS, ABUSE_LIMIT_KEYS.slice(1))).toThrow(/list different ceilings/);
	});

	it("refuses a row whose key does not match its position", () => {
		const table = { ...ABUSE_LIMITS, trial_per_person: { ...ABUSE_LIMITS.trial_per_person, key: "free_daily_jobs" } };
		expect(() => renderAbuseLimits(table, ABUSE_LIMIT_KEYS)).toThrow(/carries key/);
	});

	it("refuses a non-positive default", () => {
		const table = { ...ABUSE_LIMITS, free_daily_jobs: { ...ABUSE_LIMITS.free_daily_jobs, defaultValue: 0 } };
		expect(() => renderAbuseLimits(table, ABUSE_LIMIT_KEYS)).toThrow(/positive integer/);
	});
});
