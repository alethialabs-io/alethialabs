// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The live-subscription set (#6426): its members, its guard, and a scan that fails on a new
// hand-written copy of it anywhere in the console's source.
//
// The scan reads source as TEXT. It looks for an array literal (which is also what `new Set([...])`
// takes) holding BOTH the string literals "past_due" and "unpaid": Stripe statuses, since our own
// `billing_status` has no `unpaid`. Its boundary, stated so nobody reads it as wider: a `switch` over
// statuses, a union type, and an SQL `IN (...)` list are not read. Test files are not read either:
// a test enumerates statuses on purpose.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveSubscriptionStatus, LIVE_SUBSCRIPTION_STATUSES } from "@/lib/billing/subscription-status";

const CONSOLE_ROOT = process.cwd();

/** The module that owns the set: the one place its literal may be written. */
const OWNER = "lib/billing/subscription-status.ts";

/**
 * Files allowed to write their own list of Stripe statuses containing both `past_due` and `unpaid`,
 * each with the reason it is a DIFFERENT concept from "live". Empty today: every such list was the
 * live set and now imports it. Checked in both directions: an entry whose file no longer holds such a
 * list fails too, so the ledger cannot outlive its subject.
 */
const DELIBERATELY_DIFFERENT: Readonly<Record<string, string>> = {};

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

/** The bracketed literals in `text` that hold both "past_due" and "unpaid" (either quote style). */
function handWrittenCopies(text: string): string[] {
	const brackets = text.match(/\[[^[\]]*\]/g) ?? [];
	return brackets.filter((b) => /(["'`])past_due\1/.test(b) && /(["'`])unpaid\1/.test(b));
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

describe("the hand-written-copy matcher", () => {
	it("finds a one-line Set, a multi-line array and single quotes", () => {
		expect(handWrittenCopies(`new Set(["active", "trialing", "past_due", "unpaid", "paused"])`)).toHaveLength(1);
		expect(handWrittenCopies(`const X = [\n\t"past_due",\n\t"unpaid",\n];`)).toHaveLength(1);
		expect(handWrittenCopies(`inArray(col, ['unpaid', 'past_due'])`)).toHaveLength(1);
	});

	it("ignores a list without both statuses, and prose without quotes", () => {
		expect(handWrittenCopies(`new Set(["active", "trialing", "past_due"])`)).toEqual([]);
		expect(handWrittenCopies(`// [past_due, unpaid] are both D7's copy`)).toEqual([]);
		expect(handWrittenCopies(`"past_due" === a ? x[0] : "unpaid"`)).toEqual([]);
	});
});

describe("no hand-written copy of the live set (#6426)", () => {
	const files = sourceFiles();
	const found = new Map<string, string[]>();
	for (const file of files) {
		const copies = handWrittenCopies(readFileSync(join(CONSOLE_ROOT, file), "utf8"));
		if (copies.length > 0) found.set(file, copies);
	}

	it("reads the source tree, and sees the owner's own literal (the scan is not blind)", () => {
		expect(files).toContain(OWNER);
		expect(files).toContain("app/server/actions/billing.ts");
		expect(found.get(OWNER)).toHaveLength(1);
	});

	it("finds no copy outside the owning module and the recorded exceptions", () => {
		const unexpected = [...found.keys()].filter((f) => f !== OWNER && !(f in DELIBERATELY_DIFFERENT));
		expect(
			unexpected,
			`Import LIVE_SUBSCRIPTION_STATUSES / isLiveSubscriptionStatus from @/lib/billing/subscription-status instead, ` +
				`or, if the list is deliberately a different concept, record it in DELIBERATELY_DIFFERENT with why.`,
		).toEqual([]);
	});

	it("has no recorded exception whose file no longer holds such a list", () => {
		const stale = Object.keys(DELIBERATELY_DIFFERENT).filter((f) => !found.has(f));
		expect(stale).toEqual([]);
	});
});
