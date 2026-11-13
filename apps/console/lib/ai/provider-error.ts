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

/** Provider error `type`s / `code`s (Anthropic `error.type`, OpenAI `error.type` / `error.code`) that mean billing. */
const BILLING_TYPES: readonly string[] = ["billing_error", "insufficient_quota"];
/** Provider error `type`s that mean the API key was rejected or lacks permission. */
const AUTH_TYPES: readonly string[] = ["authentication_error", "permission_error"];
/** Provider error `type`s that mean the provider is busy or rate-limiting us: Retry is right. */
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
 * The `type` of an error the provider sent INSIDE a stream that had already answered HTTP 200.
 * `@ai-sdk/anthropic` forwards Anthropic's SSE `error` event as the event's plain
 * `{ type, message }` object, not an `APICallError`, so there is no status to read — only the type.
 * Undefined for anything else, including every `Error` (a bug of ours is never a provider type).
 */
function streamedErrorType(cause: unknown): string | undefined {
	if (cause instanceof Error) return undefined;
	return str(asRecord(cause).type);
}

/** Whether a provider `type` or `code` is one of `list`'s. */
function typedIn(list: readonly string[], type: string | undefined, code: string | undefined): boolean {
	return (type !== undefined && list.includes(type)) || (code !== undefined && list.includes(code));
}

/**
 * Classify a failure a chat stream raised into the code the client is told. Decided by the AI
 * SDK's typed `APICallError` fields — HTTP status and the provider's error `type` — never by its
 * prose, with the single exception of {@link ANTHROPIC_CREDIT_EXHAUSTED}. A `RetryError` (the SDK
 * gave up after retrying a 429/529) is classified by its last attempt; an error the provider sent
 * mid-stream is classified by its type alone. Anything that is not a provider failure — a dropped
 * socket, a bug of ours — is `network`.
 */
export function classifyProviderError(err: unknown): ProviderErrorCode {
	const cause = unwrap(err);
	if (!APICallError.isInstance(cause)) {
		const streamed = streamedErrorType(cause);
		if (typedIn(BILLING_TYPES, streamed, undefined)) return "provider-billing";
		if (typedIn(AUTH_TYPES, streamed, undefined)) return "provider-auth";
		if (typedIn(OVERLOADED_TYPES, streamed, undefined)) return "provider-overloaded";
		return "network";
	}
	const status = cause.statusCode;
	const { type, code, message } = providerFields(cause);
	/** Whether this response's type or code is one of `list`'s. */
	const typed = (list: readonly string[]) => typedIn(list, type, code);

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

/**
 * The SQL text of a failed database query when `err` is drizzle-orm's `DrizzleQueryError`, else
 * undefined. Recognised by shape (an own `query` string and an own `params` array), exactly as the
 * logger's `err` serializer (`failedQueryText` in lib/observability/log.ts) recognises it: that
 * error's message is `Failed query: <sql>\nparams: <values>`, so it carries bound parameter values.
 */
function failedQueryText(err: Error): string | undefined {
	if (
		Object.hasOwn(err, "query") &&
		"query" in err &&
		typeof err.query === "string" &&
		Object.hasOwn(err, "params") &&
		"params" in err &&
		Array.isArray(err.params)
	) {
		return err.query;
	}
	return undefined;
}

/**
 * The name, message and stack of a failure that is not a provider call, written by the same rules
 * as the logger's `err` serializer. Its callers log the summary under `error`, which pino does not
 * serialize, so the rules are applied here: nothing but these three fields is copied, and a failed
 * database query is written as `Failed query: <sql>` with no stack, because the original message and
 * the stack (which repeats it) carry the query's parameter values. The serializer is not exported
 * from lib/observability/log.ts, so this mirrors its rule for that error rather than calling it.
 */
function errorFields(err: Error): { name: string; message: string; stack?: string } {
	const query = failedQueryText(err);
	if (query !== undefined) return { name: err.name, message: `Failed query: ${query}` };
	return { name: err.name, message: err.message, stack: err.stack };
}

/**
 * What a chat route LOGS about a failure, instead of the raw error. An `APICallError` carries the
 * whole request it sent (`requestBodyValues`: the system prompt and the user's conversation) plus
 * the provider's response headers and body — none of which belongs in a log line. The callers log
 * this summary under `error`, which the logger's `err` serializer does not see, so this function is
 * the only allow-list on that field. It keeps what an operator needs to
 * diagnose the failure and nothing the user typed: the class, the HTTP status, the provider's typed
 * fields and request id, and — for a failure that is not a provider call, i.e. a bug of ours — the
 * error's name, message and stack, held to the `err` serializer's rules (see {@link errorFields}).
 */
export function providerErrorSummary(err: unknown): Record<string, unknown> {
	const code = classifyProviderError(err);
	const attempts = RetryError.isInstance(err) ? err.errors.length : undefined;
	const cause = unwrap(err);
	if (APICallError.isInstance(cause)) {
		const fields = providerFields(cause);
		return {
			code,
			attempts,
			status: cause.statusCode,
			provider_type: fields.type,
			provider_code: fields.code,
			provider_message: fields.message ?? cause.message,
			request_id: cause.responseHeaders?.["request-id"],
		};
	}
	if (cause instanceof Error) {
		return { code, attempts, ...errorFields(cause) };
	}
	return { code, attempts, provider_type: streamedErrorType(cause) };
}
