// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema/enums";
import type { CloudProviderSlug } from "./generated/catalog";

/**
 * TLDs a cloud's own DNS service refuses to host a zone for — the SINGLE source of truth shared by
 * the canvas `domain_name` field and the deploy-time fail-closed gate (`buildConfigSnapshot`).
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
 * Probed directly against the live API on 2026-08-25 (all probe zones deleted afterwards):
 *
 *   probe-hcloud.alethialabs.io   → unsupported tld (422)
 *   probe1.e2e.alethialabs.io     → unsupported tld (422)
 *   alethia-probe-zz19.de         → created
 *   alethia-probe-zz19.com        → created
 *
 * The first two rule out the obvious alternative reading: it is NOT subdomain depth. A three-label
 * and a four-label name fail identically while `.de` and `.com` succeed at the same depth, so the
 * TLD is the variable.
 */
const UNSUPPORTED_TLDS_BY_PROVIDER: Partial<Record<string, ReadonlySet<string>>> = {
	hetzner: new Set(["io"]),
};

/** Lowercased final label of a domain, or "" when there isn't one. Trailing dots and surrounding
 * whitespace are tolerated because the canvas and the CLI both accept either form — the template
 * itself does `trimsuffix(trimspace(...), ".")` for the same reason. */
function tldOf(domainName: string): string {
	const trimmed = domainName.trim().replace(/\.+$/, "").toLowerCase();
	const dot = trimmed.lastIndexOf(".");
	return dot === -1 ? "" : trimmed.slice(dot + 1);
}

function reasonFor(provider: string, domainName: string): string | null {
	const denied = UNSUPPORTED_TLDS_BY_PROVIDER[provider];
	if (!denied) return null;
	const tld = tldOf(domainName);
	if (!tld || !denied.has(tld)) return null;
	return (
		`Hetzner DNS will not host a .${tld} zone. Its API refuses the create with ` +
		`"unsupported tld" (422) — verified against the live API, where .de and .com are accepted ` +
		`and .${tld} is not, at the same domain depth. Either point this project's DNS at a ` +
		`connected provider such as Cloudflare, or use a domain on a TLD Hetzner hosts.`
	);
}

/**
 * Why this cloud's own DNS cannot host a zone for this domain, or null when it can.
 *
 * A null provider returns null — "no cloud picked yet" is not a refusal. An EMPTY domain also
 * returns null: "you have not typed one yet" is a different question, and the required-field check
 * already owns it. One case, one owner.
 */
export function dnsTldUnsupportedReason(
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
export function dnsTldUnsupportedReasonForCloud(
	provider: CloudProvider,
	domainName: string | null | undefined,
): string | null {
	if (!domainName) return null;
	return reasonFor(provider, domainName);
}
