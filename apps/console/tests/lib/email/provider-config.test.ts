// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// getEmailConfig: the pluggable transport selector. Verifies the provider is chosen
// by EMAIL_PROVIDER when set, else inferred from whichever creds are present
// (precedence SMTP → SES), that each provider's sub-config is populated,
// the SMTP secure/port defaults, and that a leftover Resend setting is refused rather than
// degraded to the log fallback. The module memoizes, so each case re-imports
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
	"ALETHIA_DEPLOYMENT_MODE",
	"ALETHIA_SANDBOX",
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
	// The sandbox carve-out below stubs NODE_ENV, which the loop above cannot restore.
	vi.unstubAllEnvs();
});

describe("getEmailConfig — provider selection", () => {
	it("is null (log-only) when no provider creds are present", async () => {
		const config = await loadConfig();
		expect(config.provider).toBeNull();
		expect(config.smtp).toBeUndefined();
		expect(config.ses).toBeUndefined();
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

	it("prefers SMTP over SES when both are configured", async () => {
		process.env.SMTP_HOST = "smtp.example.com";
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const config = await loadConfig();
		expect(config.provider).toBe("smtp");
	});

	it("honors an explicit EMAIL_PROVIDER over the inferred precedence", async () => {
		process.env.EMAIL_PROVIDER = "ses";
		process.env.SMTP_HOST = "smtp.example.com";
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const config = await loadConfig();
		expect(config.provider).toBe("ses");
	});

	it("falls back to log-only when EMAIL_PROVIDER names a provider with no creds", async () => {
		process.env.EMAIL_PROVIDER = "ses"; // pinned to SES...
		process.env.SMTP_HOST = "smtp.example.com"; // ...but only SMTP has creds
		const config = await loadConfig();
		expect(config.provider).toBeNull();
	});

	it("fails closed when hosted email credentials do not match the selected provider", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		process.env.EMAIL_PROVIDER = "ses";

		await expect(loadConfig()).rejects.toThrow(
			"EMAIL_PROVIDER=ses is configured without matching credentials.",
		);
	});

	describe("Resend was removed — a leftover setting is refused, never degraded to the log", () => {
		// The trap this pins: an operator upgrades with the old Resend config still in place. Without
		// these throws the transport would resolve to null and every sign-in code would be printed to
		// the server log instead of sent, in a self-managed deployment, with nothing red anywhere.

		it("refuses EMAIL_PROVIDER=resend in a self-managed deployment", async () => {
			process.env.EMAIL_PROVIDER = "resend";
			process.env.RESEND_API_KEY = "re_test_key";
			await expect(loadConfig()).rejects.toThrow(
				/EMAIL_PROVIDER=resend is not a supported transport \(use smtp or ses\)\. Resend support was removed/,
			);
		});

		it("refuses EMAIL_PROVIDER=resend in hosted mode, even with SES credentials present", async () => {
			process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
			process.env.EMAIL_PROVIDER = "resend";
			process.env.ALETHIA_SES_REGION = "eu-central-1";
			await expect(loadConfig()).rejects.toThrow(/not a supported transport/);
		});

		it("refuses any other unknown EMAIL_PROVIDER, case-insensitively", async () => {
			process.env.EMAIL_PROVIDER = "Postmark";
			await expect(loadConfig()).rejects.toThrow(
				"EMAIL_PROVIDER=postmark is not a supported transport (use smtp or ses).",
			);
		});

		it("refuses a bare RESEND_API_KEY that used to be inferred as the transport", async () => {
			process.env.RESEND_API_KEY = "re_test_key";
			await expect(loadConfig()).rejects.toThrow(
				/RESEND_API_KEY is set but Resend support was removed/,
			);
		});

		it("ignores a leftover RESEND_API_KEY once a real transport resolves", async () => {
			process.env.RESEND_API_KEY = "re_test_key";
			process.env.ALETHIA_SES_REGION = "eu-central-1";
			const config = await loadConfig();
			expect(config.provider).toBe("ses");
		});
	});

	describe("the sandbox carve-out (#2953)", () => {
		// A sandbox env mints ALETHIA_DEPLOYMENT_MODE=hosted on purpose — that is how it
		// rehearses Stripe-driven billing — and deliberately carries no mail credential. Without
		// the carve-out those two truths cancelled out and sign-in was impossible on every branch
		// env: this threw inside a Better Auth background task, the send returned 200, and no code
		// appeared by mail OR in the log.
		//
		// The whole value of the guard is that it refuses to degrade, so the carve-out is tested
		// from both sides: it must open for a sandbox, and it must stay SHUT for everything that
		// merely looks like one.

		it("allows the development log fallback for a real sandbox", async () => {
			process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
			process.env.ALETHIA_SANDBOX = "1";

			const config = await loadConfig();
			expect(config.provider).toBeNull();
		});

		it("stays shut in a PRODUCTION build even if the flag leaks in", async () => {
			// The second condition is what makes this a carve-out rather than an escape hatch:
			// a real hosted deployment is a production build and cannot satisfy it.
			process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
			process.env.ALETHIA_SANDBOX = "1";
			vi.stubEnv("NODE_ENV", "production");

			await expect(loadConfig()).rejects.toThrow(
				"Hosted deployments require an explicit, credentialed EMAIL_PROVIDER.",
			);
		});

		it("stays shut for any value other than exactly \"1\"", async () => {
			process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
			for (const value of ["true", "yes", "0", "", " 1"]) {
				process.env.ALETHIA_SANDBOX = value;
				await expect(loadConfig()).rejects.toThrow(
					"Hosted deployments require an explicit, credentialed EMAIL_PROVIDER.",
				);
			}
		});

		it("still fails closed on a MISMATCHED provider, sandbox or not", async () => {
			// The carve-out is for "no provider configured at all". Naming a provider and then
			// not giving it credentials is a misconfiguration in any environment, and silently
			// logging instead would hide it.
			process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
			process.env.ALETHIA_SANDBOX = "1";
			process.env.EMAIL_PROVIDER = "ses";

			await expect(loadConfig()).rejects.toThrow(
				"EMAIL_PROVIDER=ses is configured without matching credentials.",
			);
		});

		it("does not change a self-managed deployment, which never threw", async () => {
			process.env.ALETHIA_SANDBOX = "1";
			const config = await loadConfig();
			expect(config.provider).toBeNull();
		});
	});

	it("uses default from-addresses and lets EMAIL_FROM/AUTH_EMAIL_FROM override", async () => {
		const dflt = await loadConfig();
		// The default sender must sit on the APEX domain. It used to default to
		// `no-reply@auth.alethialabs.io`, and a provider that verifies domains individually (Resend,
		// the transport this package used to carry, did) rejects a subdomain whose parent is verified. That bounces every message at
		// send time, after the deploy and the config have both reported success.
		//
		// Asserted as an exact DOMAIN rather than with `toContain`, because
		// `toContain("alethialabs.io")` is satisfied by `auth.alethialabs.io` too — a substring
		// check cannot tell the apex from the subdomain, which is the whole distinction here. The
		// local-part stays free to change.
		const domainOf = (addr: string) => addr.split("@").at(-1)?.replace(">", "").trim();
		expect(domainOf(dflt.from.auth)).toBe("alethialabs.io");
		expect(dflt.from.general).toBe(dflt.from.auth); // general falls back to auth

		process.env.AUTH_EMAIL_FROM = "Acme <no-reply@auth.acme.io>";
		process.env.EMAIL_FROM = "Acme <hello@mail.acme.io>";
		const custom = await loadConfig();
		expect(custom.from.auth).toBe("Acme <no-reply@auth.acme.io>");
		expect(custom.from.general).toBe("Acme <hello@mail.acme.io>");
	});
});
