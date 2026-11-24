// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The approvals list's answer for a viewer with no viewable project (AGT-L2, G2). The query itself
// runs against Postgres in tests/integration/agt-l2-seams.test.ts.

import { describe, expect, it } from "vitest";
import { queryApprovalsPage } from "@/lib/queries/approvals";
import { untouchableTx } from "../approvals/fake-executor";

describe("queryApprovalsPage with no viewable project", () => {
	it("answers an empty first page with zeroed facets and reads nothing", async () => {
		const page = await queryApprovalsPage(untouchableTx(), "org", [], {}, { limit: 50 });
		expect(page.universeEmpty).toBe(true);
		expect(page.rows).toEqual([]);
		expect(page.nextCursor).toBeNull();
		expect(page.facets?.status.every((o) => o.count === 0)).toBe(true);
		expect(page.facets?.environment).toEqual([]);
	});

	it("answers a later page with no facets", async () => {
		const cursor = { at: "2026-11-24T12:00:00.000Z", id: "x" };
		const page = await queryApprovalsPage(untouchableTx(), "org", [], {}, { cursor, limit: 50 });
		expect(page.facets).toBeNull();
		expect(page.universeEmpty).toBeNull();
	});
});
