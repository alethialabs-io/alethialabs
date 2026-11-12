// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `classifyProviderError` decides, from the AI SDK's typed `APICallError` fields, which class of
// provider failure a chat stream hit, and `providerErrorMessage` is the only text the client gets.
// Every error here is built by hand from the SDK's REAL error classes with an Anthropic-shaped
// response body (`{"type":"error","error":{"type":…,"message":…}}`), matching how
// `@ai-sdk/anthropic` 3.0.x builds them. They are NOT produced by the adapter, so a change in the
// adapter's error shape would not fail here.

import { APICallError } from "@ai-sdk/provider";
import { RetryError, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_CREDIT_EXHAUSTED,
	PROVIDER_ERROR_CODES,
	PROVIDER_ERROR_MESSAGES,
	classifyProviderError,
	providerErrorCodeOf,
	providerErrorMessage,
	providerErrorSummary,
} from "@/lib/ai/provider-error";

/** The credit-exhausted message Anthropic returned in `e2e-ai-nightly` run 43016072306. */
const CREDIT_PROSE =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

/**
 * An `APICallError` as `@ai-sdk/anthropic` raises it: the HTTP status, the raw body, and `data`
 * holding that body parsed. `parsed: false` leaves `data` unset, so only `responseBody` carries it.
 */
function anthropicError(
	statusCode: number,
	type: string,
	message: string,
	{ parsed = true, isRetryable = false }: { parsed?: boolean; isRetryable?: boolean } = {},
): APICallError {
	const body = { type: "error", error: { type, message }, request_id: "req_test" };
	return new APICallError({
		message,
		url: "https://api.anthropic.com/v1/messages",
		requestBodyValues: { model: "claude-test" },
		statusCode,
		responseHeaders: { "content-type": "application/json" },
		responseBody: JSON.stringify(body),
		isRetryable,
		data: parsed ? body : undefined,
	});
}

describe("classifyProviderError", () => {
	it("reads Anthropic's out-of-credit 400 as provider-billing (the one prose match)", () => {
		const err = anthropicError(400, "invalid_request_error", CREDIT_PROSE);
		expect(classifyProviderError(err)).toBe("provider-billing");
		// The same when only the raw body is there to read.
		expect(
			classifyProviderError(anthropicError(400, "invalid_request_error", CREDIT_PROSE, { parsed: false })),
		).toBe("provider-billing");
	});

	it("pins the prose match to the message Anthropic actually sends", () => {
		expect(ANTHROPIC_CREDIT_EXHAUSTED.test(CREDIT_PROSE)).toBe(true);
	});

	it("reads a typed billing_error / HTTP 402 / OpenAI insufficient_quota as provider-billing", () => {
		expect(classifyProviderError(anthropicError(402, "billing_error", "Billing issue."))).toBe(
			"provider-billing",
		);
		// OpenAI answers an exhausted quota with 429 — typed, so it is billing and not a busy model.
		expect(
			classifyProviderError(anthropicError(429, "insufficient_quota", "You exceeded your current quota.")),
		).toBe("provider-billing");
	});

	it("does NOT read any other 400 invalid_request_error as billing", () => {
		expect(
			classifyProviderError(anthropicError(400, "invalid_request_error", "messages: field required")),
		).toBe("network");
	});

	it("reads the credit prose ONLY on a 400 invalid_request_error", () => {
		expect(classifyProviderError(anthropicError(500, "api_error", CREDIT_PROSE))).toBe("network");
		expect(classifyProviderError(anthropicError(400, "not_found_error", CREDIT_PROSE))).toBe("network");
	});

	it("reads a 401 / 403 as provider-auth", () => {
		expect(
			classifyProviderError(anthropicError(401, "authentication_error", "invalid x-api-key")),
		).toBe("provider-auth");
		expect(
			classifyProviderError(
				anthropicError(403, "permission_error", "Your API key does not have permission to use the specified resource."),
			),
		).toBe("provider-auth");
	});

	it("reads a 429 / 529 as provider-overloaded", () => {
		expect(
			classifyProviderError(anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { isRetryable: true })),
		).toBe("provider-overloaded");
		expect(
			classifyProviderError(anthropicError(529, "overloaded_error", "Overloaded", { isRetryable: true })),
		).toBe("provider-overloaded");
	});

	it("classifies a RetryError by the attempt it gave up on", () => {
		const last = anthropicError(529, "overloaded_error", "Overloaded", { isRetryable: true });
		const retry = new RetryError({
			message: "Failed after 3 attempts. Last error: Overloaded",
			reason: "maxRetriesExceeded",
			errors: [last, last, last],
		});
		expect(classifyProviderError(retry)).toBe("provider-overloaded");
	});

	it("reads anything that is not a provider API call as network", () => {
		expect(classifyProviderError(new Error("socket hang up"))).toBe("network");
		expect(classifyProviderError("boom")).toBe("network");
		expect(classifyProviderError(undefined)).toBe("network");
		expect(classifyProviderError(anthropicError(500, "api_error", "Internal server error"))).toBe("network");
	});

	it("classifies an error the provider sent mid-stream by its type alone", () => {
		// `@ai-sdk/anthropic` forwards an SSE `error` event as its plain `{ type, message }` object.
		expect(classifyProviderError({ type: "overloaded_error", message: "Overloaded" })).toBe(
			"provider-overloaded",
		);
		expect(classifyProviderError({ type: "billing_error", message: "x" })).toBe("provider-billing");
		expect(classifyProviderError({ type: "authentication_error", message: "x" })).toBe("provider-auth");
		expect(classifyProviderError({ type: "api_error", message: "x" })).toBe("network");
		// An Error of ours that happens to carry a `type` is never read as a provider's.
		expect(classifyProviderError(Object.assign(new Error("x"), { type: "overloaded_error" }))).toBe("network");
	});
});

describe("providerErrorSummary", () => {
	it("logs the provider's typed fields and never the request it sent or the response headers", () => {
		const err = new APICallError({
			message: CREDIT_PROSE,
			url: "https://api.anthropic.com/v1/messages",
			requestBodyValues: { system: "SYSTEM-PROMPT", messages: [{ role: "user", content: "USER-TYPED" }] },
			statusCode: 400,
			responseHeaders: { "request-id": "req_123", "anthropic-organization-id": "ORG-ID" },
			responseBody: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: CREDIT_PROSE } }),
			isRetryable: false,
		});
		const summary = providerErrorSummary(err);
		expect(summary).toMatchObject({
			code: "provider-billing",
			status: 400,
			provider_type: "invalid_request_error",
			request_id: "req_123",
		});
		const line = JSON.stringify(summary);
		for (const secret of ["SYSTEM-PROMPT", "USER-TYPED", "ORG-ID"]) expect(line).not.toContain(secret);
	});

	it("summarises a RetryError by its last attempt and counts the attempts", () => {
		const last = anthropicError(529, "overloaded_error", "Overloaded", { isRetryable: true });
		const retry = new RetryError({ message: "Failed", reason: "maxRetriesExceeded", errors: [last, last] });
		const summary = providerErrorSummary(retry);
		expect(summary).toMatchObject({ code: "provider-overloaded", attempts: 2, status: 529 });
		expect(JSON.stringify(summary)).not.toContain("claude-test");
	});

	it("keeps name, message and stack for a failure that is not a provider call", () => {
		const bug = new TypeError("cannot read x");
		expect(providerErrorSummary(bug)).toMatchObject({
			code: "network",
			name: "TypeError",
			message: "cannot read x",
			stack: bug.stack,
		});
	});
});

describe("providerErrorMessage", () => {
	it("returns the code's shared constant and never the provider's words", () => {
		const text = providerErrorMessage(anthropicError(400, "invalid_request_error", CREDIT_PROSE));
		expect(text).toBe(PROVIDER_ERROR_MESSAGES["provider-billing"]);
		expect(text).not.toContain("Anthropic");
		expect(text).not.toContain("Plans & Billing");
	});

	it("keeps the SDK's default text for an unclassified failure", () => {
		expect(providerErrorMessage(new Error("socket hang up"))).toBe("An error occurred.");
	});

	it("round-trips every code through providerErrorCodeOf, and names no code for other text", () => {
		for (const code of PROVIDER_ERROR_CODES) {
			expect(providerErrorCodeOf(PROVIDER_ERROR_MESSAGES[code])).toBe(code);
		}
		expect(new Set(Object.values(PROVIDER_ERROR_MESSAGES)).size).toBe(PROVIDER_ERROR_CODES.length);
		expect(providerErrorCodeOf(CREDIT_PROSE)).toBeUndefined();
	});
});

describe("the stream error text a chat route sends", () => {
	/** Run a model whose call fails with `err` and return the UI stream's error chunks' text. */
	async function errorTexts(err: unknown): Promise<string[]> {
		const model = new MockLanguageModelV3({
			doStream: async () => {
				throw err;
			},
		});
		const result = streamText({ model, prompt: "hi", maxRetries: 0, onError: () => {} });
		const texts: string[] = [];
		for await (const chunk of result.toUIMessageStream({ onError: providerErrorMessage })) {
			if (chunk.type === "error") texts.push(chunk.errorText);
		}
		return texts;
	}

	it("carries the billing constant when the provider refuses for credit", async () => {
		expect(await errorTexts(anthropicError(400, "invalid_request_error", CREDIT_PROSE))).toEqual([
			PROVIDER_ERROR_MESSAGES["provider-billing"],
		]);
	});

	it("carries the auth and overloaded constants", async () => {
		expect(await errorTexts(anthropicError(401, "authentication_error", "invalid x-api-key"))).toEqual([
			PROVIDER_ERROR_MESSAGES["provider-auth"],
		]);
		expect(await errorTexts(anthropicError(529, "overloaded_error", "Overloaded", { isRetryable: true }))).toEqual([
			PROVIDER_ERROR_MESSAGES["provider-overloaded"],
		]);
	});
});
