// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4320, maintainer ruling 2026-09-23: the Managed TLS switch is gated on Alibaba with a reason, as the
// WAF switch beside it is. Alibaba's `alidns_managed_certificate` is a recorded PROVIDER CEILING (the
// `ceiling:` section of the knob ledger, #1824). These pin the gate, the normaliser, and that the
// sentence is the ledgers' own — the offer surface prints it into the public matrix.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getKindConfig, NO_CAPABILITIES, type FieldCtx } from "@/components/design-project/canvas/inspector/config-schema";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";
import {
	managedCertificateUnavailableReason,
	normalizeManagedCertificate,
} from "@/lib/cloud-providers/managed-certificate";

describe("managedCertificateUnavailableReason", () => {
	it("withholds it on alibaba, with a remedy", () => {
		expect(managedCertificateUnavailableReason("alibaba")).toMatch(/Bring your own certificate/);
	});

	it("allows every other cloud, and does not refuse while no cloud is picked", () => {
		for (const p of ["aws", "gcp", "azure", "hetzner"] as const) expect(managedCertificateUnavailableReason(p)).toBeNull();
		expect(managedCertificateUnavailableReason(null)).toBeNull();
	});

	it("says exactly what the offer-exclusion ledger says, so the canvas and the matrix agree", () => {
		const ledger = readFileSync("../../infra/offer-exclusions.yaml", "utf8");
		expect(ledger).toContain(`reason: ${managedCertificateUnavailableReason("alibaba")}`);
	});
});

describe("normalizeManagedCertificate", () => {
	it("clears a stale true on alibaba", () => {
		expect(normalizeManagedCertificate({ managed_certificate: true }, "alibaba").managed_certificate).toBe(false);
	});

	it("returns the SAME object when nothing changes", () => {
		const on = { managed_certificate: true };
		expect(normalizeManagedCertificate(on, "aws")).toBe(on);
		const off = { managed_certificate: false };
		expect(normalizeManagedCertificate(off, "alibaba")).toBe(off);
	});
});

describe("the Managed TLS switch (unavailableWhen)", () => {
	const field = getKindConfig("dns")
		?.sections.flatMap((s) => s.fields)
		.find((f) => f.key === "managed_certificate");

	/** Why the switch cannot be honoured on this cloud, or null when it can. */
	const unavailable = (provider: CloudProviderSlug | null) => {
		const config: Record<string, unknown> = {};
		const ctx: FieldCtx = { provider, config, caps: NO_CAPABILITIES };
		return field?.unavailableWhen?.(config, ctx) ?? null;
	};

	it("is gated on alibaba with the reason, mirroring the WAF switch", () => {
		expect(field).toBeDefined();
		expect(unavailable("alibaba")).toBe(managedCertificateUnavailableReason("alibaba"));
		expect(unavailable("aws")).toBeNull();
		expect(field?.requiresProvider).toBe(true);
	});

	it("gates rather than hides, which keeps the exclusion measurable by the offer-parity guard", () => {
		expect(field?.visibleWhen).toBeUndefined();
	});
});
