// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The two Early Access emails, rendered. The grant email is held to decisions-2026-11-23 §2: the
// access is complimentary, nothing is owed, the period is never charged, and no price is named or
// promised. The request alert carries the Art. 97a reminder verbatim.

import { render } from "@react-email/components";
import { describe, expect, it } from "vitest";
import { EarlyAccessGrantedEmail, GRANT_TERMS, subject as grantedSubject } from "@/emails/early-access-granted";
import { ART_97A_REMINDER, EarlyAccessRequestEmail, subject as requestSubject } from "@/emails/early-access-request";

describe("the grant email", () => {
	it("says complimentary, nothing owed, never charged — and names no price", async () => {
		const text = await render(EarlyAccessGrantedEmail({ orgName: "Acme GmbH", planName: "Team", endsOn: "21 Feb 2027" }), {
			plainText: true,
		});
		for (const sentence of Object.values(GRANT_TERMS)) expect(text).toContain(sentence);
		expect(text).toContain("until 21 Feb 2027");
		// No amount, currency or price wording: a figure here would read as a promised future price.
		expect(text).not.toMatch(/[€$£]\s?\d|\d\s?(EUR|USD)\b|per month|\/mo\b|price/i);
		// And nothing that reads as a debt or a subscription that will start.
		expect(text).not.toMatch(/will be (billed|charged|invoiced)|payment method|invoice/i);
		expect(grantedSubject({ planName: "Team" })).toBe("Complimentary Early Access to Alethia Team");
	});

	it("omits the end-date sentences for a grant with no end", async () => {
		const text = await render(EarlyAccessGrantedEmail({ orgName: "Acme GmbH", planName: "AI Plus", endsOn: null }), {
			plainText: true,
		});
		expect(text).not.toContain("until");
		expect(text).not.toContain("When the grant ends");
	});
});

describe("the request alert", () => {
	it("names the org, country and VAT number, and carries the Art. 97a reminder", async () => {
		const props = {
			requestId: "req-1",
			orgName: "Acme GmbH",
			orgSlug: "acme",
			country: "DE",
			vatId: "DE123456789",
			planName: "Team",
			vies: "unchecked" as const,
			viesName: null,
			requesterEmail: "billing@acme.example",
			note: "We intend to subscribe.",
		};
		const text = await render(EarlyAccessRequestEmail(props), { plainText: true });
		expect(text).toContain("Acme GmbH");
		expect(text).toContain("DE123456789");
		expect(text).toContain("in DE");
		expect(text).toContain(ART_97A_REMINDER);
		expect(text).toContain("not checked");
		expect(requestSubject(props)).toBe("Early Access request: Acme GmbH (DE, DE123456789)");
	});
});
