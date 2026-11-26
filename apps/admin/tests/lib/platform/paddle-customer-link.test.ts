// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app's half of "Link Paddle customer": the input schema (the id's shape and the required
// reason), the decision about what a submit does (no-op, confirm, link), and the parse of the
// console's answer.

import { describe, expect, it } from "vitest";
import {
	linkPaddleCustomerResponseSchema,
	linkPaddleCustomerSchema,
	planPaddleCustomerLink,
} from "../../../lib/platform/paddle-customer-link";

const ORG = "00000000-0000-4000-8000-000000000001";
const CTM_A = `ctm_${"a".repeat(26)}`;
const CTM_B = `ctm_${"b".repeat(26)}`;

describe("linkPaddleCustomerSchema", () => {
	it("accepts a Paddle customer id with a reason, trimming both, and defaults replace to null", () => {
		expect(linkPaddleCustomerSchema.parse({ orgId: ORG, customerId: ` ${CTM_A} `, reason: " invoiced by hand " })).toEqual({
			orgId: ORG,
			customerId: CTM_A,
			replace: null,
			reason: "invoiced by hand",
		});
	});

	it.each(["ctm_123", `CTM_${"a".repeat(26)}`, `ctm_${"a".repeat(27)}`, `sub_${"a".repeat(26)}`, ""])(
		"refuses %j with the expected form as the message",
		(customerId) => {
			const r = linkPaddleCustomerSchema.safeParse({ orgId: ORG, customerId, reason: "x" });
			expect(r.success).toBe(false);
			expect(r.error?.issues[0]?.message).toBe(
				"A Paddle customer id is ctm_ followed by 26 lowercase letters and digits.",
			);
		},
	);

	it("refuses a blank reason", () => {
		const r = linkPaddleCustomerSchema.safeParse({ orgId: ORG, customerId: CTM_A, reason: "  " });
		expect(r.error?.issues[0]?.message).toBe("A reason is required");
	});
});

describe("planPaddleCustomerLink", () => {
	it("links an org with no customer", () => {
		expect(planPaddleCustomerLink(null, CTM_A, null)).toEqual({ kind: "link", replace: null });
	});

	it("does nothing when the org already holds that id", () => {
		expect(planPaddleCustomerLink(CTM_A, CTM_A, null)).toEqual({ kind: "unchanged" });
	});

	it("asks to confirm replacing a different stored id, naming it", () => {
		expect(planPaddleCustomerLink(CTM_A, CTM_B, null)).toEqual({ kind: "confirm", current: CTM_A });
	});

	it("asks again when the confirmation named a value that is no longer stored", () => {
		expect(planPaddleCustomerLink(CTM_A, CTM_B, `ctm_${"c".repeat(26)}`)).toEqual({ kind: "confirm", current: CTM_A });
	});

	it("replaces once the operator confirmed exactly the stored id", () => {
		expect(planPaddleCustomerLink(CTM_A, CTM_B, CTM_A)).toEqual({ kind: "link", replace: CTM_A });
	});
});

describe("linkPaddleCustomerResponseSchema", () => {
	it("parses the console's success body", () => {
		const body = { ok: true, previous: null, customerId: CTM_A, changed: true, verified: false };
		expect(linkPaddleCustomerResponseSchema.parse(body)).toEqual(body);
	});

	it("refuses a body without the verification flag", () => {
		expect(linkPaddleCustomerResponseSchema.safeParse({ ok: true, previous: null, customerId: CTM_A, changed: true }).success).toBe(
			false,
		);
	});
});
