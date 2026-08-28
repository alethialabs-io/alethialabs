// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema/enums";
import type { CloudProviderSlug } from "./generated/catalog";

/**
 * Zone names a cloud's own DNS service refuses to host — the source of truth for the deploy-time
 * fail-closed gate in `buildConfigSnapshot`.
 *
 * IT WAS "TLDs" UNTIL #2843, AND THAT WAS THE WRONG AXIS. Hetzner refuses a zone name deeper than
 * its registrable domain too, with the SAME "unsupported tld" message — so a user typing an ordinary
 * subdomain on an accepted TLD passed this gate and died four minutes into the apply. See the
 * evidence block below, which is where the mistake is worth reading rather than just fixing.
 *
 * ⚠️ THE CANVAS HALF IS NOT WIRED YET, and this comment used to claim it was. `dnsZoneUnsupportedReason`
 * is exported for it but has no caller outside its own tests, so a user typing `example.io` into the
 * DNS inspector still gets no feedback until they press Plan or Deploy.
 *
 * It is not wired because the obvious mechanism is the wrong one. `unavailableWhen` — which is how
 * `waf_enabled` gates — REPLACES the control with prose (`config-fields.tsx:291`), so keying it on the
 * typed value would delete the domain field the moment you typed a denied TLD, leaving no way to
 * correct it. A switch you can see is off is a good answer; a text input that vanishes as you type is
 * not. Value-level validation on a text field has no hook in the schema today, and adding one is a
 * feature rather than a fix — so this stays server-side until that exists.
 * Modelled on `waf.ts`: a tiny runtime-only module with no client (`lucide-react`/React-Flow)
 * imports, so the server action can import it without pulling the canvas registry into the server
 * bundle.
 *
 * This exists because the failure it prevents is invisible until apply. Every other cloud's DNS API
 * creates a public zone for ANY syntactically valid name without inspecting the TLD, so nothing in
 * a plan, a preview or a form told the user their domain would be refused. Hetzner's does inspect
 * it, and answers with a 422 that names a FIELD rather than a cause:
 *
 *   Error: Invalid field in API request
 *     with hcloud_zone.this[0], on dns.tf line 18
 *     unsupported tld (invalid_input)  ·  Field: name  ·  Status code: 422
 *
 * Warning a user before they pick a cloud they cannot use is the product's whole reason to exist, so
 * this is surfaced rather than merely recorded as a ceiling.
 */

/**
 * MEASURED, and deliberately a DENYLIST rather than an allowlist.
 *
 * Hetzner publishes no supported-TLD list and exposes no endpoint to enumerate one — `hcloud zone`
 * has no such subcommand and the API returns nothing resembling a catalogue. So an allowlist could
 * only be a guess, and guessing wrong here REFUSES a domain that would have worked, which is worse
 * than the gap it closes. A denylist can only ever be incomplete, and an incomplete denylist fails
 * in the safe direction: the apply still refuses, exactly as it does today.
 *
 * WHAT IS ACTUALLY MEASURED, and what the previous reading got wrong. Probed against the live API on
 * 2026-08-25 (all probe zones deleted afterwards), plus one cell supplied by hetzner/maxconfig run
 * 32984975119:
 *
 *   name                                 labels  tld   result
 *   probe-hcloud.alethialabs.io               3  io    unsupported tld (422)
 *   probe1.e2e.alethialabs.io                 4  io    unsupported tld (422)
 *   32984975119-1.e2e.alethia-e2e.com         4  com   unsupported tld (422)
 *   alethia-probe-zz19.de                     2  de    created
 *   alethia-probe-zz19.com                    2  com   created
 *
 * This block used to end: "A three-label and a four-label name fail identically while .de and .com
 * succeed AT THE SAME DEPTH, so the TLD is the variable." They are not at the same depth. Both
 * successes are two labels and every failure is three or four, so depth and TLD were varied
 * TOGETHER and the experiment cannot separate them. The sentence claiming it does was the one thing
 * in this file that was never measured — and it is the reason the gate has been checking the wrong
 * property.
 *
 * READ DOWN THE `labels` COLUMN AND IT IS MONOTONE: every 2-label name was created, every deeper one
 * refused, on TWO different TLDs. Depth explains all five observations. The TLD explains none of them
 * without the confound. That is why the depth rule below is the one that refuses, and why the `.io`
 * denylist is kept but marked unconfirmed — .io has never been tried at two labels, which is the
 * single cell that would settle it.
 *
 * THE MISSING CELLS ARE ONE DISPATCH AWAY: `.github/workflows/hcloud-zone-probe.yml` runs
 * `scripts/e2e/probe-hcloud-zone-support.sh`, which creates and then deletes exactly the five names
 * that separate the two variables — including `.io` at two labels and a multi-part public suffix at
 * three. It needs the e2e project's HCLOUD_TOKEN, so it cannot run from a laptop whose only hcloud
 * contexts are production. Run it and this comment becomes measurement rather than inference.
 */
/**
 * Keyed on `CloudProvider`, NOT `string`. A `string` key accepts a typo — `hetnzer` — or
 * survives a provider-slug rename, and either compiles clean while `reasonFor` returns null for
 * every domain and the gate goes silently inert. The only test that would fail is the one that
 * happens to spell the key correctly. A typed key makes a rename a compile error instead.
 *
 * `vendor` lives beside the TLD set because the message names it: with a single hardcoded "Hetzner"
 * in `reasonFor`, adding `alibaba` here would tell an Alibaba user that "Hetzner DNS will not host
 * a .xyz zone", confidently and wrongly.
 */
const UNSUPPORTED_ZONES_BY_PROVIDER: Partial<
	Record<
		CloudProvider,
		{
			vendor: string;
			accepted: string;
			/** TLDs measured as refused. Incomplete on purpose — see the header's denylist argument. */
			denied: ReadonlySet<string>;
			/**
			 * The vendor hosts a zone for a registrable domain only, so a subdomain is refused too.
			 * A separate flag rather than an assumption: every other cloud's DNS API creates a zone
			 * for any syntactically valid name, and turning this on for one of them would refuse a
			 * config that works.
			 */
			registrableOnly: boolean;
		}
	>
> = {
	hetzner: {
		vendor: "Hetzner",
		accepted: ".de and .com",
		denied: new Set(["io"]),
		// Hetzner hosts a zone for a REGISTRABLE domain only. Every observation above is consistent
		// with this and nothing else, and it is what makes the 422's "unsupported tld" wording make
		// sense: given `shop.example.com`, Hetzner appears to read `example.com` as the TLD and finds
		// it in no supported list.
		registrableOnly: true,
	},
};

/**
 * A two-letter TLD may be a country code, and a country code is where multi-part public suffixes
 * live — `co.uk`, `com.au`, `co.jp`, `com.br`. Under one of those, `example.co.uk` is THREE labels
 * and is nonetheless a registrable domain, indistinguishable from a subdomain without the public
 * suffix list, which this repo does not carry and will not guess at.
 *
 * SO THE DEPTH RULE SIMPLY DOES NOT APPLY THERE. Under a gTLD — `.com`, `.net`, `.org`, `.io`,
 * `.dev` — the ICANN list has no multi-part suffix at all, so a name with three or more labels is
 * unambiguously a subdomain and refusing it cannot be wrong. Under a ccTLD it might be either, so
 * nothing is refused: this misses `shop.example.co.uk`, deliberately.
 *
 * That asymmetry is the same trade the denylist above makes, pointed the same way. An incomplete
 * rule that refuses only what it is certain about lets a broken config through and the apply still
 * catches it. A rule that guesses REFUSES A DOMAIN THAT WOULD HAVE WORKED, which is worse than the
 * gap it closes and is not undoable by the person it happens to.
 */
const COUNTRY_CODE_TLD = /^[a-z]{2}$/;

/** A domain's labels, lowercased, with a trailing dot and surrounding whitespace tolerated. */
function labelsOf(domainName: string): string[] {
	const trimmed = domainName.trim().replace(/\.+$/, "").toLowerCase();
	return trimmed === "" ? [] : trimmed.split(".");
}

/**
 * Lowercased final label of a domain, or "" when there isn't one.
 *
 * Derived from `labelsOf` rather than re-parsing, so the two cannot disagree about a trailing dot —
 * the canvas and the CLI both accept either form, and the template itself does
 * `trimsuffix(trimspace(...), ".")` for the same reason.
 */
function tldOf(domainName: string): string {
	const labels = labelsOf(domainName);
	return labels.length < 2 ? "" : (labels.at(-1) ?? "");
}

function reasonFor(provider: CloudProvider, domainName: string): string | null {
	const entry = UNSUPPORTED_ZONES_BY_PROVIDER[provider];
	if (!entry) return null;
	const labels = labelsOf(domainName);
	const tld = tldOf(domainName);
	if (!tld) return null;

	// DEPTH FIRST, because it is the rule the evidence actually supports, and because a name that is
	// both too deep AND on a denied TLD is better explained by the half we are sure of.
	if (entry.registrableOnly && labels.length > 2 && !COUNTRY_CODE_TLD.test(tld)) {
		const registrable = labels.slice(-2).join(".");
		const sub = labels.slice(0, -2).join(".");
		return (
			`${entry.vendor} DNS hosts a zone for a registrable domain only, so it will not host ` +
			`"${labels.join(".")}". Its API refuses the create with "unsupported tld" (422) — a message ` +
			`that names a field rather than the cause, four minutes into the apply, which is why this is ` +
			`checked here instead. Use "${registrable}" as the domain and create "${sub}" as a record ` +
			`inside that zone, or point this project's DNS at a connected provider such as Cloudflare, ` +
			`which hosts a subdomain zone directly.`
		);
	}

	if (!entry.denied.has(tld)) return null;
	return (
		`${entry.vendor} DNS will not host a .${tld} zone. Its API refuses the create with ` +
		`"unsupported tld" (422) — measured against the live API, where ${entry.accepted} are accepted ` +
		`and .${tld} is not. Note that every .${tld} probe on record was also deeper than two labels, ` +
		`which is independently refused, so this TLD denial is not yet confirmed on its own; it is kept ` +
		`because an unnecessary refusal here is recoverable and an apply-time 422 is not. Either point ` +
		`this project's DNS at a connected provider such as Cloudflare, or use a domain on a TLD ` +
		`${entry.vendor} hosts.`
	);
}

/**
 * Why this cloud's own DNS cannot host a zone for this domain, or null when it can.
 *
 * A null provider returns null — "no cloud picked yet" is not a refusal. An EMPTY domain also
 * returns null: "you have not typed one yet" is a different question, and the required-field check
 * already owns it. One case, one owner.
 */
export function dnsZoneUnsupportedReason(
	provider: CloudProviderSlug | null,
	domainName: string | null | undefined,
): string | null {
	if (!provider || !domainName) return null;
	return reasonFor(provider, domainName);
}

/**
 * The server-side sibling, taking the full generated `cloud_provider` enum.
 *
 * A cloud absent from the table is ALLOWED, matching `wafUnavailableReasonForCloud` and for the same
 * reason: this gate exists to stop a config making a promise the cloud will refuse, not to police
 * every cloud we have not measured. Refusing an unmeasured cloud would block deploys that work.
 */
export function dnsZoneUnsupportedReasonForCloud(
	provider: CloudProvider,
	domainName: string | null | undefined,
): string | null {
	if (!domainName) return null;
	return reasonFor(provider, domainName);
}
