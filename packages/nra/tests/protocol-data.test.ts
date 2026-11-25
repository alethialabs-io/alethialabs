// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The books workflow's ProtocolData as an input of `nra:protocol`: a protocol it already numbered
// and computed is re-checked and rendered with the package's own layout.

import { describe, expect, it } from "vitest";
import { protocolLayout, protocolText } from "../src/protocol";
import { isProtocolData, protocolFromData } from "../src/protocol-data";

/** A books ProtocolData for a USD purchase from Anthropic. */
function data(over: Record<string, unknown> = {}) {
	return {
		number: "0000000007",
		issueDate: "2026-12-16",
		taxEventDate: "2026-12-15",
		issuer: { name: "АЛЕТИЯ ЛАБС ЕДПК", eik: "208913663", vatNumber: "BG208913663" },
		supplier: { name: "Anthropic, PBC", country: "US", vatNumber: null },
		supplierDocument: { number: "ANT-0042", date: "2026-12-15" },
		lines: [{ description: "Claude API usage", baseCents: 4750 }],
		baseCents: 4750,
		ratePercent: 20,
		vatCents: 950,
		ground: "чл. 82, ал. 2, т. 3 ЗДДС",
		creditRight: "full",
		fxNote: "USD 50.00 × 0.95000000 (ECB:2026-12-15)",
		ledgerEventId: "evt_1",
		...over,
	};
}

describe("protocolFromData", () => {
	it("is recognised and rendered with the full credit right and the books' conversion note", () => {
		expect(isProtocolData(data())).toBe(true);
		expect(isProtocolData({ version: 2, purchase: {} })).toBe(false);
		const r = protocolFromData(data());
		if (!r.ok) throw new Error(r.problems.join("; "));
		expect(r.value.filerVat).toBe("BG208913663");
		const text = protocolText(protocolLayout(r.value.protocol, r.value.filerVat));
		for (const part of ["№ 0000000007", "16.12.2026", "ANT-0042", "€47.50", "€9.50", "USD 50.00 × 0.95000000", "С право на пълен данъчен кредит"]) expect(text).toContain(part);
	});

	it("refuses figures that do not hold, no credit, a BG supplier or a missing invoice", () => {
		const problems = (over: Record<string, unknown>) => {
			const r = protocolFromData(data(over));
			return r.ok ? [] : r.problems;
		};
		expect(problems({ vatCents: 951 })[0]).toMatch(/not 20 %/);
		expect(problems({ ratePercent: 9 })[0]).toMatch(/20 %/);
		expect(problems({ baseCents: 4800, vatCents: 960 })[0]).toMatch(/do not sum/);
		expect(problems({ creditRight: "none" })[0]).toMatch(/keeps the credit/);
		expect(problems({ supplier: { name: "X", country: "BG", vatNumber: "BG000000001" } })[0]).toMatch(/Bulgarian supplier/);
		expect(problems({ supplierDocument: null })[0]).toMatch(/invoice number/);
		expect(problems({ number: "7" })[0]).toMatch(/number/);
	});
});
