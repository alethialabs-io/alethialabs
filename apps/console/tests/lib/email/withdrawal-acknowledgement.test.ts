// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The withdrawal acknowledgement (#7339): a legal text, approved by the maintainer on 2026-11-23
// (#7351), in English and — for a Bulgarian billing country — Bulgarian.
//
// Two properties are pinned here:
//
//   · PROVENANCE. Every prose sentence the email carries, in BOTH languages, is on the sealed
//     Consumer rights page, verbatim. The page's source is read and whitespace-collapsed (JSX wraps
//     its lines), and each sentence must appear in it — so an edit to the email that drifts from the
//     sealed text, or a re-seal of the page that drops a sentence the email still sends, fails here.
//   · THE SENDER NEVER THROWS. It runs after money moved and the withdrawal was recorded; a failure
//     must be logged for a hand send, not surface as a failed withdrawal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));

import { render } from "@react-email/components";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getServiceDb } from "@/lib/db";
import { sendGuardedEmail } from "@/lib/email/guard";
import { WITHDRAWAL_BASIS } from "@repo/legal/commerce";
import {
	CONSUMER_RIGHTS_LINK,
	NON_PAGE_WORDING,
	PAGE_SENTENCES,
	SUBJECT,
	SUPPORT_SENTENCE,
	WithdrawalAcknowledgementEmail,
} from "@/emails/withdrawal-acknowledgement";
import { sendWithdrawalAcknowledgementEmail } from "@/lib/email/withdrawal-email";

const PAGE = fileURLToPath(
	new URL("../../../../marketing/app/consumer-rights/page.tsx", import.meta.url),
);

/** The sealed page's source with every whitespace run collapsed to one space. */
function pageText(): string {
	return readFileSync(PAGE, "utf8").replace(/\s+/g, " ");
}

/** A drizzle-shaped stub whose select chain resolves to `rows`. */
function stubDb(rows: unknown[]): void {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows),
	};
	vi.mocked(getServiceDb).mockReturnValue(chain as unknown as ReturnType<typeof getServiceDb>);
}

const ACK = {
	orderId: "order-1",
	placedByUserId: "u-1",
	withdrawnAt: new Date("2026-08-24T12:00:00Z"),
	refundMinorUnits: 8_000,
	retainedMinorUnits: 4_000,
	currency: "eur",
	refundIssued: true,
	basis: WITHDRAWAL_BASIS.en.proportional(10, 30),
	locale: "en" as const,
};

/** Renders the email to whitespace-collapsed plain text. */
async function plain(props: Parameters<typeof WithdrawalAcknowledgementEmail>[0]): Promise<string> {
	return (await render(WithdrawalAcknowledgementEmail(props), { plainText: true })).replace(/\s+/g, " ");
}

const PROPS = {
	withdrawnAtLabel: "24 Aug 2026, 12:00 UTC",
	orderReference: "order-1",
	refundLabel: "€80.00",
	retainedLabel: "€40.00",
	basis: WITHDRAWAL_BASIS.en.proportional(10, 30),
	refundIssued: true,
};

afterEach(() => {
	vi.resetAllMocks();
});

describe("the acknowledgement's prose is the sealed page's", () => {
	it("every page sentence it sends, in both languages, is on the Consumer rights page, verbatim", () => {
		const page = pageText();
		for (const locale of ["en", "bg-BG"] as const) {
			for (const sentence of Object.values(PAGE_SENTENCES[locale])) expect(page).toContain(sentence);
			expect(page).toContain(SUPPORT_SENTENCE[locale].before);
			expect(page).toContain(SUPPORT_SENTENCE[locale].after);
		}
	});

	it("the link names the page by its English title and its Bulgarian section's heading", () => {
		const page = pageText();
		expect(page).toContain(`title="${CONSUMER_RIGHTS_LINK.en.label}"`);
		expect(page).toContain(`<h2>${CONSUMER_RIGHTS_LINK["bg-BG"].label}`);
		expect(page).toContain('<section id="bg" lang="bg">');
		expect(CONSUMER_RIGHTS_LINK["bg-BG"].href.endsWith("#bg")).toBe(true);
	});

	it("the contracting-party line is the page's sentence over the same entity fields", () => {
		const page = pageText();
		expect(page).toContain(
			"{LEGAL_ENTITY.legalName}, {LEGAL_ENTITY.legalForm.toLowerCase()}, registered in {LEGAL_ENTITY.jurisdiction} under EIK{\" \"} {LEGAL_ENTITY.registrationNumber}, at {LEGAL_ENTITY.registeredAddress}.",
		);
		expect(page).toContain(
			"{LEGAL_ENTITY.legalNameBulgarian},{\" \"} {LEGAL_ENTITY.legalFormBulgarian.toLowerCase()}, регистрирано в{\" \"} {LEGAL_ENTITY.jurisdictionBulgarian} с ЕИК{\" \"} {LEGAL_ENTITY.registrationNumber}, със седалище и адрес на управление{\" \"} {LEGAL_ENTITY.registeredAddressBulgarian}.",
		);
	});

	it("renders the page sentences, the basis, the entity line and the recorded figures", async () => {
		const text = await plain(PROPS);
		expect(text).toContain(PROPS.basis);
		expect(text).toContain(PAGE_SENTENCES.en.accessAndRefund);
		expect(text).toContain(SUPPORT_SENTENCE.en.after);
		expect(text).toContain(LEGAL_ENTITY.supportEmail);
		expect(text).toContain(
			`${LEGAL_ENTITY.legalName}, ${LEGAL_ENTITY.legalForm.toLowerCase()}, registered in ${LEGAL_ENTITY.jurisdiction} under EIK ${LEGAL_ENTITY.registrationNumber}`,
		);
		// The plain-text renderer upper-cases headings.
		expect(text).toContain(NON_PAGE_WORDING.en.heading.toUpperCase());
		expect(text).toContain("€80.00");
		expect(text).toContain("€40.00");
		expect(text).toContain("24 Aug 2026, 12:00 UTC");
	});

	// The owed-refund sentence is a promise to act; it is sent only when there is something to act on.
	it("says it will arrange the refund only when the refund was not issued", async () => {
		expect(await plain(PROPS)).not.toContain(PAGE_SENTENCES.en.refundArranged);
		expect(await plain({ ...PROPS, refundIssued: false })).toContain(PAGE_SENTENCES.en.refundArranged);
	});

	it("renders wholly in Bulgarian for a Bulgarian consumer", async () => {
		const basis = WITHDRAWAL_BASIS["bg-BG"].proportional(10, 30);
		const text = await plain({ ...PROPS, basis, locale: "bg-BG", refundIssued: false });
		const bg = NON_PAGE_WORDING["bg-BG"];
		expect(text).toContain(bg.heading.toUpperCase());
		for (const label of [bg.withdrawnAtLabel, bg.orderLabel, bg.refundLabel, bg.retainedLabel]) {
			expect(text).toContain(label);
		}
		expect(text).toContain(basis);
		expect(text).toContain(PAGE_SENTENCES["bg-BG"].accessAndRefund);
		expect(text).toContain(PAGE_SENTENCES["bg-BG"].refundArranged);
		expect(text).toContain(SUPPORT_SENTENCE["bg-BG"].before);
		expect(text).toContain(SUPPORT_SENTENCE["bg-BG"].after);
		expect(text).toContain(
			`${LEGAL_ENTITY.legalNameBulgarian}, ${LEGAL_ENTITY.legalFormBulgarian.toLowerCase()}, регистрирано в ${LEGAL_ENTITY.jurisdictionBulgarian} с ЕИК ${LEGAL_ENTITY.registrationNumber}`,
		);
		expect(text).toContain(CONSUMER_RIGHTS_LINK["bg-BG"].label);
		// None of the English wording leaks into the Bulgarian email.
		expect(text).not.toContain(PAGE_SENTENCES.en.accessAndRefund);
		expect(text).not.toContain(SUPPORT_SENTENCE.en.after);
		expect(text).not.toContain(NON_PAGE_WORDING.en.refundLabel);
	});

	it("covers every word in both languages", () => {
		for (const map of [NON_PAGE_WORDING, PAGE_SENTENCES, SUPPORT_SENTENCE, CONSUMER_RIGHTS_LINK]) {
			expect(Object.keys(map["bg-BG"]).sort()).toEqual(Object.keys(map.en).sort());
		}
		expect(SUBJECT["bg-BG"].length).toBeGreaterThan(0);
	});
});

describe("sending the acknowledgement", () => {
	it("goes to the consumer who placed the order, with the server's figures and a zoned time", async () => {
		stubDb([{ email: "consumer@example.com" }]);
		await expect(sendWithdrawalAcknowledgementEmail(ACK)).resolves.toBe(true);
		expect(sendGuardedEmail).toHaveBeenCalledOnce();
		const args = vi.mocked(sendGuardedEmail).mock.calls[0]?.[0];
		expect(args?.to).toBe("consumer@example.com");
		expect(args?.subject).toBe(SUBJECT.en);
		const text = (await render(args?.react, { plainText: true })).replace(/\s+/g, " ");
		expect(text).toContain("€80.00");
		expect(text).toContain("€40.00");
		expect(text).toMatch(/24 Aug 2026, 12:00 UTC/);
		expect(text).toContain("order-1");
	});

	it("sends a Bulgarian consumer the Bulgarian subject and text", async () => {
		stubDb([{ email: "consumer@example.com" }]);
		await sendWithdrawalAcknowledgementEmail({
			...ACK,
			locale: "bg-BG",
			basis: WITHDRAWAL_BASIS["bg-BG"].deferred,
			refundIssued: false,
		});
		const args = vi.mocked(sendGuardedEmail).mock.calls[0]?.[0];
		expect(args?.subject).toBe(SUBJECT["bg-BG"]);
		const text = (await render(args?.react, { plainText: true })).replace(/\s+/g, " ");
		expect(text).toContain(WITHDRAWAL_BASIS["bg-BG"].deferred);
		expect(text).toContain(PAGE_SENTENCES["bg-BG"].refundArranged);
	});

	it("does not alert the operator when the send went out", async () => {
		stubDb([{ email: "consumer@example.com" }]);
		await sendWithdrawalAcknowledgementEmail(ACK);
		expect(alertOperator).not.toHaveBeenCalled();
	});

	it("does not throw, and pages the operator for a hand send, when the consumer has no address", async () => {
		stubDb([]);
		await expect(sendWithdrawalAcknowledgementEmail(ACK)).resolves.toBe(false);
		expect(sendGuardedEmail).not.toHaveBeenCalled();
		expect(alertOperator).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: { type: "user", id: "u-1" },
				summary: expect.stringMatching(/order order-1 was NOT sent .*must be sent by hand/),
			}),
		);
	});

	it("does not throw, and pages the operator for a hand send, when the transport fails", async () => {
		stubDb([{ email: "consumer@example.com" }]);
		vi.mocked(sendGuardedEmail).mockRejectedValueOnce(new Error("SES down"));
		await expect(sendWithdrawalAcknowledgementEmail(ACK)).resolves.toBe(false);
		expect(alertOperator).toHaveBeenCalledWith(
			expect.objectContaining({ summary: expect.stringMatching(/the send failed/) }),
		);
	});
});
