// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { PROCESSING_PARTIES, publicProcessingParties } from "./processing";

describe("processing registry", () => {
	it("publishes only parties that currently process hosted-service data", () => {
		expect(publicProcessingParties().map((party) => party.id)).toEqual([
			"hetzner",
			"cloudflare",
			"resend",
			"posthog",
		]);
	});

	it("keeps PostHog consent purposes separate from operational diagnostics", () => {
		const posthog = PROCESSING_PARTIES.find((party) => party.id === "posthog");

		expect(
			posthog?.purposes.filter((purpose) => purpose.consentRequired),
		).toHaveLength(3);
		expect(posthog?.purposes).toContainEqual({
			name: "Server and migration error diagnostics and operational logs",
			lawfulBasis: "legitimate-interests",
			consentRequired: false,
		});
	});
});
