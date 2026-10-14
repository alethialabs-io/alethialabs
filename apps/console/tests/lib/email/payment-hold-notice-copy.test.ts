// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The Q3 payment-hold emails' copy, per hold scope (#6011; ADR 0002 I8, §5.5; ADR 0004 D8, O7).
//
// Each scope's words are pinned here as literals, read off the email the sender hands the transport:
//
//   new_org   the create-a-team copy. These literals are the text `dev` sent before #6011, so a change to
//             them fails here (the drift check): #6011 moved the org-plan email off this copy and left
//             this copy alone.
//   org_plan  a plan bought for a team that already exists. It names no team setup and nothing to finish,
//             and carries no amount, card or invoice. Only `refund_pending` and `released:refunded` exist:
//             an org-plan adoption is never mailed (ADR 0004 D8).
//
// On `dev` the org_plan cases fail (`sendOrgPlanHoldNoticeEmail` does not exist there; the org-plan hold
// was mailed the create-a-team copy) and the new_org cases pass.

import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn(), getPurchaseStripe: vi.fn() }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: vi.fn(async () => undefined) }));

import { render } from "@react-email/components";
import { sendGuardedEmail } from "@/lib/email/guard";
import { PAYMENT_HOLD_NOTIFIED_STATES, type PaymentHoldNotifiedState } from "@/lib/db/schema";
import {
	type OrgPlanHoldNotice,
	sendOrgPlanHoldNoticeEmail,
	sendPaymentHoldNoticeEmail,
} from "@/lib/email/billing-email";

/** The words of one payment-hold email. */
interface Copy {
	subject: string;
	eyebrow: string;
	heading: string;
	body: string[];
}

/** The create-a-team copy exactly as `dev` sends it before #6011. */
const NEW_ORG: Record<PaymentHoldNotifiedState, Copy> = {
	refund_pending: {
		subject: "Your refund from Alethia is on its way",
		eyebrow: "Refund issued",
		heading: "Your refund is on its way.",
		body: [
			"A payment for an earlier team setup went through after that checkout was cancelled, so nothing was set up for it. We have issued its refund, and it is on its way back to you.",
			"If you buy again before it arrives and that refund fails, you may see both charges until we have refunded it again.",
		],
	},
	"released:refunded": {
		subject: "Your Alethia refund is complete",
		eyebrow: "Refunded",
		heading: "Your payment was refunded in full.",
		body: [
			"An earlier payment for a team setup was refunded in full. It can take 5–10 business days to reach you, depending on your bank.",
		],
	},
	"released:adopted": {
		subject: "Your Alethia payment went through",
		eyebrow: "Payment confirmed",
		heading: "Your payment went through.",
		body: [
			"The payment for your earlier team setup went through, and the plan is yours. Open Create a team in Alethia to finish setting up your team.",
		],
	},
};

/** The org-plan copy (ADR 0004 D8, O7). */
const ORG_PLAN: Record<OrgPlanHoldNotice, Copy> = {
	refund_pending: {
		subject: "Your refund from Alethia is on its way",
		eyebrow: "Refund issued",
		heading: "Your refund is on its way.",
		body: [
			"A payment for an earlier plan checkout went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you.",
			"If you buy again before it arrives and that refund fails, you may see both charges until we have refunded it again.",
		],
	},
	"released:refunded": {
		subject: "Your Alethia refund is complete",
		eyebrow: "Refunded",
		heading: "Your payment was refunded in full.",
		body: [
			"A payment for an earlier plan checkout was refunded in full. It can take 5–10 business days to reach you, depending on your bank.",
		],
	},
};

/** Every email an org-plan hold can be sent. */
const ORG_PLAN_NOTICES: OrgPlanHoldNotice[] = ["refund_pending", "released:refunded"];

/** Create-a-team wording: none of it is true of a plan bought for a team that already exists. */
const CREATE_A_TEAM = /team setup|setup|set up|setting up|create a team|finish|new team/i;

/** An amount, a card or an invoice (ADR 0002 I8), or a promise nothing enforces (ADR 0004 O7). */
const MONEY_DETAIL = /[$€£]\s?\d|\d+[.,]\d{2}\b|\bcard\b|invoice|charged (twice|again)|won't be charged/i;

/** Collects the text of the eyebrow, heading and body paragraphs from the email's element tree. */
function copyOf(node: ReactNode, out: { key: string; text: string }[] = []): { key: string; text: string }[] {
	if (Array.isArray(node)) {
		for (const child of node) copyOf(child, out);
		return out;
	}
	if (!isValidElement<{ children?: ReactNode }>(node)) return out;
	const key = node.key ?? "";
	const children = node.props.children;
	if ((key === "eyebrow" || key === "heading" || key.startsWith("body-")) && typeof children === "string") {
		out.push({ key, text: children });
		return out;
	}
	return copyOf(children, out);
}

/** The one email the last call handed the transport: its address, subject, copy and plain text. */
async function lastSent(): Promise<{ to: string; copy: Copy; plain: string }> {
	const sent = vi.mocked(sendGuardedEmail).mock.calls.at(-1)?.[0];
	if (!sent) throw new Error("no email was handed to the transport");
	const parts = copyOf(sent.react);
	return {
		to: sent.to,
		copy: {
			subject: sent.subject,
			eyebrow: parts.find((p) => p.key === "eyebrow")?.text ?? "",
			heading: parts.find((p) => p.key === "heading")?.text ?? "",
			body: parts.filter((p) => p.key.startsWith("body-")).map((p) => p.text),
		},
		plain: await render(sent.react, { plainText: true }),
	};
}

afterEach(() => {
	vi.mocked(sendGuardedEmail).mockClear();
});

describe("payment-hold notice copy — new_org (create-a-team), unchanged by #6011", () => {
	it.each(PAYMENT_HOLD_NOTIFIED_STATES)("%s is dev's text, to the given address", async (notice) => {
		const expected = NEW_ORG[notice];
		await sendPaymentHoldNoticeEmail({ to: "payer@example.test", notice });
		const sent = await lastSent();
		expect(sent.to).toBe("payer@example.test");
		expect(sent.copy).toEqual(expected);
		for (const paragraph of expected.body) expect(sent.plain.replace(/\s+/g, " ")).toContain(paragraph);
	});
});

describe("payment-hold notice copy — org_plan (#6011; ADR 0004 D8, O7)", () => {
	it.each(ORG_PLAN_NOTICES)("%s is the org-plan text, to the given address", async (notice) => {
		const expected = ORG_PLAN[notice];
		await sendOrgPlanHoldNoticeEmail({ to: "billing@team.example", notice });
		const sent = await lastSent();
		expect(sent.to).toBe("billing@team.example");
		expect(sent.copy).toEqual(expected);
		for (const paragraph of expected.body) expect(sent.plain.replace(/\s+/g, " ")).toContain(paragraph);
	});

	it.each(ORG_PLAN_NOTICES)(
		"%s says nothing about a team setup, and no amount, card or invoice",
		async (notice) => {
			await sendOrgPlanHoldNoticeEmail({ to: "billing@team.example", notice });
			const sent = await lastSent();
			const words = [sent.copy.subject, sent.copy.eyebrow, sent.copy.heading, ...sent.copy.body].join("\n");
			expect(words).not.toMatch(CREATE_A_TEAM);
			expect(words).not.toMatch(MONEY_DETAIL);
			expect(sent.plain).not.toMatch(CREATE_A_TEAM);
			expect(sent.plain).not.toMatch(MONEY_DETAIL);
		},
	);

	it("the patterns would catch the create-a-team copy (so a pass above is not vacuous)", () => {
		for (const copy of Object.values(NEW_ORG)) {
			expect(copy.body.join("\n")).toMatch(CREATE_A_TEAM);
		}
	});
});
