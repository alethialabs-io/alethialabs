// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The repository URLs a scan accepts (lib/scanner/repo-url.ts): a public https:// URL with no
// credentials. Every other scheme, a local or internal name, a non-public address literal, and a
// host that resolves to a non-public address are refused, each with a sentence naming what to pass.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns/promises")>();
	return { ...actual, lookup: vi.fn() };
});

import { lookup } from "node:dns/promises";
import { assertScannableRepoUrl, RepoUrlRefusedError } from "@/lib/scanner/repo-url";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(lookup).mockResolvedValue([{ address: "140.82.121.4", family: 4 }] as never);
});

describe("assertScannableRepoUrl", () => {
	it("accepts a public https URL", async () => {
		expect(await assertScannableRepoUrl("  https://github.com/acme/api  ")).toBe("https://github.com/acme/api");
	});

	it.each([
		["not a URL", "github.com/acme/api"],
		["file", "file:///etc/passwd"],
		["ssh", "ssh://git@github.com/acme/api.git"],
		["git", "git://github.com/acme/api.git"],
		["http", "http://github.com/acme/api"],
		["embedded user", "https://token@github.com/acme/api"],
		["embedded password", "https://user:secret@github.com/acme/api"],
		["localhost", "https://localhost/acme/api"],
		["a .localhost name", "https://git.localhost/acme/api"],
		["a .local name", "https://gitea.local/acme/api"],
		["an .internal name", "https://git.corp.internal/acme/api"],
		["loopback", "https://127.0.0.1/acme/api"],
		["private", "https://10.1.2.3/acme/api"],
		["private 192.168", "https://192.168.1.10/acme/api"],
		["link-local metadata", "https://169.254.169.254/latest"],
		["CGNAT", "https://100.64.0.1/acme/api"],
		["IPv6 loopback", "https://[::1]/acme/api"],
	])("refuses %s", async (_label, url) => {
		await expect(assertScannableRepoUrl(url)).rejects.toBeInstanceOf(RepoUrlRefusedError);
	});

	it("refuses a public-looking name that resolves to a private address", async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as never);
		await expect(assertScannableRepoUrl("https://git.example.com/acme/api")).rejects.toThrow("not a public repository host");
	});

	it("refuses a host that does not resolve", async () => {
		vi.mocked(lookup).mockRejectedValue(new Error("ENOTFOUND"));
		await expect(assertScannableRepoUrl("https://nowhere.example/acme/api")).rejects.toBeInstanceOf(RepoUrlRefusedError);
	});
});
