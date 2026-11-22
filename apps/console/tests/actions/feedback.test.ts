// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the feedback action: stub the auth session, request headers,
// and the sendEmail boundary; keep deploymentMode(), the zod schema, and the email
// subject/template real. Asserts the hosted-only + auth guards, the validation contract,
// and the exact envelope (from/to/subject/devLog) handed to the configured provider.
//
// The action runs through the mutation contract (R6 G-27), so every refusal is a RESULT the dialog
// routes — `not-found` off the hosted service, `unauthenticated` with no session, `validation`
// with the field — never a throw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/email/send", () => ({ sendEmail: vi.fn() }));

import { submitFeedback } from "@/app/server/actions/feedback";
import { auth } from "@/lib/auth";
import { sendEmail } from "@repo/email/send";

const ORIGINAL_MODE = process.env.ALETHIA_DEPLOYMENT_MODE;
const ORIGINAL_FEEDBACK = process.env.FEEDBACK_EMAIL;
const ORIGINAL_EMAIL_PROVIDER = process.env.EMAIL_PROVIDER;
const ORIGINAL_SES_REGION = process.env.ALETHIA_SES_REGION;

/** A well-formed submission used by the happy-path assertions. */
const validInput = { topic: "idea", rating: 4, message: "Love the new dashboard" } as const;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
	process.env.EMAIL_PROVIDER = "ses";
	process.env.ALETHIA_SES_REGION = "eu-central-1";
	delete process.env.FEEDBACK_EMAIL;
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { email: "user@acme.io" },
	} as never);
	vi.mocked(sendEmail).mockResolvedValue(undefined as never);
});

afterEach(() => {
	if (ORIGINAL_MODE === undefined) delete process.env.ALETHIA_DEPLOYMENT_MODE;
	else process.env.ALETHIA_DEPLOYMENT_MODE = ORIGINAL_MODE;
	if (ORIGINAL_FEEDBACK === undefined) delete process.env.FEEDBACK_EMAIL;
	else process.env.FEEDBACK_EMAIL = ORIGINAL_FEEDBACK;
	if (ORIGINAL_EMAIL_PROVIDER === undefined) delete process.env.EMAIL_PROVIDER;
	else process.env.EMAIL_PROVIDER = ORIGINAL_EMAIL_PROVIDER;
	if (ORIGINAL_SES_REGION === undefined) delete process.env.ALETHIA_SES_REGION;
	else process.env.ALETHIA_SES_REGION = ORIGINAL_SES_REGION;
});

describe("submitFeedback", () => {
	it("refuses on a self-managed deployment before touching auth or email", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "self-managed";
		expect(await submitFeedback(validInput)).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Feedback is only available on the hosted service." },
		});
		expect(auth.api.getSession).not.toHaveBeenCalled();
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects an unauthenticated request and never emails", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		expect(await submitFeedback(validInput)).toEqual({ ok: false, error: { kind: "unauthenticated" } });
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("rejects a session with no user", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({ user: null } as never);
		expect(await submitFeedback(validInput)).toEqual({ ok: false, error: { kind: "unauthenticated" } });
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("validates input and refuses an out-of-range rating under its field, before emailing", async () => {
		const result = await submitFeedback({ topic: "bug", rating: 9, message: "x" } as never);
		expect(result.ok ? null : result.error.kind).toBe("validation");
		expect(result.ok || result.error.kind !== "validation" ? [] : Object.keys(result.error.fields)).toEqual(["rating"]);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("validates input and rejects an empty message", async () => {
		const result = await submitFeedback({ topic: "bug", rating: 3, message: "" } as never);
		expect(result.ok || result.error.kind !== "validation" ? null : result.error.fields.message).toEqual([
			"Tell us a little more",
		]);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("validates input and rejects an unknown topic", async () => {
		const result = await submitFeedback({ topic: "spam", rating: 3, message: "hi" } as never);
		expect(result.ok ? null : result.error.kind).toBe("validation");
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("emails the default inbox with the topic-derived subject and submitter devLog", async () => {
		const res = await submitFeedback(validInput);
		expect(res).toEqual({ ok: true, data: null });

		expect(sendEmail).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(sendEmail).mock.calls[0][0];
		expect(arg.to).toBe("feedback@alethialabs.io"); // DEFAULT_FEEDBACK_EMAIL
		expect(arg.subject).toBe("Console feedback: Idea"); // real subject(topic)
		expect(arg.devLog).toBe("idea 4/5 from user@acme.io");
		expect(typeof arg.from).toBe("string"); // real getEmailConfig().from.general
		expect(arg.from.length).toBeGreaterThan(0);
		expect(arg.react).toBeTruthy(); // FeedbackEmail element passed through (not rendered)
	});

	it("honors the FEEDBACK_EMAIL override for the destination inbox", async () => {
		process.env.FEEDBACK_EMAIL = "team@elsewhere.io";
		await submitFeedback({ topic: "bug", rating: 1, message: "broken" });
		const arg = vi.mocked(sendEmail).mock.calls[0][0];
		expect(arg.to).toBe("team@elsewhere.io");
		expect(arg.subject).toBe("Console feedback: Bug");
		expect(arg.devLog).toBe("bug 1/5 from user@acme.io");
	});

	it("passes the request headers through to getSession", async () => {
		const { headers } = await import("next/headers");
		vi.mocked(headers).mockResolvedValue({ marker: "hdrs" } as never);
		await submitFeedback(validInput);
		expect(auth.api.getSession).toHaveBeenCalledWith({
			headers: { marker: "hdrs" },
		});
	});
});
