// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2568. Hetzner's DNS API refuses to host a `.io` zone, and every other cloud's creates a zone for
// any syntactically valid name without inspecting the TLD — so nothing in a plan, a preview or a
// form told the user before the apply failed with a 422 naming a FIELD rather than a cause.
//
// The direction here matches waf.ts's, not keyless.ts's: an unmeasured cloud is ALLOWED. This gate
// exists to stop a config making a promise the cloud will refuse, not to police clouds we have not
// probed — and refusing those would block deploys that work today.
//
// The denylist is deliberately incomplete (Hetzner publishes no supported-TLD list and exposes no
// endpoint to enumerate one), which is safe in one direction only: a TLD we have not measured still
// gets refused by the apply, exactly as it does now. These pin that asymmetry so a later "let's make
// it an allowlist for completeness" cannot quietly invert it.

import { describe, expect, it } from "vitest";
import {
	dnsTldUnsupportedReason,
	dnsTldUnsupportedReasonForCloud,
} from "@/lib/cloud-providers/dns-tld";

describe("dnsTldUnsupportedReason", () => {
	it("refuses a .io domain on hetzner and names both the evidence and a remedy", () => {
		const reason = dnsTldUnsupportedReason("hetzner", "alethialabs.io");
		expect(reason).toMatch(/unsupported tld/i);
		// A refusal with no next step reads as a bug, so both remedies must be present.
		expect(reason).toMatch(/Cloudflare/);
		expect(reason).toMatch(/TLD Hetzner hosts/);
	});

	it("allows the TLDs measured as accepted", () => {
		expect(dnsTldUnsupportedReason("hetzner", "alethialabs.de")).toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "alethialabs.com")).toBeNull();
	});

	it("keys on the TLD, not on domain depth", () => {
		// Both failed identically against the live API; a depth-based rule would have let one
		// through and is the reading this pins against.
		expect(dnsTldUnsupportedReason("hetzner", "e2e.alethialabs.io")).not.toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "a.b.c.alethialabs.io")).not.toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "a.b.c.alethialabs.de")).toBeNull();
	});

	it("tolerates the trailing dot and casing the canvas and CLI both accept", () => {
		expect(dnsTldUnsupportedReason("hetzner", "alethialabs.IO")).not.toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "alethialabs.io.")).not.toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "  alethialabs.io  ")).not.toBeNull();
	});

	it("does not refuse on OTHER clouds — .io is a hetzner restriction, not a global one", () => {
		for (const p of ["aws", "gcp", "azure", "alibaba"] as const) {
			expect(dnsTldUnsupportedReason(p, "alethialabs.io")).toBeNull();
		}
	});

	it("is silent with no cloud picked and with no domain typed", () => {
		// Two different questions with two different owners: `requiresProvider` asks the first, the
		// required-field check asks the second. Answering either here would give one question two
		// owners and produce a refusal before the user has done anything wrong.
		expect(dnsTldUnsupportedReason(null, "alethialabs.io")).toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", "")).toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", null)).toBeNull();
		expect(dnsTldUnsupportedReason("hetzner", undefined)).toBeNull();
	});

	it("is silent on a bare label with no TLD at all", () => {
		// "localhost" has no dot; treating the whole string as a TLD would refuse it on a rule that
		// says nothing about it.
		expect(dnsTldUnsupportedReason("hetzner", "localhost")).toBeNull();
	});
});

describe("dnsTldUnsupportedReasonForCloud", () => {
	it("agrees with the canvas-side sibling on hetzner", () => {
		expect(dnsTldUnsupportedReasonForCloud("hetzner", "alethialabs.io")).toEqual(
			dnsTldUnsupportedReason("hetzner", "alethialabs.io"),
		);
	});

	it("ALLOWS an unmeasured cloud rather than failing closed", () => {
		// The opposite of keylessUnavailableReasonForCloud, on purpose. Getting this backwards would
		// block deploys over a restriction that has never been shown to exist for that cloud.
		expect(dnsTldUnsupportedReasonForCloud("aws", "alethialabs.io")).toBeNull();
	});
});
