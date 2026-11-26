// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Link Paddle customer" — the operator action that stores an organization's Paddle customer id, for
// customers invoiced by hand from the Paddle dashboard (nothing else ever stores it for them). This
// module holds the parts the form and the server action share and the tests reach without Next:
// the input schema, the decision about what a submit does, and the parse of the console's answer.
// The write itself is the console's (POST /api/internal/platform/link-paddle-customer), so
// organization_billing keeps one writer.
//
// Imports stay relative: the staff app's vitest runs without the `@/` alias.

import { z } from "zod";
import { PADDLE_CUSTOMER_ID_HINT, PADDLE_CUSTOMER_ID_PATTERN } from "@repo/platform/paddle";

/** The operator's input. `replace` is the stored id they confirmed replacing, or null. */
export const linkPaddleCustomerSchema = z.object({
	orgId: z.string().uuid(),
	customerId: z.string().trim().regex(PADDLE_CUSTOMER_ID_PATTERN, PADDLE_CUSTOMER_ID_HINT),
	replace: z.string().nullable().default(null),
	reason: z.string().trim().min(1, "A reason is required"),
});

export type LinkPaddleCustomerInput = z.infer<typeof linkPaddleCustomerSchema>;

/** The form's own fields (the org id and the confirmation travel beside them). */
export const linkPaddleCustomerFormSchema = linkPaddleCustomerSchema.pick({ customerId: true, reason: true });

export type LinkPaddleCustomerFormValues = z.infer<typeof linkPaddleCustomerFormSchema>;

/** What a submit does, given the stored id. */
export type LinkPaddleCustomerPlan =
	| { kind: "unchanged" }
	| { kind: "confirm"; current: string }
	| { kind: "link"; replace: string | null };

/**
 * Decides a submit: the same id is a no-op; a DIFFERENT stored id needs the operator to confirm
 * replacing exactly that value (`replace`); otherwise link. The console repeats the same check under
 * a conditional write, so a value that changed after this read is refused there, not overwritten.
 */
export function planPaddleCustomerLink(
	current: string | null,
	requested: string,
	replace: string | null,
): LinkPaddleCustomerPlan {
	if (current === requested) return { kind: "unchanged" };
	if (current !== null && current !== replace) return { kind: "confirm", current };
	return { kind: "link", replace: current };
}

/** The console route's success body. */
export const linkPaddleCustomerResponseSchema = z.object({
	ok: z.literal(true),
	previous: z.string().nullable(),
	customerId: z.string(),
	changed: z.boolean(),
	verified: z.boolean(),
});

export type LinkPaddleCustomerResponse = z.infer<typeof linkPaddleCustomerResponseSchema>;
