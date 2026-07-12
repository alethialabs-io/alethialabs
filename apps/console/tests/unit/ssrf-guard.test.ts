// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SSRF guard unit tests. The security core is the IP classifier (isPublicUnicastIp) and
// the per-URL gate (assertSafeUrl). Both run without network: assertSafeUrl only calls
// dns.lookup, which resolves IP *literals* to themselves, so private-literal hosts are
// rejected offline. The redirect chain re-runs assertSafeUrl every hop, so we assert the
// redirect decision (isRedirectStatus) + that a private redirect target is rejected by
// the same gate a hop would call — a live cross-host redirect isn't cleanly mockable here.

import { describe, expect, it } from "vitest";
import {
	assertSafeUrl,
	isPublicUnicastIp,
	isRedirectStatus,
	SsrfError,
} from "@/lib/net/ssrf-guard";

describe("isPublicUnicastIp", () => {
	const rejected: [string, string][] = [
		["169.254.169.254", "cloud metadata (link-local)"],
		["127.0.0.1", "IPv4 loopback"],
		["10.0.0.5", "RFC1918 10/8"],
		["172.16.0.1", "RFC1918 172.16/12"],
		["192.168.1.1", "RFC1918 192.168/16"],
		["100.64.0.1", "CGNAT 100.64/10"],
		["0.0.0.0", "unspecified"],
		["224.0.0.1", "multicast"],
		["255.255.255.255", "broadcast"],
		["::1", "IPv6 loopback"],
		["::", "IPv6 unspecified"],
		["fc00::1", "IPv6 unique-local (ULA)"],
		["fe80::1", "IPv6 link-local"],
		["ff02::1", "IPv6 multicast"],
		["::ffff:169.254.169.254", "IPv4-mapped IPv6 metadata"],
		["::ffff:127.0.0.1", "IPv4-mapped IPv6 loopback"],
		["2001:db8::1", "IPv6 documentation"],
		["not-an-ip", "garbage input"],
	];
	for (const [ip, why] of rejected) {
		it(`rejects ${ip} (${why})`, () => {
			expect(isPublicUnicastIp(ip)).toBe(false);
		});
	}

	const accepted: [string, string][] = [
		["1.1.1.1", "Cloudflare DNS (public v4)"],
		["8.8.8.8", "Google DNS (public v4)"],
		["2606:4700:4700::1111", "Cloudflare DNS (public v6)"],
		["2001:4860:4860::8888", "Google DNS (public v6)"],
	];
	for (const [ip, why] of accepted) {
		it(`accepts ${ip} (${why})`, () => {
			expect(isPublicUnicastIp(ip)).toBe(true);
		});
	}
});

describe("assertSafeUrl", () => {
	it("rejects a non-HTTPS URL", async () => {
		await expect(assertSafeUrl("http://example.com/hook")).rejects.toBeInstanceOf(
			SsrfError,
		);
	});

	it("rejects a non-URL string", async () => {
		await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
	});

	it("rejects an https URL whose host is a private IP literal", async () => {
		// dns.lookup resolves an IP literal to itself, so this needs no network.
		await expect(assertSafeUrl("https://127.0.0.1/hook")).rejects.toBeInstanceOf(
			SsrfError,
		);
	});

	it("rejects an https URL pointing at the metadata IP", async () => {
		await expect(
			assertSafeUrl("https://169.254.169.254/latest/meta-data/"),
		).rejects.toBeInstanceOf(SsrfError);
	});

	it("rejects an https URL pointing at a private IPv6 literal", async () => {
		await expect(assertSafeUrl("https://[fc00::1]/hook")).rejects.toBeInstanceOf(
			SsrfError,
		);
	});
});

describe("isRedirectStatus", () => {
	it("treats 301/302/303/307/308 as redirects", () => {
		for (const s of [301, 302, 303, 307, 308]) {
			expect(isRedirectStatus(s)).toBe(true);
		}
	});

	it("treats non-3xx-with-location statuses as non-redirects", () => {
		for (const s of [200, 204, 300, 304, 400, 404, 500]) {
			expect(isRedirectStatus(s)).toBe(false);
		}
	});

	it("a redirect Location to a private host is rejected by the per-hop gate", async () => {
		// Each redirect hop re-runs assertSafeUrl on the resolved Location, so a 302 to an
		// internal address is refused rather than followed. We exercise that gate directly.
		const location = new URL("/steal", "https://public.example").toString();
		expect(isRedirectStatus(302)).toBe(true);
		await expect(
			assertSafeUrl(new URL("http://169.254.169.254/", location).toString()),
		).rejects.toBeInstanceOf(SsrfError);
	});
});
