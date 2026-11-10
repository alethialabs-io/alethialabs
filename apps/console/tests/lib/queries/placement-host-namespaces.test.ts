// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// placementHostNamespaces (#6551): the namespaces a Fabric's host uses for its own BYO charts. Driven
// over a recording db: the rows it returns are what the query would read, and the predicate it built
// is rendered to SQL so the filter — BYO charts, of THIS project's `dedicated` environments on THIS
// Fabric — is asserted rather than assumed.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { projectAddons, projectEnvironments } from "@/lib/db/schema";
import {
	placementHostNamespaces,
	placementNamespacesOnFabric,
} from "@/lib/queries/placement-host-namespaces";

/** A db whose select chains record their table and predicate; the addon read answers `rows`. */
function recordingDb(rows: { namespace: string | null; name?: string }[], envRows: unknown[] = []) {
	const seen: { table: unknown; where: SQL | undefined }[] = [];
	const db = {
		select: () => ({
			from: (table: unknown) => ({
				where: (where: SQL) => {
					seen.push({ table, where });
					const result = table === projectAddons ? rows : envRows;
					return Object.assign(Promise.resolve(result), { getSQL: () => where });
				},
			}),
		}),
	};
	return { db, seen };
}

/** The predicate a recorded select ran with, as SQL text and params. */
function rendered(where: SQL | undefined) {
	if (!where) throw new Error("no predicate");
	return new PgDialect().sqlToQuery(where);
}

describe("placementHostNamespaces", () => {
	it("returns the chosen namespaces, trimmed, distinct and sorted", async () => {
		const { db } = recordingDb([
			{ namespace: " payments " },
			{ namespace: "ledger" },
			{ namespace: "payments" },
			{ namespace: "" },
			{ namespace: null },
		]);
		// @ts-expect-error — a recording fake, not a drizzle Db; only the chain the query uses exists.
		expect(await placementHostNamespaces(db, "p1", "f1")).toEqual(["ledger", "payments"]);
	});

	it("reads BYO charts of the project's DEDICATED environments on THIS Fabric", async () => {
		const { db, seen } = recordingDb([]);
		// @ts-expect-error — a recording fake, not a drizzle Db.
		await placementHostNamespaces(db, "p1", "f1");
		const hosts = seen.find((s) => s.table === projectEnvironments);
		const addons = seen.find((s) => s.table === projectAddons);
		const h = rendered(hosts?.where);
		expect(h.sql).toMatch(/"project_id" = \$1 and .*"fabric_id" = \$2 and .*"placement_mode" = \$3/);
		expect(h.params).toEqual(["p1", "f1", "dedicated"]);
		const a = rendered(addons?.where);
		expect(a.sql).toMatch(/"source" = \$2/);
		expect(a.sql).toMatch(/"namespace" is not null/);
		// The host environments are a SUBQUERY of the addon read (this fake renders a subquery as its
		// predicate), so the chart rows are bound to exactly the host set asserted above.
		expect(a.sql).toMatch(/"environment_id" in \(\("project_environments"\."project_id" = \$3 and "project_environments"\."fabric_id" = \$4/);
		expect(a.params).toEqual(["p1", "byo", "p1", "f1", "dedicated"]);
	});
});

describe("placementNamespacesOnFabric", () => {
	it("returns each live namespace placement on THIS Fabric with the namespace it resolves to", async () => {
		const { db, seen } = recordingDb([], [
			{ name: "preview", namespace: "preview" },
			{ name: "staging", namespace: null },
		]);
		// @ts-expect-error — a recording fake, not a drizzle Db.
		expect(await placementNamespacesOnFabric(db, "p1", "f1")).toEqual([
			{ environment: "preview", namespace: "preview" },
			{ environment: "staging", namespace: "staging" },
		]);
		const q = rendered(seen.find((x) => x.table === projectEnvironments)?.where);
		expect(q.sql).toMatch(/"project_id" = \$1 and .*"fabric_id" = \$2 and .*"placement_mode" = \$3 and .*"status" <> \$4/);
		expect(q.params).toEqual(["p1", "f1", "namespace", "DESTROYED"]);
	});
});
