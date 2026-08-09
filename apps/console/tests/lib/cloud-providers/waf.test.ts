// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The WAF withholding table is read by all three layers of the Alibaba withdrawal (#1841): the canvas
// gate (`config-schema.ts`'s `waf_enabled` field), the canvas store's normalizer, and the deploy-time
// gate in `buildConfigSnapshot`. These pin the properties those three depend on.
//
// The direction here is the OPPOSITE of keyless.ts's, deliberately, and the tests say so: keyless is a
// security setting where an unknown cloud must fail closed, while this gate exists to stop a canvas
// switch making a false promise. An unknown cloud is therefore ALLOWED, and getting that backwards
// would block deploys on every connect-only cloud.

import { describe, expect, it } from "vitest";
import {
	normalizeWafEnabled,
	wafUnavailableReason,
	wafUnavailableReasonForCloud,
} from "@/lib/cloud-providers/waf";
import OFFER_SURFACE from "@/lib/cloud-providers/generated/offer-surface.json";

describe("wafUnavailableReason", () => {
	it("withholds the offer on alibaba, naming the account-level purchase", () => {
		const reason = wafUnavailableReason("alibaba");
		expect(reason).toMatch(/account-level purchase/);
		// The remedy has to be there too — a refusal with no next step reads as a bug.
		expect(reason).toMatch(/WAF console/);
	});

	it("allows every cloud that provisions one", () => {
		for (const slug of ["aws", "gcp", "azure"] as const) {
			expect(wafUnavailableReason(slug)).toBeNull();
		}
	});

	// Hetzner's `dns:waf_enabled` cell is an equally real documented exclusion, but gating it here
	// would make the deploy gate start refusing live Hetzner projects that already carry the flag.
	// That is a separate decision with its own migration; this test pins the CURRENT boundary so the
	// scope choice is visible rather than looking like an oversight.
	it("leaves hetzner ungated — a deliberate scope boundary, not a hole", () => {
		expect(wafUnavailableReason("hetzner")).toBeNull();
	});

	it("does not refuse while no cloud is picked", () => {
		expect(wafUnavailableReason(null)).toBeNull();
	});
});

describe("wafUnavailableReasonForCloud", () => {
	it("gives the canvas and the server the SAME sentence", () => {
		// Two sources of truth for one refusal is how a canvas and a deploy start disagreeing about
		// why something was rejected.
		expect(wafUnavailableReasonForCloud("alibaba")).toBe(
			wafUnavailableReason("alibaba"),
		);
	});

	it("allows a cloud that is not withheld, including connect-only ones", () => {
		expect(wafUnavailableReasonForCloud("aws")).toBeNull();
		// digitalocean has no project template at all. Refusing it — the keyless direction — would
		// block a deploy over a switch that was never withheld for it.
		expect(wafUnavailableReasonForCloud("digitalocean")).toBeNull();
	});
});

describe("normalizeWafEnabled", () => {
	it("clears waf_enabled on a cloud that does not provision one", () => {
		expect(normalizeWafEnabled({ waf_enabled: true }, "alibaba").waf_enabled).toBe(
			false,
		);
	});

	it("leaves an offered cloud — and an already-off switch — alone", () => {
		const on = { waf_enabled: true };
		expect(normalizeWafEnabled(on, "aws")).toBe(on); // same reference: no needless re-render
		const off = { waf_enabled: false };
		expect(normalizeWafEnabled(off, "alibaba")).toBe(off);
	});

	it("does not clear it while no cloud is picked", () => {
		const draft = { waf_enabled: true };
		expect(normalizeWafEnabled(draft, null)).toBe(draft);
	});
});

/** A cloud's `unavailableOn` reason from the generated surface, or undefined.
 *
 * Read structurally rather than through the JSON import's inferred type: tsc widens
 * `unavailableOn` to a UNION of every literal shape in the file, so a direct index is an error the
 * moment another offer gains or loses a cloud there. Narrowing at runtime keeps that honest without
 * an `as`, the same move `scripts/gen-offer-surface.ts` makes with its own `prop()` helper. */
function reasonFor(unavailableOn: unknown, cloud: string): string | undefined {
	if (typeof unavailableOn !== "object" || unavailableOn === null) return undefined;
	const value = Reflect.get(unavailableOn, cloud);
	return typeof value === "string" ? value : undefined;
}

describe("the generated offer surface agrees with the table", () => {
	// `unavailableWhen` GATES rather than HIDES, and the difference is load-bearing: a hidden switch
	// drops alibaba out of `offeredOn`, and the offer-parity guard iterates `offeredOn` — so the
	// `dns:waf_enabled` / alibaba entry in infra/offer-exclusions.yaml would silently match nothing
	// and the matrix would print `·` (not offered) instead of `—` (documented exclusion).
	it("keeps alibaba OFFERED and marks it unavailable, never not-offered", () => {
		const waf = OFFER_SURFACE.offers.find(
			(o) => o.kind === "dns" && o.key === "waf_enabled",
		);
		expect(waf).toBeDefined();
		expect(waf?.offeredOn).toContain("alibaba");
		expect(waf?.notOfferedOn ?? []).not.toContain("alibaba");
		// The generated reason and the table's must be the same string, not merely both present.
		expect(reasonFor(waf?.unavailableOn, "alibaba")).toBe(
			wafUnavailableReason("alibaba"),
		);
	});
});
