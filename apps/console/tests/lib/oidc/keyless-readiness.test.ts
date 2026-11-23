// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Keyless readiness (EDN-H6): a missing signing key or an app URL no cloud can reach yields the
// "not publicly reachable" answer; a public HTTPS URL with a key, or a complete broker runtime, is
// ready. `keylessReadiness()` is exercised against the real environment so the server-side wiring
// (which env it reads, and that the broker wins) is pinned, not just the pure judge.

import { afterEach, describe, expect, it } from "vitest";
import { keylessReadiness } from "@/lib/oidc/assertion-source";
import { __resetIssuerCache } from "@/lib/oidc/issuer";
import {
	assessIssuerOrigin,
	assessKeylessReadiness,
	cloudNeedsPublicIssuer,
} from "@/lib/oidc/keyless-readiness";

const ENV = [
	"ALETHIA_OIDC_SIGNING_KEY",
	"NEXT_PUBLIC_APP_URL",
	"BETTER_AUTH_URL",
	"ALETHIA_E2E_ASSERTION_BROKER_URL",
	"ALETHIA_E2E_ASSERTION_BROKER_AUDIENCE",
	"ACTIONS_ID_TOKEN_REQUEST_URL",
	"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
	"GITHUB_REPOSITORY",
	"GITHUB_WORKFLOW_REF",
	"GITHUB_RUN_ID",
	"GITHUB_RUN_ATTEMPT",
];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of ENV) {
		const value = saved[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	__resetIssuerCache();
});

/** Clears every input `keylessReadiness()` reads. */
function clearEnv() {
	for (const name of ENV) delete process.env[name];
}

describe("assessIssuerOrigin — the issuer URL alone", () => {
	it.each([
		"https://alethialabs.io/api/oidc",
		"https://console.acme.example.com/api/oidc",
		"https://alethia.acme.co.uk:8443/api/oidc",
		"https://203.0.113.10/api/oidc",
		"https://[2001:db8::1]/api/oidc",
		"https://172.32.0.1/api/oidc",
	])("a public HTTPS origin is reachable: %s", (url) => {
		expect(assessIssuerOrigin(url)).toBeNull();
	});

	it.each(["", "/api/oidc", "not a url"])("no usable URL is origin-missing: %j", (url) => {
		expect(assessIssuerOrigin(url)).toBe("origin-missing");
	});

	it.each(["http://alethia.acme.com/api/oidc", "http://localhost:3000/api/oidc"])(
		"a non-HTTPS URL is origin-not-https: %s",
		(url) => {
			expect(assessIssuerOrigin(url)).toBe("origin-not-https");
		},
	);

	it.each([
		"https://localhost/api/oidc",
		"https://console.localhost/api/oidc",
		"https://alethia/api/oidc",
		"https://alethia.local/api/oidc",
		"https://alethia.corp.internal/api/oidc",
		"https://alethia.home.arpa/api/oidc",
		"https://alethia.test/api/oidc",
		"https://alethia.local./api/oidc",
		"https://10.0.0.5/api/oidc",
		"https://172.16.4.2/api/oidc",
		"https://172.31.255.255/api/oidc",
		"https://192.168.1.20/api/oidc",
		"https://127.0.0.1/api/oidc",
		"https://169.254.169.254/api/oidc",
		"https://100.64.0.1/api/oidc",
		"https://0.0.0.0/api/oidc",
		"https://[::1]/api/oidc",
		"https://[fd12:3456::1]/api/oidc",
		"https://[fe80::1]/api/oidc",
		"https://[::ffff:10.0.0.1]/api/oidc",
	])("a private, local or reserved host is origin-not-public: %s", (url) => {
		expect(assessIssuerOrigin(url)).toBe("origin-not-public");
	});
});

describe("assessKeylessReadiness", () => {
	const PUBLIC = "https://alethia.acme.com/api/oidc";

	it("is ready with a key and a public HTTPS URL", () => {
		expect(assessKeylessReadiness({ signingKeyConfigured: true, issuerUrl: PUBLIC, brokerConfigured: false })).toEqual({
			ready: true,
		});
	});

	it("reports the missing key first, even on a private URL", () => {
		expect(
			assessKeylessReadiness({
				signingKeyConfigured: false,
				issuerUrl: "https://10.0.0.5/api/oidc",
				brokerConfigured: false,
			}),
		).toEqual({ ready: false, reason: "signing-key-missing" });
	});

	it("reports an unreachable origin when the key is set", () => {
		expect(
			assessKeylessReadiness({
				signingKeyConfigured: true,
				issuerUrl: "http://localhost:3000/api/oidc",
				brokerConfigured: false,
			}),
		).toEqual({ ready: false, reason: "origin-not-https" });
	});

	it("is ready through a broker whatever this instance's own URL is", () => {
		expect(
			assessKeylessReadiness({
				signingKeyConfigured: false,
				issuerUrl: "http://localhost:3000/api/oidc",
				brokerConfigured: true,
			}),
		).toEqual({ ready: true });
	});
});

describe("cloudNeedsPublicIssuer", () => {
	it("is true for AWS, GCP, Azure and Alibaba", () => {
		for (const slug of ["aws", "gcp", "azure", "alibaba"]) expect(cloudNeedsPublicIssuer(slug)).toBe(true);
	});

	it("is false for Hetzner and the other token clouds", () => {
		for (const slug of ["hetzner", "digitalocean", "civo"]) expect(cloudNeedsPublicIssuer(slug)).toBe(false);
	});
});

describe("keylessReadiness() — read from the server's environment", () => {
	it("a missing key yields signing-key-missing", () => {
		clearEnv();
		process.env.NEXT_PUBLIC_APP_URL = "https://alethia.acme.com";
		expect(keylessReadiness()).toEqual({ ready: false, reason: "signing-key-missing" });
	});

	it("a key on a private app URL yields origin-not-public", () => {
		clearEnv();
		process.env.ALETHIA_OIDC_SIGNING_KEY = "set";
		process.env.NEXT_PUBLIC_APP_URL = "https://alethia.corp.internal/";
		expect(keylessReadiness()).toEqual({ ready: false, reason: "origin-not-public" });
	});

	it("falls back to BETTER_AUTH_URL, and no URL at all is origin-missing", () => {
		clearEnv();
		process.env.ALETHIA_OIDC_SIGNING_KEY = "set";
		expect(keylessReadiness()).toEqual({ ready: false, reason: "origin-missing" });
		process.env.BETTER_AUTH_URL = "https://alethia.acme.com";
		expect(keylessReadiness()).toEqual({ ready: true });
	});

	it("a complete broker runtime is ready", () => {
		clearEnv();
		process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
		process.env.ALETHIA_E2E_ASSERTION_BROKER_URL = "https://issuer.e2e.example.com";
		process.env.ALETHIA_E2E_ASSERTION_BROKER_AUDIENCE = "alethia-e2e";
		process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://run.actions.githubusercontent.com/token";
		process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "runtime";
		process.env.GITHUB_REPOSITORY = "acme/app";
		process.env.GITHUB_WORKFLOW_REF = "acme/app/.github/workflows/e2e.yml@refs/heads/dev";
		process.env.GITHUB_RUN_ID = "1";
		process.env.GITHUB_RUN_ATTEMPT = "1";
		expect(keylessReadiness()).toEqual({ ready: true });
	});
});
