// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// getEmailConfig: the pluggable transport selector. Verifies the provider is chosen
// by EMAIL_PROVIDER when set, else inferred from whichever creds are present
// (precedence Resend → SMTP → SES), that each provider's sub-config is populated,
// and the SMTP secure/port defaults. The module memoizes, so each case re-imports
// after vi.resetModules() to re-read process.env fresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailConfig } from "@repo/email/config";

const EMAIL_KEYS = [
	"EMAIL_PROVIDER",
	"RESEND_API_KEY",
	"SMTP_HOST",
	"SMTP_PORT",
	"SMTP_USER",
	"SMTP_PASS",
	"SMTP_SECURE",
	"ALETHIA_SES_REGION",
	"ALETHIA_SES_ACCESS_KEY_ID",
	"ALETHIA_SES_SECRET_ACCESS_KEY",
	"ALETHIA_SES_AUTH_CONFIG_SET",
	"ALETHIA_SES_GENERAL_CONFIG_SET",
	"AWS_REGION",
	"AUTH_EMAIL_FROM",
	"EMAIL_FROM",
] as const;

const saved: Record<string, string | undefined> = {};

/** Loads a fresh getEmailConfig() so it re-reads the current process.env. */
async function loadConfig(): Promise<EmailConfig> {
	vi.resetModules();
	const mod = await import("@repo/email/config");
	return mod.getEmailConfig();
}

beforeEach(() => {
	// Snapshot then clear every email-related key so each case starts from a
	// known-empty environment regardless of the host's real env.
	for (const k of EMAIL_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of EMAIL_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("getEmailConfig — provider selection", () => {
	it("is null (log-only) when no provider creds are present", async () => {
		const config = await loadConfig();
		expect(config.provider).toBeNull();
		expect(config.resend).toBeUndefined();
		expect(config.smtp).toBeUndefined();
		expect(config.ses).toBeUndefined();
	});

	it("selects Resend when RESEND_API_KEY is set", async () => {
		process.env.RESEND_API_KEY = "re_test_key";
		const config = await loadConfig();
		expect(config.provider).toBe("resend");
		expect(config.resend).toEqual({ apiKey: "re_test_key" });
	});

	it("selects SMTP when SMTP_HOST is set, with port/secure defaults", async () => {
		process.env.SMTP_HOST = "smtp.example.com";
		const config = await loadConfig();
		expect(config.provider).toBe("smtp");
		expect(config.smtp).toMatchObject({
			host: "smtp.example.com",
			port: 587,
			secure: false,
		});
	});

	it("defaults SMTP secure to true on port 465", async () => {
		process.env.SMTP_HOST = "smtp.example.com";
		process.env.SMTP_PORT = "465";
		const config = await loadConfig();
		expect(config.smtp?.secure).toBe(true);
	});

	it("lets SMTP_SECURE override the port-based default", async () => {
		process.env.SMTP_HOST = "smtp.example.com";
		process.env.SMTP_PORT = "465";
		process.env.SMTP_SECURE = "false";
		const config = await loadConfig();
		expect(config.smtp?.secure).toBe(false);
	});

	it("selects SES when ALETHIA_SES_REGION is set", async () => {
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const config = await loadConfig();
		expect(config.provider).toBe("ses");
		expect(config.ses).toMatchObject({ region: "eu-central-1" });
	});

	it("prefers Resend over SMTP and SES when several are configured", async () => {
		process.env.RESEND_API_KEY = "re_test_key";
		process.env.SMTP_HOST = "smtp.example.com";
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const config = await loadConfig();
		expect(config.provider).toBe("resend");
	});

	it("honors an explicit EMAIL_PROVIDER over the inferred precedence", async () => {
		process.env.EMAIL_PROVIDER = "smtp";
		process.env.RESEND_API_KEY = "re_test_key";
		process.env.SMTP_HOST = "smtp.example.com";
		const config = await loadConfig();
		expect(config.provider).toBe("smtp");
	});

	it("falls back to log-only when EMAIL_PROVIDER names a provider with no creds", async () => {
		process.env.EMAIL_PROVIDER = "ses"; // pinned to SES...
		process.env.RESEND_API_KEY = "re_test_key"; // ...but only Resend has creds
		const config = await loadConfig();
		expect(config.provider).toBeNull();
	});

	it("uses default from-addresses and lets EMAIL_FROM/AUTH_EMAIL_FROM override", async () => {
		const dflt = await loadConfig();
		expect(dflt.from.auth).toContain("auth.alethialabs.io");
		expect(dflt.from.general).toBe(dflt.from.auth); // general falls back to auth

		process.env.AUTH_EMAIL_FROM = "Acme <no-reply@auth.acme.io>";
		process.env.EMAIL_FROM = "Acme <hello@mail.acme.io>";
		const custom = await loadConfig();
		expect(custom.from.auth).toBe("Acme <no-reply@auth.acme.io>");
		expect(custom.from.general).toBe("Acme <hello@mail.acme.io>");
	});
});
