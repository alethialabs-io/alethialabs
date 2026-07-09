// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// search_docs grounds elench in the real docs. These pin that the lexical ranker surfaces the right pages
// for the questions users actually ask (esp. connectors / keyless auth) — so the model cites docs instead
// of improvising. Runs against the committed docs index (lib/ai/docs-index.generated.json).

import { describe, expect, it } from "vitest";
import { rankDocs } from "@/lib/ai/tools/docs";

describe("rankDocs", () => {
	it("surfaces a connectors doc for 'how do I connect AWS'", () => {
		const hits = rankDocs("how do I connect an AWS account", 5);
		expect(hits.length).toBeGreaterThan(0);
		// A connectors / cloud-connector page should be among the top hits.
		expect(hits.some((h) => /connector/i.test(h.route) || /aws/i.test(h.route))).toBe(true);
	});

	it("surfaces keyless/OIDC docs for a keyless-auth question", () => {
		const hits = rankDocs("keyless OIDC federation for cloud credentials", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(
			hits.some((h) => /security|connector|managed-cloud/i.test(h.route) || /oidc|keyless|federat/i.test(h.text)),
		).toBe(true);
	});

	it("returns URLs and titles for citation", () => {
		const [top] = rankDocs("Alibaba RAM role connect", 3);
		expect(top).toBeTruthy();
		expect(top.url.startsWith("/")).toBe(true);
		expect(top.title.length).toBeGreaterThan(0);
	});

	it("returns nothing for an empty / stopword-only query", () => {
		expect(rankDocs("", 5)).toEqual([]);
		expect(rankDocs("how do i", 5)).toEqual([]);
	});

	it("ranks a specific page above unrelated ones", () => {
		const hits = rankDocs("workload identity federation Azure federated credential", 8);
		const idxAzure = hits.findIndex((h) => /azure/i.test(h.route) || /azure/i.test(h.text));
		const idxBilling = hits.findIndex((h) => /billing|pricing/i.test(h.route));
		// Azure content should rank (present); if a billing page also matched, Azure ranks higher.
		expect(idxAzure).toBeGreaterThanOrEqual(0);
		if (idxBilling >= 0) expect(idxAzure).toBeLessThan(idxBilling);
	});
});
