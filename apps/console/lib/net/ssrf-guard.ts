// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SSRF guard for outbound requests to *user-supplied* hosts (alert-channel webhooks).
//
// The console is the control plane and must NEVER be tricked into calling an internal
// address on behalf of a user. Alert channels store an arbitrary customer webhook URL
// (any Slack/Discord/self-hosted host), so an allowlist is impossible — instead this
// module fails closed against private/internal address space:
//
//   1. Scheme must be https:.
//   2. The hostname is DNS-resolved and EVERY resolved address is classified; if any is
//      not a public unicast address the request is rejected.
//   3. The socket is pinned to the pre-validated address(es) via an undici `Agent` with a
//      custom `connect.lookup`, so a second DNS lookup at connect time cannot steer the
//      connection elsewhere (defeats DNS-rebinding TOCTOU).
//   4. Redirects are handled manually (`redirect: "manual"`): each hop re-runs the full
//      guard, so a 3xx to a private host is rejected rather than followed.
//
// `safeFetch` is the single sink the alert senders call instead of raw `fetch`.

import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
	Agent,
	fetch as undiciFetch,
	type RequestInit,
	type Response,
} from "undici";

/** Default per-request timeout (matches the alert senders' historical 10s budget). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Maximum number of redirects followed before failing closed. */
const MAX_REDIRECTS = 3;

/** Timeout for the DNS resolution step (getaddrinfo has no signal — raced against a timer). */
const DNS_TIMEOUT_MS = 5_000;

/**
 * DNS-resolves a host with a hard timeout. `dns.lookup` uses libuv's getaddrinfo threadpool and
 * takes no AbortSignal, so a slow resolver could otherwise hang outside the request budget — race
 * it against a timer and reject as an `SsrfError` on timeout.
 */
async function lookupWithTimeout(host: string): Promise<LookupAddress[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new SsrfError(`DNS lookup timed out for host: ${host}`)),
			DNS_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([dnsLookup(host, { all: true }), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Error raised when a request is refused by the SSRF guard. */
export class SsrfError extends Error {
	/** @param message Human-readable reason the request was refused. */
	constructor(message: string) {
		super(message);
		this.name = "SsrfError";
	}
}

/**
 * Parses any IPv4 or IPv6 literal into its raw bytes (4 for v4, 16 for v6), expanding
 * `::` compression and any embedded IPv4 suffix. Returns `null` for unparseable input.
 * The input is expected to already be a valid literal (from `dns.lookup`).
 */
function ipToBytes(ip: string): number[] | null {
	if (isIPv4(ip)) {
		const parts = ip.split(".").map((p) => Number(p));
		if (parts.length !== 4) return null;
		for (const b of parts) {
			if (!Number.isInteger(b) || b < 0 || b > 255) return null;
		}
		return parts;
	}
	if (!isIPv6(ip)) return null;

	// Strip any zone id (e.g. fe80::1%eth0) — irrelevant to classification.
	let text = ip.split("%")[0];

	// Fold an embedded trailing IPv4 (e.g. ::ffff:1.2.3.4) into two hextets.
	if (text.includes(".")) {
		const idx = text.lastIndexOf(":");
		const v4 = text.slice(idx + 1);
		if (!isIPv4(v4)) return null;
		const o = v4.split(".").map((p) => Number(p));
		const hi = ((o[0] << 8) | o[1]).toString(16);
		const lo = ((o[2] << 8) | o[3]).toString(16);
		text = `${text.slice(0, idx + 1)}${hi}:${lo}`;
	}

	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

	let groups: string[];
	if (tail === null) {
		groups = head;
	} else {
		const missing = 8 - (head.length + tail.length);
		if (missing < 0) return null;
		groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
	}
	if (groups.length !== 8) return null;

	const bytes: number[] = [];
	for (const g of groups) {
		if (g === "") return null;
		const n = Number.parseInt(g, 16);
		if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
		bytes.push((n >> 8) & 0xff, n & 0xff);
	}
	return bytes;
}

/**
 * Classifies four IPv4 bytes: `true` only for globally-routable public unicast space.
 * Blocks loopback, RFC1918 private, link-local (incl. the 169.254.169.254 metadata IP),
 * CGNAT, unspecified, documentation/benchmark ranges, multicast, and reserved/broadcast.
 */
function isPublicUnicastV4(bytes: number[]): boolean {
	const [a, b, c] = bytes;
	if (a === 0) return false; // 0.0.0.0/8 "this network" / unspecified
	if (a === 10) return false; // 10.0.0.0/8 private
	if (a === 127) return false; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local (metadata)
	if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 private
	if (a === 192 && b === 168) return false; // 192.168.0.0/16 private
	if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
	if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF protocol
	if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 TEST-NET-1
	if (a === 192 && b === 88 && c === 99) return false; // 192.88.99.0/24 6to4 anycast
	if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmark
	if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 TEST-NET-3
	if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
	return true;
}

/**
 * Classifies sixteen IPv6 bytes: `true` only for globally-routable public unicast space.
 * Unwraps IPv4-mapped / IPv4-compatible / NAT64 / 6to4 forms and re-classifies the
 * embedded IPv4; blocks unspecified (::), loopback (::1), ULA (fc00::/7), link-local
 * (fe80::/10), multicast (ff00::/8), and documentation (2001:db8::/32).
 */
function isPublicUnicastV6(bytes: number[]): boolean {
	const zeros = (start: number, end: number): boolean => {
		for (let i = start; i < end; i++) {
			if (bytes[i] !== 0) return false;
		}
		return true;
	};

	// ::ffff:a.b.c.d — IPv4-mapped: classify the embedded v4.
	if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return isPublicUnicastV4(bytes.slice(12, 16));
	}
	// First 96 bits zero: ::, ::1, or deprecated IPv4-compatible ::a.b.c.d.
	if (zeros(0, 12)) {
		const v4 = bytes.slice(12, 16);
		if (v4.every((x) => x === 0)) return false; // :: unspecified
		if (v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 1) return false; // ::1
		return isPublicUnicastV4(v4); // IPv4-compatible (deprecated)
	}
	// 64:ff9b::/96 NAT64 — classify the embedded v4.
	if (
		bytes[0] === 0x00 &&
		bytes[1] === 0x64 &&
		bytes[2] === 0xff &&
		bytes[3] === 0x9b &&
		zeros(4, 12)
	) {
		return isPublicUnicastV4(bytes.slice(12, 16));
	}
	// 2002::/16 6to4 — the next 32 bits embed the v4; classify it.
	if (bytes[0] === 0x20 && bytes[1] === 0x02) {
		return isPublicUnicastV4(bytes.slice(2, 6));
	}
	if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique-local (ULA)
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
	if (bytes[0] === 0xff) return false; // ff00::/8 multicast
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
		return false; // 2001:db8::/32 documentation
	}
	if (bytes[0] === 0x01 && bytes[1] === 0x00 && zeros(2, 8)) return false; // 100::/64 discard
	// Anything else in 0000::/8 is reserved/unroutable — the legitimate ::/8 sub-forms (unspecified,
	// loopback, IPv4-mapped/-compatible, NAT64) are all decoded and returned above, and global
	// unicast is 2000::/3 (never a 0x00 leading byte). Fail closed on the remainder (e.g. the odd
	// `::ffff:0:a.b.c.d` shape) rather than treating it as public.
	if (bytes[0] === 0x00) return false;
	return true;
}

/**
 * Returns `true` only if `ip` is a public, globally-routable unicast address. Any
 * loopback / private / link-local / CGNAT / reserved / multicast / unspecified address
 * (IPv4 or IPv6, including IPv4-mapped IPv6) returns `false`, as does unparseable input.
 */
export function isPublicUnicastIp(ip: string): boolean {
	const bytes = ipToBytes(ip);
	if (!bytes) return false;
	if (bytes.length === 4) return isPublicUnicastV4(bytes);
	if (bytes.length === 16) return isPublicUnicastV6(bytes);
	return false;
}

/** Returns `true` if an HTTP status is a redirect that carries a `Location`. */
export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Validates a single URL for outbound use: requires `https:`, DNS-resolves the host, and
 * asserts every resolved address is public unicast. Throws `SsrfError` on any violation;
 * otherwise returns the parsed URL and the validated addresses (to pin the connection).
 */
export async function assertSafeUrl(
	url: string,
): Promise<{ url: URL; addresses: LookupAddress[] }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new SsrfError("Invalid request URL.");
	}
	if (parsed.protocol !== "https:") {
		throw new SsrfError(`Refusing non-HTTPS request URL: ${parsed.protocol}`);
	}

	// Strip IPv6 brackets from the hostname before resolving/classifying.
	const host = parsed.hostname.replace(/^\[|\]$/g, "");

	let addresses: LookupAddress[];
	try {
		addresses = await lookupWithTimeout(host);
	} catch (err) {
		if (err instanceof SsrfError) throw err; // preserve the timeout reason
		throw new SsrfError(`Could not resolve host: ${parsed.hostname}`);
	}
	if (addresses.length === 0) {
		throw new SsrfError(`Host did not resolve to any address: ${parsed.hostname}`);
	}
	for (const { address } of addresses) {
		if (!isPublicUnicastIp(address)) {
			throw new SsrfError(
				`Refusing to connect to non-public address ${address} for host ${parsed.hostname}`,
			);
		}
	}
	return { url: parsed, addresses };
}

/**
 * Builds a `lookup` that always resolves to the pre-validated addresses, so the socket
 * connects to exactly the IPs we classified — a second DNS lookup cannot rebind the host.
 * Handles both the single-address and `{ all: true }` (happy-eyeballs) call shapes.
 */
function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
	return (_hostname, options, callback) => {
		if (options.all) {
			callback(null, addresses);
		} else {
			const first = addresses[0];
			callback(null, first.address, first.family);
		}
	};
}

/**
 * SSRF-safe replacement for `fetch`, for requests to user-supplied hosts. Enforces
 * HTTPS, DNS-resolve-then-pin classification, and manual redirect re-validation (capped
 * at {@link MAX_REDIRECTS}). Honours the caller's `signal` and additionally enforces a
 * {@link DEFAULT_TIMEOUT_MS} timeout across the whole redirect chain.
 *
 * @param url  The user-supplied target URL.
 * @param init Standard fetch init (method/headers/body/signal). `redirect` and
 *             `dispatcher` are managed internally and ignored if supplied.
 * @throws {SsrfError} if the URL, any resolved address, or any redirect target is unsafe.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
	const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	const signal =
		init?.signal != null ? AbortSignal.any([init.signal, timeout]) : timeout;

	let currentUrl = url;
	for (let hop = 0; ; hop++) {
		const { url: parsed, addresses } = await assertSafeUrl(currentUrl);
		const agent = new Agent({
			connect: { lookup: pinnedLookup(addresses), timeout: DEFAULT_TIMEOUT_MS },
		});

		const requestInit: RequestInit = {
			...init,
			redirect: "manual",
			signal,
			dispatcher: agent,
		};

		// NB: undici's own fetch, not Node's global fetch. Node's built-in fetch ships
		// its own bundled undici, which rejects a dispatcher built from this (separately
		// installed) undici version — so the pinning dispatcher only works via this fetch.
		let res: Response;
		try {
			res = await undiciFetch(parsed, requestInit);
		} catch (err) {
			void agent.close().catch(() => {});
			throw err;
		}

		if (isRedirectStatus(res.status)) {
			const location = res.headers.get("location");
			if (location) {
				// Discard this hop's body and reap its connection pool before continuing.
				await res.body?.cancel().catch(() => {});
				void agent.close().catch(() => {});
				if (hop >= MAX_REDIRECTS) {
					throw new SsrfError(`Too many redirects (>${MAX_REDIRECTS}).`);
				}
				// Resolve relative Locations against the current URL; the next loop
				// iteration re-runs assertSafeUrl, rejecting a redirect to a private host.
				currentUrl = new URL(location, parsed).toString();
				continue;
			}
		}
		// Final response: the caller owns the body, so leave the socket to undici's
		// keep-alive reaper rather than closing the agent out from under it.
		return res;
	}
}
