// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	CUSTOMER_DIRECTED_PARTIES,
	PROCESSING_PARTIES,
	publicProcessingParties,
} from "./processing";

describe("processing registry", () => {
	it("publishes active parties plus the conditional customer-directed ones", () => {
		expect(publicProcessingParties().map((party) => party.id)).toEqual([
			"hetzner",
			"cloudflare",
			"resend",
			"posthog",
			"stripe",
			"customer-cloud",
			"customer-git",
			"customer-connector",
			"customer-ai-endpoint",
		]);
	});

	it("never publishes an inactive or merely planned party", () => {
		const published = new Set(publicProcessingParties().map((p) => p.id));
		for (const party of PROCESSING_PARTIES) {
			if (party.status === "inactive" || party.status === "planned") {
				expect(published.has(party.id)).toBe(false);
			}
		}
		expect(published.has("aws-ses")).toBe(false);
		expect(published.has("grafana-prometheus")).toBe(false);
	});

	// Stripe was absent from this register entirely while billing was live and the pricing page said
	// "billed monthly through Stripe" — so the public privacy notice told data subjects that payment
	// details were not collected. An omission here is not under-disclosure, it is a false statement.
	it("registers the payment processor, because billing is live", () => {
		const stripe = PROCESSING_PARTIES.find((party) => party.id === "stripe");
		expect(stripe?.status).toBe("active");
		expect(stripe?.purposes.some((p) => p.lawfulBasis === "contract")).toBe(true);
		expect(stripe?.purposes.every((p) => p.consentRequired === false)).toBe(true);
	});

	// Customer-directed entries are CATEGORIES, never company names: Alethia has no agreement with,
	// and no knowledge of, which cloud or model endpoint a given customer connects. An unevidenced
	// company name in a processing register is the same defect as a missing one, pointing the other way.
	it("discloses customer-directed providers by category, not by company", () => {
		const conditional = publicProcessingParties().filter(
			(party) => party.status === "customer-directed",
		);
		expect(conditional.length).toBeGreaterThan(0);
		const forbidden =
			/\b(aws|amazon|google|gcp|azure|microsoft|alibaba|hetzner|github|gitlab|anthropic|openai)\b/i;
		for (const party of conditional) {
			expect(party.name).not.toMatch(forbidden);
		}
	});

	it("keeps PostHog consent purposes separate from operational diagnostics", () => {
		const posthog = PROCESSING_PARTIES.find((party) => party.id === "posthog");

		expect(
			posthog?.purposes.filter((purpose) => purpose.consentRequired),
		).toHaveLength(2);
		expect(posthog?.purposes).toContainEqual({
			name: "Server and migration error diagnostics and operational logs",
			lawfulBasis: "legitimate-interests",
			consentRequired: false,
		});
	});

	// Consent v2 offers ONE optional choice. A register that still described masked session replay
	// would be disclosing processing the product does not perform and offers no control for — and a
	// register nobody can reconcile with the product is not a truthful register, whichever direction
	// it errs in.
	it("describes no processing the product does not perform", () => {
		const described = [...PROCESSING_PARTIES, ...CUSTOMER_DIRECTED_PARTIES].flatMap((party) =>
			party.purposes.map((purpose) => purpose.name.toLowerCase()),
		);
		expect(described.filter((name) => name.includes("replay"))).toEqual([]);
	});

	// Every consent-gated purpose must correspond to a choice the consent UI actually offers.
	// Consent v2 offers exactly one: analytics. Adding a second consent purpose here without a
	// matching control would collect on a basis nobody was asked for.
	it("gates no more purposes on consent than the consent UI offers choices", () => {
		const consentGated = PROCESSING_PARTIES.flatMap((party) =>
			party.purposes.filter((purpose) => purpose.consentRequired),
		);
		for (const purpose of consentGated) {
			expect(purpose.lawfulBasis).toBe("consent");
		}
		// Both remaining consent purposes are facets of the single "product analytics" choice.
		expect(
			new Set(
				PROCESSING_PARTIES.filter((party) =>
					party.purposes.some((purpose) => purpose.consentRequired),
				).map((party) => party.id),
			),
		).toEqual(new Set(["posthog"]));
	});
});
