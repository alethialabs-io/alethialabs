// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — recordAddonHealth stamps `first_observed_running_at` only on a running read, through a
// COALESCE that keeps the first stamp, and leaves the column out of every other update — so a drift
// scan's Unknown (an Application it cannot find, as after a re-provision) never erases the history.
// The real-Postgres half is tests/integration/byo-admission-setting.test.ts.

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sets: [] as Record<string, unknown>[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		update: () => ({
			set: (values: Record<string, unknown>) => {
				h.sets.push(values);
				return { where: async () => undefined };
			},
		}),
	}),
}));

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { recordAddonHealth } from "@/lib/addons/inspection-persistence";

describe("recordAddonHealth — first_observed_running_at (#6541)", () => {
	it("stamps it, through COALESCE, on a running read", async () => {
		h.sets.length = 0;
		await recordAddonHealth("p", "e", { "addon-shop": { health: "Healthy", sync: "Synced" } });
		const stamp = h.sets[0]?.first_observed_running_at;
		if (!(stamp instanceof SQL)) throw new Error("first_observed_running_at was not stamped through SQL");
		const query = new PgDialect().sqlToQuery(stamp);
		expect(query.sql).toMatch(/^coalesce\("project_addons"\."first_observed_running_at", \$1::timestamptz\)$/);
		// A raw template parameter skips the column's Date mapping, and postgres-js refuses to
		// serialize a Date there ("The string argument must be of type string… Received an instance
		// of Date"). The bound value must already be the ISO string.
		expect(query.params).toHaveLength(1);
		expect(typeof query.params[0]).toBe("string");
		expect(Number.isNaN(Date.parse(String(query.params[0])))).toBe(false);
	});

	it("leaves it out of the update for Unknown and Missing, so it is never cleared", async () => {
		h.sets.length = 0;
		await recordAddonHealth("p", "e", {
			"addon-a": { health: "Unknown", sync: "Unknown" },
			"addon-b": { health: "Missing", sync: "OutOfSync" },
		});
		expect(h.sets).toHaveLength(2);
		for (const set of h.sets) expect("first_observed_running_at" in set).toBe(false);
	});
});
