// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CLI-L11a: every /api/cli response carries a request id, and a CLI below the configured minimum
// gets 426 with `code: "cli_too_old"`. The proxy is driven directly, as the route layer would see it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
	CLI_TOO_OLD_CODE,
	checkCliHandshake,
	formatCliVersion,
	isBelowMinimum,
	isCliApiPath,
	newCliRequestId,
	parseCliVersion,
	requestCliVersion,
} from "@/lib/cli/version";

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

const at = (url: string, headers?: HeadersInit) =>
	new NextRequest(new Request(`https://console.example.invalid${url}`, { headers }));

/** Parses a version the test knows to be valid, failing the test if it is not. */
function v(raw: string) {
	const parsed = parseCliVersion(raw);
	if (!parsed) throw new Error(`test fixture ${raw} does not parse`);
	return parsed;
}

/** The request id the proxy forwarded to the route handler, or null when it forwarded none. */
function forwardedRequestId(res: Response): string | null {
	const overridden = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
	if (!overridden.includes("x-request-id")) return null;
	return res.headers.get("x-middleware-request-x-request-id");
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("parseCliVersion", () => {
	it("reads a release, a v-prefixed release and a pre-release", () => {
		expect(parseCliVersion("1.4.2")).toEqual({ major: 1, minor: 4, patch: 2, prerelease: null });
		expect(parseCliVersion(" v0.12.0 ")).toEqual({ major: 0, minor: 12, patch: 0, prerelease: null });
		expect(parseCliVersion("2.0.0-rc.1+abc")).toEqual({
			major: 2,
			minor: 0,
			patch: 0,
			prerelease: "rc.1",
		});
	});

	it("rejects everything that is not a plain semantic version", () => {
		const rejected = ["", "dev", "1.2", "1.2.3.4", "01.2.3", "1.2.3; x", "1.2.3 extra", null, undefined]
			.filter((raw) => parseCliVersion(raw) !== null);
		expect(rejected).toEqual([]);
	});

	it("renders back without the v prefix or build metadata", () => {
		expect(formatCliVersion(v("v1.4.2"))).toBe("1.4.2");
		expect(formatCliVersion(v("2.0.0-rc.1+abc"))).toBe("2.0.0-rc.1");
	});
});

describe("isBelowMinimum", () => {
	it("orders by major, minor, then patch", () => {
		expect(isBelowMinimum(v("0.9.9"), v("1.0.0"))).toBe(true);
		expect(isBelowMinimum(v("1.3.9"), v("1.4.0"))).toBe(true);
		expect(isBelowMinimum(v("1.4.0"), v("1.4.1"))).toBe(true);
		expect(isBelowMinimum(v("1.4.1"), v("1.4.1"))).toBe(false);
		expect(isBelowMinimum(v("1.5.0"), v("1.4.9"))).toBe(false);
		expect(isBelowMinimum(v("2.0.0"), v("1.9.9"))).toBe(false);
	});

	it("puts a pre-release before its release, and does not order two pre-releases", () => {
		expect(isBelowMinimum(v("1.4.0-rc.1"), v("1.4.0"))).toBe(true);
		expect(isBelowMinimum(v("1.4.0"), v("1.4.0-rc.1"))).toBe(false);
		expect(isBelowMinimum(v("1.4.0-rc.1"), v("1.4.0-rc.2"))).toBe(false);
	});
});

describe("requestCliVersion", () => {
	it("prefers the version header", () => {
		const headers = new Headers({
			"x-alethia-cli-version": "1.2.3",
			"user-agent": "alethia-cli/9.9.9 (linux; amd64)",
		});
		expect(requestCliVersion(headers)).toEqual(v("1.2.3"));
	});

	it("falls back to the User-Agent product token", () => {
		const headers = new Headers({ "user-agent": "alethia-cli/1.2.3 (darwin; arm64)" });
		expect(requestCliVersion(headers)).toEqual(v("1.2.3"));
	});

	it("reads nothing from a dev build, a browser or a bare request", () => {
		expect(requestCliVersion(new Headers({ "x-alethia-cli-version": "dev" }))).toBeNull();
		expect(requestCliVersion(new Headers({ "user-agent": "Mozilla/5.0" }))).toBeNull();
		expect(requestCliVersion(new Headers())).toBeNull();
	});
});

describe("checkCliHandshake", () => {
	const old = new Headers({ "x-alethia-cli-version": "1.0.0" });

	it("passes everything when no minimum is configured", () => {
		expect(checkCliHandshake(old, null)).toEqual({ ok: true, minimum: null });
	});

	it("refuses only a parseable version below the minimum", () => {
		expect(checkCliHandshake(old, v("1.1.0"))).toEqual({
			ok: false,
			minimum: v("1.1.0"),
			version: v("1.0.0"),
		});
		expect(checkCliHandshake(old, v("1.0.0")).ok).toBe(true);
		expect(checkCliHandshake(new Headers(), v("9.0.0")).ok).toBe(true);
	});
});

describe("request ids", () => {
	it("are minted fresh, in one fixed shape", () => {
		const a = newCliRequestId();
		const b = newCliRequestId();
		expect(a).toMatch(REQUEST_ID);
		expect(b).toMatch(REQUEST_ID);
		expect(a).not.toBe(b);
	});

	it("cover /api/cli and below, and no other path", () => {
		expect(isCliApiPath("/api/cli")).toBe(true);
		expect(isCliApiPath("/api/cli/projects")).toBe(true);
		expect(isCliApiPath("/api/client")).toBe(false);
		expect(isCliApiPath("/cli/auth")).toBe(false);
		expect(isCliApiPath("/api/rpc")).toBe(false);
	});
});

describe("the proxy on /api/cli", () => {
	it("puts a request id on the response and forwards the same id to the route", async () => {
		const res = await proxy(at("/api/cli/projects"));
		const id = res.headers.get("x-request-id");
		expect(id).toMatch(REQUEST_ID);
		expect(forwardedRequestId(res)).toBe(id);
	});

	it("never echoes a client-sent request id", async () => {
		const res = await proxy(at("/api/cli/whoami", { "x-request-id": "secret-token-value" }));
		const id = res.headers.get("x-request-id");
		expect(id).toMatch(REQUEST_ID);
		expect(forwardedRequestId(res)).toBe(id);
	});

	it("gives each request its own id", async () => {
		const first = (await proxy(at("/api/cli/runners"))).headers.get("x-request-id");
		const second = (await proxy(at("/api/cli/runners"))).headers.get("x-request-id");
		expect(first).not.toBe(second);
	});

	it("adds nothing to a path outside the CLI API", async () => {
		const res = await proxy(at("/api/rpc/projects.list"));
		expect(res.headers.get("x-request-id")).toBeNull();
		expect(forwardedRequestId(res)).toBeNull();
	});

	it("lets every CLI through and names no minimum when none is configured", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "");
		const res = await proxy(at("/api/cli/projects", { "x-alethia-cli-version": "0.0.1" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-alethia-min-cli")).toBeNull();
	});

	it("treats a minimum that does not parse as none", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "latest");
		const res = await proxy(at("/api/cli/projects", { "x-alethia-cli-version": "0.0.1" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-alethia-min-cli")).toBeNull();
	});

	it("refuses a CLI below the minimum with 426, cli_too_old and a request id", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "v1.4.0");
		const res = await proxy(
			at("/api/cli/projects", {
				"x-alethia-cli-version": "1.3.2",
				"user-agent": "alethia-cli/1.3.2 (linux; amd64)",
			}),
		);
		expect(res.status).toBe(426);
		const id = res.headers.get("x-request-id");
		expect(id).toMatch(REQUEST_ID);
		expect(res.headers.get("x-alethia-min-cli")).toBe("1.4.0");
		// A refusal runs no route, so nothing is forwarded.
		expect(forwardedRequestId(res)).toBeNull();
		await expect(res.json()).resolves.toEqual({
			error: "This Alethia CLI (1.3.2) is older than the minimum this server accepts (1.4.0).",
			code: CLI_TOO_OLD_CODE,
			hint: "alethia update",
			request_id: id,
		});
	});

	it("refuses an old CLI that names itself only in its User-Agent", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "1.4.0");
		const res = await proxy(
			at("/api/cli/jobs", { "user-agent": "alethia-cli/1.0.0 (windows; amd64)" }),
		);
		expect(res.status).toBe(426);
	});

	it("lets through a CLI at the minimum, and names the minimum on its answer", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "1.4.0");
		const res = await proxy(at("/api/cli/projects", { "x-alethia-cli-version": "1.4.0" }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-alethia-min-cli")).toBe(formatCliVersion(v("1.4.0")));
		expect(res.headers.get("x-request-id")).toMatch(REQUEST_ID);
	});

	it("lets through a request that names no version or an unparseable one", async () => {
		vi.stubEnv("ALETHIA_MIN_CLI_VERSION", "1.4.0");
		const bare = await proxy(at("/api/cli/projects"));
		const dev = await proxy(at("/api/cli/projects", { "x-alethia-cli-version": "dev" }));
		expect([bare.status, dev.status]).toEqual([200, 200]);
	});
});
