// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The component write gate's two structural rules (#5551), apart from the route suite's mocks:
// the promotion statuses that hold an environment are the promotion lifecycle's own in-flight set,
// and a precondition asked of a table with no `updated_at` throws instead of being dropped.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PROMOTION_HOLDING_STATUSES, writableWhere } from "@/lib/cli/project-components";
import { projectDatabases } from "@/lib/db/schema";
import { IN_FLIGHT } from "@/lib/promotions/lifecycle";

const ENV_ID = "55555555-5555-4555-8555-555555555555";

describe("the component write gate (#5551)", () => {
	it("holds an environment for exactly the promotion lifecycle's in-flight statuses", () => {
		expect([...PROMOTION_HOLDING_STATUSES].sort()).toEqual([...IN_FLIGHT].sort());
	});

	it("throws when If-Match is asked of a table with no updated_at, rather than writing unconditionally", () => {
		const { updated_at: _dropped, ...cols } = getTableColumns(projectDatabases);
		expect(() => writableWhere(cols, ENV_ID, { ifMatch: "2026-10-06T10:00:00.000Z" })).toThrow(
			/no updated_at column, so an If-Match precondition cannot be checked/,
		);
		// Without a precondition there is nothing to drop, so the same table is writable.
		expect(() => writableWhere(cols, ENV_ID, { ifMatch: null })).not.toThrow();
	});
});
