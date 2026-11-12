// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a model provider's failure MEANS for the person in the chat, decided once on the server.
//
// A chat route's stream `onError` returns a string, and that string is the only thing the client
// learns about the failure. Before this module every route returned the AI SDK's default
// "An error occurred.", so a provider account with no credit, a rejected API key and a busy model
// all read as one transient error that Retry would fix — and only the first of those is retryable
// at all. The routes now return one of the constants below, and `ChatError` matches them exactly
// (as it matches `MESSAGE_TOO_LONG`), so each end reads the same string from one place.
//
// The provider's own message never reaches the client: only a code's constant does.

import { APICallError, RetryError } from "ai";
import { asRecord } from "@/lib/records";

/** Every provider-failure class a chat route tells the client about. */
export const PROVIDER_ERROR_CODES = [
	"provider-billing",
	"provider-auth",
	"provider-overloaded",
	"network",
] as const;

/** One provider-failure class: who can fix it decides which one it is. */
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * The stream error text a chat route sends for each code. `ChatError` matches these exact strings,
 * so they are shared by both ends. `network` keeps the AI SDK's default text, so an unclassified
 * failure — and a tool's error, which the SDK routes through the same `onError` — reads exactly as
 * it did before.
 */
export const PROVIDER_ERROR_MESSAGES: Readonly<Record<ProviderErrorCode, string>> = {
	"provider-billing": "The AI provider account behind this deployment is out of credit.",
	"provider-auth": "The AI provider rejected this deployment's API key.",
	"provider-overloaded": "The AI provider is busy right now.",
	network: "An error occurred.",
};

/**
 * THE ONE PROSE MATCH. Anthropic answers an exhausted credit balance with HTTP 400 and the
 * generic `invalid_request_error` type — the same status and type as a malformed request — so
 * its message is the only thing that tells the two apart. Measured in `e2e-ai-nightly` run
 * 43016072306 (2026-11-11): `statusCode: 400`, `error.type: "invalid_request_error"`, message
 * "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to
 * upgrade or purchase credits." It is read ONLY on a 400 `invalid_request_error`; every other
 * class is decided by status and typed fields. If Anthropic moves this to its documented
 * `billing_error` type (HTTP 402), the typed rule catches it and this constant can go.
 */
export const ANTHROPIC_CREDIT_EXHAUSTED = /credit balance is too low/i;

/** Provider error `type`s (Anthropic `error.type`, OpenAI `error.type` / `error.code`) per code. */
const BILLING_TYPES: readonly string[] = ["billing_error", "insufficient_quota"];
const AUTH_TYPES: readonly string[] = ["authentication_error", "permission_error"];
const OVERLOADED_TYPES: readonly string[] = ["overloaded_error", "rate_limit_error"];

/** The provider's typed error fields, read off the response body the SDK parsed. */
interface ProviderErrorFields {
	type: string | undefined;
	code: string | undefined;
	message: string | undefined;
}

/** A string field of a record, or undefined when it is absent or not a string. */
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/**
 * Read `{ error: { type, code, message } }` from an `APICallError`: from `data` (the body the
 * provider adapter parsed) when it is there, otherwise by parsing `responseBody` itself.
 */
function providerFields(err: APICallError): ProviderErrorFields {
	let body: unknown = err.data;
	if (body === undefined && err.responseBody) {
		try {
			body = JSON.parse(err.responseBody);
		} catch {
			body = undefined;
		}
	}
	const inner = asRecord(asRecord(body).error);
	return { type: str(inner.type), code: str(inner.code), message: str(inner.message) };
}

/** The provider call behind an error: a `RetryError`'s last attempt, or the error itself. */
function unwrap(err: unknown): unknown {
	return RetryError.isInstance(err) ? err.lastError : err;
}

/**
 * Classify a failure a chat stream raised into the code the client is told. Decided by the AI
 * SDK's typed `APICallError` fields — HTTP status and the provider's error `type` — never by its
 * prose, with the single exception of {@link ANTHROPIC_CREDIT_EXHAUSTED}. A `RetryError` (the SDK
 * gave up after retrying a 429/529) is classified by its last attempt. Anything that is not a
 * provider API call — a dropped socket, a bug of ours — is `network`.
 */
export function classifyProviderError(err: unknown): ProviderErrorCode {
	const cause = unwrap(err);
	if (!APICallError.isInstance(cause)) return "network";
	const status = cause.statusCode;
	const { type, code, message } = providerFields(cause);
	const typed = (list: readonly string[]) =>
		(type !== undefined && list.includes(type)) || (code !== undefined && list.includes(code));

	if (status === 402 || typed(BILLING_TYPES)) return "provider-billing";
	if (
		status === 400 &&
		type === "invalid_request_error" &&
		ANTHROPIC_CREDIT_EXHAUSTED.test(message ?? cause.message)
	) {
		return "provider-billing";
	}
	if (status === 401 || status === 403 || typed(AUTH_TYPES)) return "provider-auth";
	if (status === 429 || status === 529 || typed(OVERLOADED_TYPES)) return "provider-overloaded";
	return "network";
}

/** The stream error text a chat route returns for a failure: its code's shared constant. */
export function providerErrorMessage(err: unknown): string {
	return PROVIDER_ERROR_MESSAGES[classifyProviderError(err)];
}

/**
 * The code a stream error text names, or undefined when it names none. The client half of
 * {@link providerErrorMessage}: an exact match against the shared constants, never a pattern.
 */
export function providerErrorCodeOf(text: string): ProviderErrorCode | undefined {
	return PROVIDER_ERROR_CODES.find((c) => PROVIDER_ERROR_MESSAGES[c] === text);
}
