// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A minimal Paddle Billing API client: one generic `request` plus a smoke call. No SDK and no `as`:
// every response body goes through a zod schema, so what the caller gets is what was checked. Paddle
// wraps a success in `{ data, meta }` and a failure in `{ error: { type, code, detail }, meta }`; both
// envelopes are parsed here, so an endpoint wrapper (L3/L4/L5) passes only the `data` schema.
//
// Errors are typed by WHAT went wrong, because the callers act differently on each: an `http` error
// carries Paddle's own code (a 4xx is ours to fix, a 5xx may be retried), a `timeout` or `network`
// error means the outcome is UNKNOWN (a charge may have been created — reconcile, never blindly
// retry; Paddle has no idempotency key), and `invalid_response` means Paddle answered something this
// client does not understand. Server-only: the API key never leaves this process.

import { z } from "zod";
import type { PaddleEnvironment } from "@/lib/billing/paddle-key";
import { getPaddleConfig } from "@/lib/billing/paddle/config";

/** The API base URL per environment. A sandbox key is refused by the live API and vice versa. */
export const PADDLE_API_BASE_URL: { readonly [E in PaddleEnvironment]: string } = {
	sandbox: "https://sandbox-api.paddle.com",
	live: "https://api.paddle.com",
};

/** The Paddle API version this client speaks (sent as `Paddle-Version`). */
export const PADDLE_API_VERSION = "1";

/** Default per-request timeout. Paddle's p99 is far below this; a hang is treated as unknown. */
export const PADDLE_DEFAULT_TIMEOUT_MS = 15_000;

/** What kind of failure a {@link PaddleApiError} is — see the header for how callers treat each. */
export type PaddleApiErrorKind = "http" | "timeout" | "network" | "invalid_response";

/** A failed Paddle API call. Never carries the API key or the request body. */
export class PaddleApiError extends Error {
	readonly kind: PaddleApiErrorKind;
	/** HTTP status, for `http` (and `invalid_response` when a status was received). */
	readonly status: number | null;
	/** Paddle's error code (e.g. `not_found`, `forbidden`), for `http`. */
	readonly code: string | null;
	/** Paddle's request id, when it sent one — quote it to Paddle support. */
	readonly requestId: string | null;

	/** Builds the error; `message` is safe to log (no secrets, no request body). */
	constructor(
		kind: PaddleApiErrorKind,
		message: string,
		details: { status?: number | null; code?: string | null; requestId?: string | null } = {},
	) {
		super(message);
		this.name = "PaddleApiError";
		this.kind = kind;
		this.status = details.status ?? null;
		this.code = details.code ?? null;
		this.requestId = details.requestId ?? null;
	}

	/** Whether the call's effect is unknown (timeout / network): reconcile before any retry. */
	get outcomeUnknown(): boolean {
		return this.kind === "timeout" || this.kind === "network";
	}
}

const metaSchema = z.looseObject({ request_id: z.string().optional() }).optional();

const errorEnvelope = z.object({
	error: z.object({
		type: z.string().optional(),
		code: z.string(),
		detail: z.string().optional(),
	}),
	meta: metaSchema,
});

/** Paddle's success envelope; `data` is checked separately against the caller's schema. */
const successEnvelope = z.object({ data: z.unknown(), meta: metaSchema });

/** The `invalid_response` error for a failed parse, naming the failing paths — never the values. */
function invalidResponse(issues: readonly z.core.$ZodIssue[], prefix: string, status: number | null): PaddleApiError {
	const paths = issues.map((i) => [prefix, ...i.path.map(String)].filter(Boolean).join(".") || "(root)").join(", ");
	return new PaddleApiError("invalid_response", `Paddle response did not match the expected shape at: ${paths}`, {
		status,
	});
}

/**
 * Parses a Paddle success body against `data` and returns the `data` member. Throws
 * `invalid_response` (naming the failing paths, never the values) when the body does not match.
 */
export function parsePaddleData<T extends z.ZodType>(
	data: T,
	body: unknown,
	status: number | null = null,
): z.infer<T> {
	const envelope = successEnvelope.safeParse(body);
	if (!envelope.success) throw invalidResponse(envelope.error.issues, "", status);
	const parsed = data.safeParse(envelope.data.data);
	if (!parsed.success) throw invalidResponse(parsed.error.issues, "data", status);
	return parsed.data;
}

/** One request: method, path under the base URL, optional query and JSON body. */
export interface PaddleRequest {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	/** Starts with `/`, e.g. `/event-types`. */
	path: string;
	query?: Readonly<Record<string, string | number | boolean | undefined>>;
	body?: unknown;
}

/** What the client needs to talk to Paddle. `fetch` is injectable so tests never hit the network. */
export interface PaddleClientOptions {
	apiKey: string;
	environment: PaddleEnvironment;
	timeoutMs?: number;
	fetch?: typeof fetch;
}

/** One Paddle notification (webhook) event type, as `GET /event-types` lists it. */
export const paddleEventTypeSchema = z.looseObject({
	name: z.string(),
	description: z.string().optional(),
	group: z.string().optional(),
	available_versions: z.array(z.number()).optional(),
});

export type PaddleEventType = z.infer<typeof paddleEventTypeSchema>;

/** The client surface: a generic request, and the read-only smoke call. */
export interface PaddleClient {
	readonly environment: PaddleEnvironment;
	/** Sends `req` and returns its `data`, parsed by `data`. Throws {@link PaddleApiError}. */
	request<T extends z.ZodType>(req: PaddleRequest, data: T): Promise<z.infer<T>>;
	/** `GET /event-types` — read-only, touches no customer data: the "is the key good?" call. */
	getEventTypes(): Promise<PaddleEventType[]>;
}

/** The full URL for a path and query under the environment's base URL. */
export function paddleUrl(environment: PaddleEnvironment, path: string, query?: PaddleRequest["query"]): string {
	const url = new URL(path, PADDLE_API_BASE_URL[environment]);
	for (const [k, v] of Object.entries(query ?? {})) {
		if (v !== undefined) url.searchParams.set(k, String(v));
	}
	return url.toString();
}

/** Reads a response body as JSON, or null when it is empty / not JSON. */
async function readJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value;
	} catch {
		return null;
	}
}

/** Builds a Paddle client over explicit options (tests, scripts). */
export function createPaddleClient(opts: PaddleClientOptions): PaddleClient {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? PADDLE_DEFAULT_TIMEOUT_MS;

	/** Sends one request and parses its success envelope. */
	async function request<T extends z.ZodType>(req: PaddleRequest, data: T): Promise<z.infer<T>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let res: Response;
		try {
			res = await doFetch(paddleUrl(opts.environment, req.path, req.query), {
				method: req.method,
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Paddle-Version": PADDLE_API_VERSION,
					Accept: "application/json",
					...(req.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: req.body === undefined ? undefined : JSON.stringify(req.body),
				signal: controller.signal,
			});
		} catch (err) {
			if (controller.signal.aborted) {
				throw new PaddleApiError("timeout", `Paddle ${req.method} ${req.path} timed out after ${timeoutMs}ms`);
			}
			const reason = err instanceof Error ? err.message : String(err);
			throw new PaddleApiError("network", `Paddle ${req.method} ${req.path} failed: ${reason}`);
		} finally {
			clearTimeout(timer);
		}

		const body = await readJson(res);
		if (!res.ok) {
			const parsed = errorEnvelope.safeParse(body);
			if (parsed.success) {
				const { code, detail } = parsed.data.error;
				throw new PaddleApiError(
					"http",
					`Paddle ${req.method} ${req.path} → ${res.status} ${code}${detail ? `: ${detail}` : ""}`,
					{ status: res.status, code, requestId: parsed.data.meta?.request_id ?? null },
				);
			}
			throw new PaddleApiError("http", `Paddle ${req.method} ${req.path} → ${res.status}`, { status: res.status });
		}
		return parsePaddleData(data, body, res.status);
	}

	return {
		environment: opts.environment,
		request,
		getEventTypes: () => request({ method: "GET", path: "/event-types" }, z.array(paddleEventTypeSchema)),
	};
}

/** The Paddle client for this instance, from the validated config. Throws if Paddle is misconfigured. */
export function paddleClient(): PaddleClient {
	const config = getPaddleConfig();
	return createPaddleClient({ apiKey: config.apiKey, environment: config.environment });
}
