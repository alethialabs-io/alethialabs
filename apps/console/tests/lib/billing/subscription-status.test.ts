// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The live-subscription set (#6426): its members, its guard, and a scan that fails on a new
// hand-written copy of it anywhere in the console's source.
//
// The scan reads source as TEXT. It looks for every array literal (which is also what `new Set([...])`
// takes) holding at least THREE of the five live statuses as string literals. Three, not five, so a
// copy that has already drifted (lost `unpaid`, say) is still caught. Lists that hold three or more of
// them on purpose, because they mean something else, are recorded in DELIBERATELY_DIFFERENT with why.
// Its boundary, stated so nobody reads it as wider: a `switch` over statuses, a union type, and an SQL
// `IN (...)` list are not read, and neither are test files, which enumerate statuses on purpose.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveSubscriptionStatus, LIVE_SUBSCRIPTION_STATUSES } from "@/lib/billing/subscription-status";

const CONSOLE_ROOT = process.cwd();

/** The module that owns the set: the one place its literal may be written. */
const OWNER = "lib/billing/subscription-status.ts";

/** The owner's literal, as the scan reports it. */
const OWNER_KEY = `${OWNER}: active,trialing,past_due,unpaid,paused`;

/** The live statuses, written here independently of the module so the scan does not trust what it checks. */
const LIVE = ["active", "trialing", "past_due", "unpaid", "paused"];

/**
 * Status lists that hold three or more live statuses and are DIFFERENT concepts, keyed
 * `<file>: <members as written>`, one entry per literal. Checked in both directions and by count: a
 * new literal fails, and so does an entry whose literal is gone, so the ledger cannot outlive its
 * subject.
 */
const DELIBERATELY_DIFFERENT: Readonly<Record<string, string>> = {
	"lib/billing/new-org-setup.ts: active,trialing,past_due":
		"PAID_SUBSCRIPTION_STATUSES: a first charge went through. `unpaid` and `paused` are live but not paid.",
	"lib/billing/org-plan-row.ts: active,trialing,past_due":
		"STORED_LIVE_STATUSES: our billing row's `billing_status`, where mapStatus folds `unpaid` into `past_due`.",
	"lib/billing/queries.ts: active,trialing,past_due":
		"LIVE_STATUSES: our billing row's `billing_status`, the statuses under which a subscription holds the row.",
	"lib/db/schema/enums.ts: none,trialing,active,past_due,canceled":
		"the `billing_status` enum itself: every value the row can hold, not a live set.",
	"scripts/set-org-plan.mjs: none,trialing,active,past_due,canceled":
		"the `billing_status` values the operator script accepts: the enum, not a live set.",
};

/** Directories under the console root that are not product source. */
const SKIPPED_DIRS = new Set(["node_modules", ".next", "coverage", "tests", "e2e", "public", ".turbo", "__tests__"]);

/** Every product source file under the console root, as root-relative POSIX paths. */
function sourceFiles(dir: string = CONSOLE_ROOT): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)));
			continue;
		}
		if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
		if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
		out.push(relative(CONSOLE_ROOT, join(dir, entry.name)).split(sep).join("/"));
	}
	return out;
}

/** The bracketed literals in `text` holding three or more live statuses, each as its string members. */
function statusLists(text: string): string[][] {
	const brackets = text.match(/\[[^[\]]*\]/g) ?? [];
	return brackets
		.map((b) => [...b.matchAll(/(["'`])([a-z_]+)\1/g)].map((m) => m[2]))
		.filter((members) => LIVE.filter((s) => members.includes(s)).length >= 3);
}

describe("LIVE_SUBSCRIPTION_STATUSES", () => {
	it("holds exactly ADR 0002 §2's live set", () => {
		expect([...LIVE_SUBSCRIPTION_STATUSES]).toEqual(["active", "trialing", "past_due", "unpaid", "paused"]);
	});

	it.each(["active", "trialing", "past_due", "unpaid", "paused"])("%s is live", (status) => {
		expect(isLiveSubscriptionStatus(status)).toBe(true);
	});

	it.each(["incomplete", "incomplete_expired", "canceled", "none", "", "Active"])("%j is not live", (status) => {
		expect(isLiveSubscriptionStatus(status)).toBe(false);
	});
});

describe("the status-list matcher", () => {
	it("finds a one-line Set, a multi-line array, single quotes and a drifted 3-of-5 copy", () => {
		expect(statusLists(`new Set(["active", "trialing", "past_due", "unpaid", "paused"])`)).toHaveLength(1);
		expect(statusLists(`const X = [\n\t"past_due",\n\t"unpaid",\n\t"paused",\n];`)).toHaveLength(1);
		expect(statusLists(`inArray(col, ['unpaid', 'past_due', 'active'])`)).toHaveLength(1);
		expect(statusLists(`new Set(["active", "trialing", "past_due", "paused"])`)).toEqual([
			["active", "trialing", "past_due", "paused"],
		]);
	});

	it("ignores a list of two live statuses, and prose without quotes", () => {
		expect(statusLists(`new Set(["active", "trialing"])`)).toEqual([]);
		expect(statusLists(`// [active, past_due, unpaid] are all live`)).toEqual([]);
		expect(statusLists(`"past_due" === a ? x[0] : "unpaid"`)).toEqual([]);
	});
});

describe("no hand-written copy of the live set (#6426)", () => {
	const files = sourceFiles();
	const keys: string[] = [];
	for (const file of files) {
		for (const members of statusLists(readFileSync(join(CONSOLE_ROOT, file), "utf8"))) {
			keys.push(`${file}: ${members.join(",")}`);
		}
	}

	it("reads the source tree, and sees the owner's own literal exactly once (the scan is not blind)", () => {
		expect(files).toContain(OWNER);
		expect(files).toContain("app/server/actions/billing.ts");
		expect(keys.filter((k) => k === OWNER_KEY)).toHaveLength(1);
	});

	// On failure: a NEW key is a hand-written copy. Import LIVE_SUBSCRIPTION_STATUSES /
	// isLiveSubscriptionStatus from @/lib/billing/subscription-status instead, or, if the list is
	// deliberately a different concept, record it in DELIBERATELY_DIFFERENT with why. A MISSING key is
	// a recorded exception whose literal is gone: delete the entry.
	it("finds every status list outside the owner recorded in DELIBERATELY_DIFFERENT, and every entry still present, once each", () => {
		const outside = keys.filter((k) => !k.startsWith(`${OWNER}: `)).sort();
		expect(outside).toEqual(Object.keys(DELIBERATELY_DIFFERENT).sort());
	});
});
