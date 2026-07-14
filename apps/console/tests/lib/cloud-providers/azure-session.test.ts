// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Azure is keyless + customer-side: the console authenticates as the customer's managed identity
// against their tenant, presenting a minted OIDC assertion (no client secret, no platform app). These
// tests pin that contract — the credential is built for the customer tenant + the identity's client id,
// and it fails closed with a clear reason when the client id or the issuer isn't configured.

import { generateKeyPairSync } from "node:crypto";
import { ClientAssertionCredential } from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetIssuerCache } from "@/lib/oidc/issuer";
import {
	assumeAzureIdentity,
	AZURE_TOKEN_AUDIENCE,
} from "@/lib/cloud-providers/session/azure";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ENV_KEYS = ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};

/** Installs a real RSA signing key so the issuer can be built. */
function configureIssuer() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
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

describe("assumeAzureIdentity — keyless customer-identity credential", () => {
	it("throws a clear reason when the client id is missing", () => {
		process.env.ALETHIA_OIDC_SIGNING_KEY = "x"; // issuer marker present, client id absent
		expect(() => assumeAzureIdentity("customer-tenant", "")).toThrow(/client id/i);
	});

	it("throws a clear reason when the issuer isn't configured", () => {
		expect(() => assumeAzureIdentity("customer-tenant", CLIENT_ID)).toThrow(
			/issuer|ALETHIA_OIDC_SIGNING_KEY/,
		);
	});

	it("builds a ClientAssertionCredential for the customer tenant + identity when configured", () => {
		configureIssuer();
		const cred = assumeAzureIdentity("customer-tenant-guid", CLIENT_ID);
		expect(cred).toBeInstanceOf(ClientAssertionCredential);
		expect(AZURE_TOKEN_AUDIENCE).toBe("api://AzureADTokenExchange");
	});
});
