// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the DSN-gated Sentry error-tracking layer: proves it is a TRUE no-op when
// SENTRY_DSN is unset (no init, no throw), and that the `beforeSend` scrub strips seeded secrets by
// both key name and value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSecretKey, scrubEvent, scrubString } from "@/lib/observability/scrub";

describe("scrub (Sentry beforeSend)", () => {
	const OLD = process.env;
	beforeEach(() => {
		process.env = { ...OLD };
	});
	afterEach(() => {
		process.env = OLD;
	});

	it("redacts a secret env VALUE out of any string", () => {
		process.env.BETTER_AUTH_SECRET = "s3cr3t-auth-value-abcdef";
		const out = scrubString(
			"login failed with secret s3cr3t-auth-value-abcdef end",
		);
		expect(out).not.toContain("s3cr3t-auth-value-abcdef");
		expect(out).toContain("[REDACTED]");
	});

	it("redacts secret-NAMED keys and secret values across a full Sentry event", () => {
		process.env.STRIPE_SECRET_KEY = "sk_live_deadbeefcafe1234";
		const event = {
			message: "boom sk_live_deadbeefcafe1234",
			tags: { trace_id: "abc123", api_key: "should-be-hidden" },
			extra: { password: "hunter2length", note: "value sk_live_deadbeefcafe1234" },
			exception: {
				values: [
					{
						value: "threw sk_live_deadbeefcafe1234",
						stacktrace: {
							frames: [{ vars: { authorization: "Bearer xyzverysecret" } }],
						},
					},
				],
			},
			request: { headers: { cookie: "session=abc; a=b" } },
		};

		const scrubbed = scrubEvent(event);

		// KEY redaction.
		expect(scrubbed.tags.api_key).toBe("[REDACTED]");
		expect(scrubbed.extra.password).toBe("[REDACTED]");
		expect(scrubbed.exception.values[0].stacktrace.frames[0].vars.authorization).toBe(
			"[REDACTED]",
		);
		expect(scrubbed.request.headers.cookie).toBe("[REDACTED]");
		// Non-secret keys survive (so the trace linkage is kept).
		expect(scrubbed.tags.trace_id).toBe("abc123");
		// VALUE redaction inside otherwise-innocent fields.
		expect(scrubbed.message).not.toContain("sk_live_deadbeefcafe1234");
		expect(scrubbed.extra.note).not.toContain("sk_live_deadbeefcafe1234");
		expect(scrubbed.exception.values[0].value).not.toContain(
			"sk_live_deadbeefcafe1234",
		);
	});

	it("classifies secret vs non-secret keys via the shared denylist", () => {
		for (const k of ["kubeconfig", "client_secret", "API_KEY", "DATABASE_URL"]) {
			expect(isSecretKey(k)).toBe(true);
		}
		expect(isSecretKey("trace_id")).toBe(false);
		expect(isSecretKey("path")).toBe(false);
	});

	it("is cycle-safe", () => {
		const a: Record<string, unknown> = { name: "x" };
		a.self = a;
		expect(() => scrubEvent(a)).not.toThrow();
	});
});

describe("Sentry server init gating", () => {
	const OLD = process.env;
	beforeEach(() => {
		vi.resetModules();
		process.env = { ...OLD };
	});
	afterEach(() => {
		process.env = OLD;
		vi.restoreAllMocks();
	});

	it("is a no-op when SENTRY_DSN is unset (never initializes, never throws)", async () => {
		process.env.NEXT_RUNTIME = "nodejs";
		delete process.env.SENTRY_DSN;
		const { initSentryServer, sentryEnabled, captureServerError } = await import(
			"@/lib/observability/sentry"
		);

		expect(sentryEnabled()).toBe(false);
		await expect(initSentryServer()).resolves.toBe(false);
		// Capturing with no DSN must be a safe no-op — no import, no throw.
		await expect(
			captureServerError(new Error("boom"), { path: "/x", method: "GET" }),
		).resolves.toBeUndefined();
	});

	it("does not initialize off the Node runtime", async () => {
		process.env.NEXT_RUNTIME = "edge";
		process.env.SENTRY_DSN = "https://public@example.invalid/1";
		const { initSentryServer } = await import("@/lib/observability/sentry");
		await expect(initSentryServer()).resolves.toBe(false);
	});
});
