// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Evidence filter/query plumbing (components/evidence/evidence-query.ts): the
// normalize step's key-stability guarantees, the provider "other" bucketing, and
// the drift guards keeping the client-safe cloud list in lockstep with the
// `cloud_provider` DB enum and @repo/ui's PROVIDER_LABELS.

import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { describe, expect, it } from "vitest";
import {
	CLOUD_FILTER_VALUES,
	DEFAULT_EVIDENCE_FILTERS,
	normalizeEvidenceQuery,
	OTHER_PROVIDER,
	providerKey,
} from "@/components/evidence/evidence-query";
import { cloudProvider } from "@/lib/db/schema/enums";

describe("cloud list drift guards", () => {
	it("mirrors the cloud_provider DB enum exactly (order included)", () => {
		expect([...CLOUD_FILTER_VALUES]).toEqual(cloudProvider.enumValues);
	});

	it("every cloud has a PROVIDER_LABELS display label", () => {
		for (const v of CLOUD_FILTER_VALUES) {
			expect(PROVIDER_LABELS[v], `missing label for ${v}`).toBeTruthy();
		}
	});
});

describe("providerKey", () => {
	it("returns the cloud slug for known clouds", () => {
		expect(providerKey("aws")).toBe("aws");
		expect(providerKey("hetzner")).toBe("hetzner");
	});

	it("buckets null / mixed / unknown providers as other", () => {
		expect(providerKey(null)).toBe(OTHER_PROVIDER);
		expect(providerKey("mixed")).toBe(OTHER_PROVIDER);
		expect(providerKey("metal")).toBe(OTHER_PROVIDER);
	});
});

describe("normalizeEvidenceQuery", () => {
	it("drops empty fields entirely (pristine filters → empty object)", () => {
		expect(normalizeEvidenceQuery(DEFAULT_EVIDENCE_FILTERS)).toEqual({});
	});

	it("trims search and drops it when blank", () => {
		expect(
			normalizeEvidenceQuery({ ...DEFAULT_EVIDENCE_FILTERS, search: "  api " }),
		).toEqual({ search: "api" });
		expect(
			normalizeEvidenceQuery({ ...DEFAULT_EVIDENCE_FILTERS, search: "   " }),
		).toEqual({});
	});

	it("sorts and dedupes selections so equivalent states produce identical keys", () => {
		const a = normalizeEvidenceQuery({
			...DEFAULT_EVIDENCE_FILTERS,
			providers: ["gcp", "aws", "gcp"],
			stages: ["staging", "production"],
		});
		const b = normalizeEvidenceQuery({
			...DEFAULT_EVIDENCE_FILTERS,
			providers: ["aws", "gcp"],
			stages: ["production", "staging"],
		});
		expect(a).toEqual(b);
		// Key-identity is what the query cache compares — assert it directly.
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
