// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Azure is keyless: the console authenticates as the platform multi-tenant app against the CUSTOMER
// tenant, presenting a minted OIDC assertion (no client secret). These tests pin that contract — the
// credential is built for the customer tenant + platform app, and it fails closed with a clear reason
// when the platform app id or the issuer isn't configured.

import { generateKeyPairSync } from "node:crypto";
import { ClientAssertionCredential } from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetIssuerCache } from "@/lib/oidc/issuer";
import {
	assumeAzureIdentity,
	azurePlatformConfigured,
	AZURE_TOKEN_AUDIENCE,
} from "@/lib/cloud-providers/session/azure";

const ENV_KEYS = [
	"ALETHIA_AZURE_CLIENT_ID",
	"ALETHIA_OIDC_SIGNING_KEY",
	"NEXT_PUBLIC_APP_URL",
];
const saved: Record<string, string | undefined> = {};

/** Installs a real RSA signing key + a platform app id so the issuer + credential can be built. */
function configure() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
	process.env.ALETHIA_AZURE_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
	process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
	__resetIssuerCache();
}

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	for (const k of ENV_KEYS) delete process.env[k];
	__resetIssuerCache();
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	__resetIssuerCache();
});

describe("assumeAzureIdentity — keyless platform credential", () => {
	it("azurePlatformConfigured is false without the app id or issuer", () => {
		expect(azurePlatformConfigured()).toBe(false);
		process.env.ALETHIA_AZURE_CLIENT_ID = "app-id"; // still no issuer
		__resetIssuerCache();
		expect(azurePlatformConfigured()).toBe(false);
	});

	it("throws a clear reason when the platform app id is missing", () => {
		process.env.ALETHIA_OIDC_SIGNING_KEY = "x"; // issuer marker present, app id absent
		expect(() => assumeAzureIdentity("customer-tenant")).toThrow(/ALETHIA_AZURE_CLIENT_ID/);
	});

	it("throws a clear reason when the issuer isn't configured", () => {
		process.env.ALETHIA_AZURE_CLIENT_ID = "app-id"; // no signing key
		expect(() => assumeAzureIdentity("customer-tenant")).toThrow(/issuer|ALETHIA_OIDC_SIGNING_KEY/);
	});

	it("builds a ClientAssertionCredential for the customer tenant when configured", () => {
		configure();
		expect(azurePlatformConfigured()).toBe(true);
		const cred = assumeAzureIdentity("customer-tenant-guid");
		expect(cred).toBeInstanceOf(ClientAssertionCredential);
		expect(AZURE_TOKEN_AUDIENCE).toBe("api://AzureADTokenExchange");
	});
});
