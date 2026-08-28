// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2568, corrected by #2843. Hetzner's DNS API refuses some zone names, and every other cloud's
// creates a zone for any syntactically valid name without inspecting it — so nothing in a plan, a
// preview or a form told the user before the apply failed with a 422 naming a FIELD rather than a
// cause.
//
// #2568 read the refusal as being about the TLD. It is (at least) about DEPTH: every name Hetzner
// accepted was two labels and every name it refused was three or four, across two different TLDs,
// so the original probes varied both together and could not separate them. The suite below pins the
// depth rule, which the evidence supports, and pins the SHAPE of the deliberate gap in it.
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
	dnsZoneUnsupportedReason,
	dnsZoneUnsupportedReasonForCloud,
} from "@/lib/cloud-providers/dns-zone-support";

describe("dnsZoneUnsupportedReason", () => {
	it("refuses a .io domain on hetzner and names both the evidence and a remedy", () => {
		const reason = dnsZoneUnsupportedReason("hetzner", "alethialabs.io");
		expect(reason).toMatch(/unsupported tld/i);
		// A refusal with no next step reads as a bug, so both remedies must be present.
		expect(reason).toMatch(/Cloudflare/);
		expect(reason).toMatch(/TLD Hetzner hosts/);
	});

	it("allows the TLDs measured as accepted", () => {
		expect(dnsZoneUnsupportedReason("hetzner", "alethialabs.de")).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "alethialabs.com")).toBeNull();
	});

	it("refuses a subdomain of an ACCEPTED TLD — the case that shipped a four-minute apply failure", () => {
		// The whole point of #2843. `.com` is accepted, so this passed the gate and then died at
		// apply with `unsupported tld (422)` on hetzner/maxconfig run 32984975119.
		const reason = dnsZoneUnsupportedReason("hetzner", "shop.example.com");
		expect(reason).not.toBeNull();
		expect(reason).toMatch(/registrable domain only/);
	});

	it("...and the refusal tells the user what to do instead, in their own domain's terms", () => {
		// A refusal that only says no is the thing that gets worked around rather than acted on. It
		// must name the zone they should use and where the label they typed goes.
		const reason = dnsZoneUnsupportedReason("hetzner", "shop.example.com") ?? "";
		expect(reason).toContain('Use "example.com" as the domain');
		expect(reason).toContain('create "shop" as a record inside that zone');
		expect(reason).toMatch(/Cloudflare/);
	});

	it("refuses a deep subdomain too, and names the registrable domain rather than the first two labels", () => {
		const reason = dnsZoneUnsupportedReason("hetzner", "a.b.example.com") ?? "";
		expect(reason).toContain('Use "example.com" as the domain');
		expect(reason).toContain('create "a.b" as a record inside that zone');
	});

	it("does NOT refuse a registrable domain under a multi-part public suffix", () => {
		// `example.co.uk` is three labels and is nonetheless a registrable domain. Telling that from
		// a subdomain needs the public suffix list, which this repo does not carry — so under a
		// two-letter TLD the depth rule does not apply at all. Refusing a domain that would have
		// worked is worse than the gap it closes, and is not undoable by the person it happens to.
		expect(dnsZoneUnsupportedReason("hetzner", "example.co.uk")).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "example.com.au")).toBeNull();
	});

	it("MISSES a subdomain under a country-code TLD, deliberately — pin the gap so it stays a decision", () => {
		// Hetzner almost certainly refuses these; the rule cannot tell them from `example.co.uk`
		// without a public suffix list. It is a miss in the safe direction: the apply still refuses,
		// which is where this stood for every domain before #2568. If either ever starts returning a
		// reason, someone has added suffix data, and this expectation is the place to say so.
		expect(dnsZoneUnsupportedReason("hetzner", "shop.example.co.uk")).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "a.b.c.alethialabs.de")).toBeNull();
	});

	it("still refuses a denied TLD at two labels, and no longer claims the TLD was isolated", () => {
		// The .io denial is kept because an unnecessary refusal here is recoverable and an apply-time
		// 422 is not — but every .io probe on record was ALSO deeper than two labels, so it has never
		// been confirmed on its own. The message has to say that rather than assert a measurement
		// nobody made; that sentence was the defect in #2568.
		const reason = dnsZoneUnsupportedReason("hetzner", "alethialabs.io") ?? "";
		expect(reason).toMatch(/not yet confirmed on its own/);
		expect(reason).not.toMatch(/at the same domain depth/);
	});

	it("under a ccTLD only the denylist protects you — the depth rule cannot reach there", () => {
		// `e2e.alethialabs.io` was one of the two original probes, and the depth rule deliberately
		// does NOT fire on it: `.io` is a two-letter country code, and the public suffix list carries
		// `com.io`, so a three-label name under it can be registrable. This is not an oversight and
		// it is not free — it means the ONLY thing refusing this name is the `.io` denylist entry,
		// the one entry that has never been confirmed independently. Pinned so that removing the
		// denylist (which the probe in .github/workflows/hcloud-zone-probe.yml may well justify)
		// cannot silently stop refusing a name we have watched Hetzner refuse twice.
		expect(dnsZoneUnsupportedReason("hetzner", "e2e.alethialabs.io")).toMatch(/will not host a .io zone/);
	});

	it("tolerates the trailing dot and casing the canvas and CLI both accept", () => {
		expect(dnsZoneUnsupportedReason("hetzner", "alethialabs.IO")).not.toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "alethialabs.io.")).not.toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "  alethialabs.io  ")).not.toBeNull();
	});

	it("does not refuse on OTHER clouds — .io is a hetzner restriction, not a global one", () => {
		for (const p of ["aws", "gcp", "azure", "alibaba"] as const) {
			expect(dnsZoneUnsupportedReason(p, "alethialabs.io")).toBeNull();
		}
	});

	it("is silent with no cloud picked and with no domain typed", () => {
		// Two different questions with two different owners: `requiresProvider` asks the first, the
		// required-field check asks the second. Answering either here would give one question two
		// owners and produce a refusal before the user has done anything wrong.
		expect(dnsZoneUnsupportedReason(null, "alethialabs.io")).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", "")).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", null)).toBeNull();
		expect(dnsZoneUnsupportedReason("hetzner", undefined)).toBeNull();
	});

	it("is silent on a bare label with no TLD at all", () => {
		// "localhost" has no dot; treating the whole string as a TLD would refuse it on a rule that
		// says nothing about it.
		expect(dnsZoneUnsupportedReason("hetzner", "localhost")).toBeNull();
	});
});

describe("dnsZoneUnsupportedReasonForCloud", () => {
	it("agrees with the canvas-side sibling on hetzner", () => {
		expect(dnsZoneUnsupportedReasonForCloud("hetzner", "alethialabs.io")).toEqual(
			dnsZoneUnsupportedReason("hetzner", "alethialabs.io"),
		);
	});

	it("ALLOWS an unmeasured cloud rather than failing closed", () => {
		// The opposite of keylessUnavailableReasonForCloud, on purpose. Getting this backwards would
		// block deploys over a restriction that has never been shown to exist for that cloud.
		expect(dnsZoneUnsupportedReasonForCloud("aws", "alethialabs.io")).toBeNull();
	});
});
