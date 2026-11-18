// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The write side of permission-denied (CON-SM4, #6813): a control is live only once its read has
// said `canManage: true`. Before the read answers, and after it answers no, the control carries a
// reason, so it is never enabled and then refused.

import { describe, expect, it } from "vitest";

import {
	MANAGE_DENIED_REASON,
	MANAGE_PENDING_REASON,
	manageReason,
} from "@/components/errors/manage-gate";

describe("manageReason", () => {
	it("is null — the control is live — only when the read answered canManage: true", () => {
		expect(manageReason({ canManage: true })).toBeNull();
	});

	it("is the denied reason when the read answered canManage: false", () => {
		expect(manageReason({ canManage: false })).toBe(MANAGE_DENIED_REASON);
	});

	it.each([
		["undefined (a query with no data yet)", undefined],
		["null", null],
	])("keeps the control disabled while the read has not answered: %s", (_, read) => {
		expect(manageReason(read)).toBe(MANAGE_PENDING_REASON);
	});

	it("reads only canManage off a wider read", () => {
		const read = { canManage: false, rows: [1, 2, 3], plan: "pro" };
		expect(manageReason(read)).toBe(MANAGE_DENIED_REASON);
	});

	it("the two reasons are different sentences", () => {
		expect(MANAGE_DENIED_REASON).not.toBe(MANAGE_PENDING_REASON);
	});
});
