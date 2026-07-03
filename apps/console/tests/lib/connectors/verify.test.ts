// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Credential verifiers (lib/connectors/verify.ts). Boundary mocked: global fetch is
// stubbed. We assert each provider verifier hits the right fixed URL/headers/body,
// maps res.ok → {ok:true} and non-ok → an HTTP-status message, that unknown slugs
// are accepted optimistically, that thrown errors are shaped into a message, and
// that the SSRF guard (timedFetch) fails closed for non-https / non-allowlisted /
// invalid hosts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { __test, verifyConnectorCredential } from "@/lib/connectors/verify";

/** Build a minimal Response-like stub with the given ok/status. */
const httpResponse = (ok: boolean, status: number) => ({ ok, status }) as never;

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
});

describe("verifyConnectorCredential — unknown slug", () => {
	it("accepts providers with no registered verifier without calling fetch", async () => {
		expect(await verifyConnectorCredential("vault", { token: "x" })).toEqual({ ok: true });
		expect(await verifyConnectorCredential("grafana", {})).toEqual({ ok: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("verifyConnectorCredential — cloudflare", () => {
	it("calls the fixed verify endpoint with a Bearer header and returns ok on 200", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		const res = await verifyConnectorCredential("cloudflare", { api_token: "cf-tok" });
		expect(res).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect((url as URL).href).toBe(
			"https://api.cloudflare.com/client/v4/user/tokens/verify",
		);
		expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer cf-tok" });
	});

	it("maps a non-ok response to an HTTP-status failure message", async () => {
		fetchMock.mockResolvedValue(httpResponse(false, 403));
		expect(await verifyConnectorCredential("cloudflare", { api_token: "bad" })).toEqual({
			ok: false,
			message: "Cloudflare rejected the token (HTTP 403).",
		});
	});

	it("sends an empty Bearer token when api_token is absent", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		await verifyConnectorCredential("cloudflare", {});
		const [, init] = fetchMock.mock.calls[0];
		expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer " });
	});
});

describe("verifyConnectorCredential — dockerhub", () => {
	it("POSTs username/password JSON to the login endpoint and returns ok on success", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		const res = await verifyConnectorCredential("dockerhub", {
			username: "alice",
			access_token: "dckr_pat",
		});
		expect(res).toEqual({ ok: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect((url as URL).href).toBe("https://hub.docker.com/v2/users/login");
		const i = init as RequestInit;
		expect(i.method).toBe("POST");
		expect(i.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(i.body as string)).toEqual({
			username: "alice",
			password: "dckr_pat",
		});
	});

	it("maps a non-ok response to an HTTP-status failure message", async () => {
		fetchMock.mockResolvedValue(httpResponse(false, 401));
		expect(
			await verifyConnectorCredential("dockerhub", { username: "a", access_token: "b" }),
		).toEqual({
			ok: false,
			message: "Docker Hub rejected the credentials (HTTP 401).",
		});
	});

	it("defaults missing username/password to empty strings in the body", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		await verifyConnectorCredential("dockerhub", {});
		const [, init] = fetchMock.mock.calls[0];
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			username: "",
			password: "",
		});
	});
});

describe("verifyConnectorCredential — datadog", () => {
	it("validates against the default site host with the DD-API-KEY header", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		const res = await verifyConnectorCredential("datadog", { api_key: "dd-key" });
		expect(res).toEqual({ ok: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect((url as URL).href).toBe("https://api.datadoghq.com/api/v1/validate");
		expect((init as RequestInit).headers).toEqual({ "DD-API-KEY": "dd-key" });
	});

	it("normalizes (trim/lowercase) and routes to an allowlisted regional site", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		await verifyConnectorCredential("datadog", { api_key: "k", site: "  DATADOGHQ.EU " });
		const [url] = fetchMock.mock.calls[0];
		expect((url as URL).href).toBe("https://api.datadoghq.eu/api/v1/validate");
	});

	it("rejects an unsupported site WITHOUT making any request", async () => {
		const res = await verifyConnectorCredential("datadog", {
			api_key: "k",
			site: "evil.example.com",
		});
		expect(res).toEqual({ ok: false, message: "Unsupported Datadog site." });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps a non-ok response to an HTTP-status failure message", async () => {
		fetchMock.mockResolvedValue(httpResponse(false, 403));
		expect(await verifyConnectorCredential("datadog", { api_key: "bad" })).toEqual({
			ok: false,
			message: "Datadog rejected the API key (HTTP 403).",
		});
	});
});

describe("verifyConnectorCredential — error shaping", () => {
	it("wraps a thrown Error from the fetch boundary into a failure message", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		expect(await verifyConnectorCredential("cloudflare", { api_token: "x" })).toEqual({
			ok: false,
			message: "Verification failed: network down",
		});
	});

	it("uses a generic message when a non-Error value is thrown", async () => {
		fetchMock.mockRejectedValue("boom");
		expect(await verifyConnectorCredential("cloudflare", { api_token: "x" })).toEqual({
			ok: false,
			message: "Verification failed.",
		});
	});
});

describe("__test.timedFetch — SSRF guard fails closed", () => {
	it("rejects a non-https scheme even for an allowlisted host", async () => {
		await expect(
			__test.timedFetch("http://api.cloudflare.com/client/v4/user/tokens/verify"),
		).rejects.toThrow("Refusing to call non-allowlisted host: api.cloudflare.com");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an https request to a non-allowlisted host", async () => {
		await expect(__test.timedFetch("https://evil.example.com/")).rejects.toThrow(
			"Refusing to call non-allowlisted host: evil.example.com",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed URL", async () => {
		await expect(__test.timedFetch("not-a-url")).rejects.toThrow("Invalid request URL.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("passes through to fetch (with an abort signal) for an allowlisted https host", async () => {
		fetchMock.mockResolvedValue(httpResponse(true, 200));
		await __test.timedFetch("https://hub.docker.com/v2/users/login", { method: "POST" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect((url as URL).hostname).toBe("hub.docker.com");
		expect((init as RequestInit).method).toBe("POST");
		expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
	});

	it("exposes the exact allowlist (cloudflare + docker + datadog regional hosts)", () => {
		expect(__test.ALLOWED_HOSTS.has("api.cloudflare.com")).toBe(true);
		expect(__test.ALLOWED_HOSTS.has("hub.docker.com")).toBe(true);
		expect(__test.ALLOWED_HOSTS.has("api.datadoghq.eu")).toBe(true);
		expect(__test.ALLOWED_HOSTS.has("api.evil.example.com")).toBe(false);
	});
});
