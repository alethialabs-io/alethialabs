// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The retention register is only worth having if it cannot drift from what actually runs (#2373).
//
// Three sources have to agree, and before this issue none of them were checked against each other:
//
//   the register        lib/retention/registry.ts        — what we publish
//   the enforcement     lib/db/programmables.sql         — the gc_* functions that delete
//   the accountability  docs/legal/GDPR_ACCOUNTABILITY.md — what a regulator would be shown
//
// The failure this prevents is not a crash. It is the document saying 30 days while the GC runs 90,
// with both looking correct in isolation — and nobody finding out until someone asks for the data
// that was supposed to be gone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RETENTION_DEFAULT_DAYS,
	RETENTION_REGISTRY,
	enforcedRetention,
	retentionEntry,
	unenforcedRetention,
} from "@/lib/retention/registry";
import { registryIsWellFormed } from "@/lib/retention/health";

const ROOT = join(process.cwd(), "..", "..");
const PROGRAMMABLES = readFileSync(
	join(process.cwd(), "lib/db/programmables.sql"),
	"utf8",
);
const ACCOUNTABILITY = readFileSync(
	join(ROOT, "docs/legal/GDPR_ACCOUNTABILITY.md"),
	"utf8",
);

/** Every `gc_*` function the database actually defines. */
function definedGcFunctions(): string[] {
	const out = new Set<string>();
	const re = /CREATE OR REPLACE FUNCTION public\.(gc_\w+)/g;
	let m = re.exec(PROGRAMMABLES);
	while (m) {
		out.add(m[1]);
		m = re.exec(PROGRAMMABLES);
	}
	return [...out].sort();
}

describe("the register is well formed", () => {
	it("gives every entry an id, a subject and evidence", () => {
		expect(RETENTION_REGISTRY.length).toBeGreaterThan(4);
		const ids = new Set<string>();
		for (const e of RETENTION_REGISTRY) {
			expect(e.id).toBeTruthy();
			expect(ids.has(e.id)).toBe(false);
			ids.add(e.id);
			expect(e.subject.length).toBeGreaterThan(10);
			// Evidence is what separates this from a list of numbers someone typed.
			expect(e.evidence.length).toBeGreaterThan(40);
		}
	});

	// A claim of enforcement that cannot name what enforces it is exactly the "policy-only promise"
	// this register replaces — so the type allows it and the test does not.
	it("lets only a gc-function entry claim enforcement, and makes it name one", () => {
		for (const e of RETENTION_REGISTRY) {
			if (e.mechanism === "gc-function") {
				expect(e.gcFunction).toBeTruthy();
				expect(e.windowDays).not.toBeNull();
				expect(e.table).toBeTruthy();
			} else {
				expect(e.gcFunction).toBeNull();
			}
		}
		expect(registryIsWellFormed()).toBe(true);
	});

	// An unenforced promise must say what would close it, in the form the accountability record uses.
	// Without this the register becomes a place to park things, which is the document it replaced.
	it("makes every unenforced promise name the evidence that would close it", () => {
		const open = unenforcedRetention();
		expect(open.length).toBeGreaterThan(0);
		for (const e of open) {
			expect(/NOT ESTABLISHED — requires/.test(e.evidence)).toBe(true);
		}
	});
});

describe("the register agrees with the database", () => {
	// THE join. A new gc_* function is a new automated deletion — a change to what the product
	// promises — and it must not be possible to ship one without saying so.
	it("registers every gc_* function the database defines", () => {
		const defined = definedGcFunctions();
		expect(defined.length).toBeGreaterThan(2);
		const registered = new Set(
			RETENTION_REGISTRY.map((e) => e.gcFunction).filter(Boolean),
		);
		const unregistered = defined.filter((fn) => !registered.has(fn));
		if (unregistered.length > 0) {
			throw new Error(
				`programmables.sql defines ${unregistered.join(", ")}, which the retention register ` +
					`does not mention. A new gc_* function deletes customer data on a schedule — that is a ` +
					`change to what this product promises, so it needs an entry in ` +
					`lib/retention/registry.ts saying what it removes and when.`,
			);
		}
		expect(unregistered).toEqual([]);
	});

	it("names only functions that exist", () => {
		const defined = new Set(definedGcFunctions());
		for (const e of enforcedRetention()) {
			expect(defined.has(e.gcFunction ?? "")).toBe(true);
		}
	});

	// The SQL default and the register must match. They are separately editable, and a mismatch means
	// an operator who never sets the env var gets a window nobody published.
	it("matches each function's own SQL default window", () => {
		const expectations: Record<string, number> = {
			gc_job_logs: RETENTION_DEFAULT_DAYS.jobLogs,
			gc_fleet_actions: RETENTION_DEFAULT_DAYS.fleetActions,
			gc_authz_activity_log: RETENTION_DEFAULT_DAYS.authzActivity,
		};
		for (const [fn, days] of Object.entries(expectations)) {
			const decl = PROGRAMMABLES.slice(
				PROGRAMMABLES.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`),
			).slice(0, 400);
			const m = decl.match(/INTERVAL '(\d+) days'/);
			expect(m).toBeTruthy();
			expect(Number(m?.[1])).toBe(days);
		}
	});
});

describe("the register agrees with the accountability record", () => {
	// The document is what a regulator is shown. If it and the code disagree, the document is the
	// one that gets read — so a window that changes in code must change there too.
	it("publishes the same window for every enforced entry", () => {
		for (const e of enforcedRetention()) {
			if (!e.gcFunction || e.windowDays === null) continue;
			const line = ACCOUNTABILITY.split("\n").find((l) => l.includes(`\`${e.gcFunction}\``));
			expect(line).toBeTruthy();
			const stated = line?.match(/(\d+)\s*days?/);
			expect(stated).toBeTruthy();
			expect(Number(stated?.[1])).toBe(e.windowDays);
		}
	});
});

describe("lookups", () => {
	it("finds an entry by id and returns null for an unknown one", () => {
		expect(retentionEntry("job-logs")?.table).toBe("job_logs");
		expect(retentionEntry("not-a-thing")).toBeNull();
	});
});
