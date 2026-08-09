// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// sendEmail: renders once, then dispatches to the configured transport. Which
// provider gets selected is covered exhaustively by provider-config.test.ts; here
// we verify the send-side seams that are provider-agnostic: the template is
// rendered exactly once for a configured provider and NOT at all when none is
// configured (log-only), and the dev-swallow / prod-throw error semantics. The
// concrete transport + error assertions use the SES path because its SDK is CJS and
// mocks reliably (the ESM-only resend/nodemailer packages are externalized by
// Vitest across the package boundary, so mocking them from here is unreliable).
// Each case re-imports send.ts after vi.resetModules() so its cached client and the
// config singleton re-read the current process.env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ render: vi.fn(), sesSend: vi.fn() }));

vi.mock("@react-email/components", () => ({ render: h.render }));
vi.mock("@aws-sdk/client-sesv2", () => ({
	SESv2Client: vi.fn(() => ({ send: h.sesSend })),
	SendEmailCommand: vi.fn((input: unknown) => ({ input })),
}));

const EMAIL_KEYS = [
	"EMAIL_PROVIDER",
	"RESEND_API_KEY",
	"SMTP_HOST",
	"SMTP_PORT",
	"ALETHIA_SES_REGION",
	"ALETHIA_SES_ACCESS_KEY_ID",
	"ALETHIA_SES_SECRET_ACCESS_KEY",
	"AWS_REGION",
] as const;

const saved: Record<string, string | undefined> = {};

/** Loads a fresh sendEmail so its cached client + config re-read process.env. */
async function loadSend() {
	vi.resetModules();
	return (await import("@repo/email/send")).sendEmail;
}

const base = {
	from: "a@auth.alethialabs.io",
	to: "b@acme.io",
	subject: "Hi",
	react: null as never,
};

beforeEach(() => {
	for (const k of EMAIL_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	vi.clearAllMocks();
	h.render.mockResolvedValue("<html>rendered</html>");
	h.sesSend.mockResolvedValue({});
});

afterEach(() => {
	for (const k of EMAIL_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.unstubAllEnvs();
});

describe("sendEmail — dispatch & error semantics", () => {
	it("renders nothing and sends nothing when no provider is configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sendEmail = await loadSend();
		await sendEmail(base);
		expect(h.render).not.toHaveBeenCalled();
		expect(h.sesSend).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("no provider configured"),
		);
		warn.mockRestore();
	});

	it("renders the template once and dispatches to SES when SES is selected", async () => {
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const sendEmail = await loadSend();
		await sendEmail(base);
		expect(h.render).toHaveBeenCalledTimes(1);
		expect(h.sesSend).toHaveBeenCalledTimes(1);
	});

	it("builds a SES Simple send with the from/subject/rendered HTML", async () => {
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");
		const sendEmail = await loadSend();
		await sendEmail(base);
		expect(SendEmailCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				FromEmailAddress: base.from,
				Destination: expect.objectContaining({ ToAddresses: [base.to] }),
				Content: expect.objectContaining({
					Simple: expect.objectContaining({
						Subject: expect.objectContaining({ Data: "Hi" }),
						Body: { Html: { Data: "<html>rendered</html>", Charset: "UTF-8" } },
					}),
				}),
			}),
		);
	});

	it("swallows a send failure in dev, keeping the OTP retrievable via devLog", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		h.sesSend.mockRejectedValue(new Error("sandbox rejected recipient"));
		const sendEmail = await loadSend();
		await expect(
			sendEmail({ ...base, devLog: "code=123456" }),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("code=123456"));
		warn.mockRestore();
	});

	it("rethrows a send failure in production, tagged with the provider", async () => {
		vi.stubEnv("NODE_ENV", "production");
		process.env.ALETHIA_SES_REGION = "eu-central-1";
		h.sesSend.mockRejectedValue(new Error("sandbox rejected recipient"));
		const sendEmail = await loadSend();
		await expect(sendEmail(base)).rejects.toThrow(
			/via ses: sandbox rejected recipient/,
		);
	});
});
