// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Keyless readiness: can a customer's cloud verify an assertion this instance signs?
//
// A keyless connect (AWS, GCP, Azure, and Alibaba when re-enabled) works only when the cloud can
// fetch this instance's issuer discovery document and JWKS over HTTPS from the public internet, and
// only when the instance has a signing key to sign with. Either one missing, and every connect fails
// at the cloud's token exchange with an error that names neither. This module answers the question
// BEFORE the form is shown, so the connect sheet can say "this instance is not publicly reachable"
// instead of offering a connect that can only fail (EDN-H6).
//
// WHAT IS AND IS NOT CHECKED. The origin check reads the issuer URL itself: its scheme, and whether
// its host is a name or address that is private, local or reserved by definition (RFC 1918, loopback,
// link-local, CGNAT, unique-local IPv6, `localhost`, `.local`, `.internal`, `.home.arpa`, the RFC 6761
// test names, a single-label name). It does NOT resolve the name and does NOT probe the network: a
// public name behind a firewall reads as ready here and still fails at the cloud. That is the stated
// boundary — the check catches the configurations that cannot work, not every one that will not.
//
// This file is PURE and client-safe (no env, no node: imports). The server reads the environment in
// `keylessReadiness()` (`./assertion-source`) and hands the result to the browser as data.

/** Why a keyless connect cannot work on this instance. */
export type KeylessNotReadyReason =
	/** No issuer signing key: there is nothing to sign an assertion with. */
	| "signing-key-missing"
	/** No usable app URL: the issuer has no address for a cloud to fetch its keys from. */
	| "origin-missing"
	/** The app URL is not HTTPS: clouds fetch issuer keys only over HTTPS. */
	| "origin-not-https"
	/** The app URL's host is private, local or reserved: no cloud can reach it. */
	| "origin-not-public";

/** Whether this instance can serve a keyless connect, and if not, why. */
export type KeylessReadiness =
	| { readonly ready: true }
	| { readonly ready: false; readonly reason: KeylessNotReadyReason };

/** What `assessKeylessReadiness` reads. Every value comes from the server's environment. */
export interface KeylessReadinessInput {
	/** Whether the issuer signing key is set. Never the key itself. */
	readonly signingKeyConfigured: boolean;
	/** The full issuer URL (`${APP_URL}/api/oidc`), or `""` when no app URL is set. */
	readonly issuerUrl: string;
	/**
	 * Whether the E2E assertion broker supplies assertions instead of the local issuer. Its issuer is
	 * the broker's own HTTPS origin (enforced in `./assertion-source`), so this instance's URL is not
	 * what a cloud fetches keys from.
	 */
	readonly brokerConfigured: boolean;
}

/** The clouds whose connect federates off this instance's issuer, so need it publicly reachable. */
const ISSUER_CLOUDS: readonly string[] = ["aws", "gcp", "azure", "alibaba"];

/** Whether a cloud's connect depends on this instance's issuer being reachable. Token clouds do not. */
export function cloudNeedsPublicIssuer(slug: string): boolean {
	return ISSUER_CLOUDS.includes(slug);
}

/** Host names that are local or reserved by definition (RFC 6761, RFC 8375, ICANN `.internal`). */
const RESERVED_SUFFIXES: readonly string[] = [
	".localhost",
	".local",
	".internal",
	".home.arpa",
	".test",
	".invalid",
	".example",
];

/** The four octets of a dotted IPv4 literal, or `null` when `host` is not one. */
function ipv4Octets(host: string): readonly number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
	const octets = parts.map(Number);
	return octets.every((o) => o <= 255) ? octets : null;
}

/** Whether an IPv4 address is private, loopback, link-local, CGNAT or unspecified. */
function isNonPublicIpv4([a = 0, b = 0]: readonly number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

/** Whether a bracket-free IPv6 literal is loopback, unspecified, unique-local or link-local. */
function isNonPublicIpv6(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "::" || h === "::1") return true;
	// An IPv4-mapped address (`::ffff:a.b.c.d`, which the URL parser renders as `::ffff:xxxx:xxxx`)
	// is judged as the IPv4 address it carries.
	const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mapped) {
		const hi = Number.parseInt(mapped[1] ?? "0", 16);
		return isNonPublicIpv4([hi >> 8, hi & 0xff]);
	}
	const first = Number.parseInt(h.split(":")[0] || "0", 16);
	// fc00::/7 (unique-local) and fe80::/10 (link-local).
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * Judges the issuer URL alone: `null` when a cloud could fetch keys from it, else the reason it
 * cannot. See the header for what this does and does not establish.
 */
export function assessIssuerOrigin(issuerUrl: string): KeylessNotReadyReason | null {
	let url: URL;
	try {
		url = new URL(issuerUrl);
	} catch {
		return "origin-missing";
	}
	if (url.hostname === "") return "origin-missing";
	if (url.protocol !== "https:") return "origin-not-https";
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host.startsWith("[")) {
		return isNonPublicIpv6(host.slice(1, -1)) ? "origin-not-public" : null;
	}
	const octets = ipv4Octets(host);
	if (octets !== null) return isNonPublicIpv4(octets) ? "origin-not-public" : null;
	if (host === "localhost" || !host.includes(".")) return "origin-not-public";
	if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "origin-not-public";
	return null;
}

/**
 * Whether a keyless connect can work, from the server's view of its own configuration. A missing key
 * is reported before the origin: without it there is nothing to publish, wherever the instance lives.
 */
export function assessKeylessReadiness(input: KeylessReadinessInput): KeylessReadiness {
	if (input.brokerConfigured) return { ready: true };
	if (!input.signingKeyConfigured) return { ready: false, reason: "signing-key-missing" };
	const reason = assessIssuerOrigin(input.issuerUrl);
	return reason === null ? { ready: true } : { ready: false, reason };
}
