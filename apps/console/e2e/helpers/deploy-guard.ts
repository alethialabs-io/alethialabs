// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE DEPLOY BOUNDARY, ENFORCED.
//
// `architecture-canvas.spec.ts` designs on a real project with no cloud identity, and every
// assertion in it is about the board, the rail and the client draft. Nothing in it may deploy.
// Until now that was a PROMISE — a sentence in the file header saying nobody clicks Deploy — and a
// promise is not a control. A journey added six months from now clicks one more button than it
// meant to and the file's central claim fails silently, on someone else's infrastructure.
//
// ── WHY TWO LAYERS, AND WHAT EACH ONE CAN PROVE ────────────────────────────────────────────────
//
// Layer 1, `neverActivated`: the Deploy control is wrapped so that click / dblclick / press / tap
// THROW. "Never clicked" becomes a property of the code. This is the layer that holds where the
// wire says nothing at all, and on this fixture that is the normal case: `handleDeploy` parses
// `graphToForm(nodes)` through `projectFormSchema` FIRST, the project has no `cloud_identity_id`,
// the parse fails, and the handler returns having issued ZERO requests. A network-only guard is
// therefore vacuous against the very click it is named after — which is exactly the shape of
// defect this file exists to stop, so it is stated here rather than discovered later.
//
// Layer 2, `watchForDesignPayload`: no request carries the board's design off the page.
//
// ── ATTRIBUTION: WHY NOT "A POST HAPPENED" ─────────────────────────────────────────────────────
//
// A Next server action POSTs to the CURRENT url under an opaque `Next-Action` id; the action's
// NAME is nowhere in the request. `e2e/audit/destructive.spec.ts` records the measurement that
// settles this — on run 34368830312 one page produced SIX unattributable `Next-Action` POSTs from
// its own unrelated work — and this canvas route is no different: the Activity card READS its jobs
// through a server action (`app/server/actions/canvas-jobs`), so "a POST with a Next-Action header
// happened" is true of a test that merely opened Activity. Asserting on that would fail three
// green tests and prove nothing.
//
// What IS attributable is the PAYLOAD. `applyStagedChanges(projectId, envId, parsed.data)` is the
// first request on both the Deploy path and the Save path, and its third argument is the whole
// `graphToForm` projection — an object whose top-level keys are `storage_buckets`, `nosql_tables`,
// `helm_registries` and so on. No read on this route sends those; `listCanvasJobs(projectId,
// envId, cursor)` and `discardStagedChanges(projectId, envId)` send two or three ids.
//
// The key list is DERIVED from `graphToForm` itself rather than typed here, so renaming a field in
// the projection cannot leave this guard quietly matching a shape the app stopped sending. That is
// the whole reason `designPayloadKeys()` calls the function instead of holding a literal.

import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";

/** The one shape this module needs from a Playwright `Request` — so it is testable without one. */
export interface ObservedRequest {
	method: string;
	url: string;
	postData: string | null;
}

/** The minimal Playwright `Page` surface a watcher needs. Same reason. */
export interface RequestEmitter {
	on(event: "request", handler: (request: ObservedRequest) => void): void;
	off(event: "request", handler: (request: ObservedRequest) => void): void;
}

/** Methods that cannot carry a body, and so cannot carry the design. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * How many of the projection's keys must appear before a body counts as the design.
 *
 * One would be enough for soundness and is wrong for robustness: a single common word like
 * `services` could plausibly appear in an unrelated payload, and a guard that cries wolf is turned
 * off. Three of these specific keys together have no other source in this app.
 */
export const MIN_KEYS = 3;

/**
 * The top-level keys `graphToForm` puts on the wire, read off the function itself.
 *
 * Keys whose value is `undefined` for an empty graph (`network`, `cluster`) are dropped: JSON
 * serialisation omits them, so a key that is only ever absent would dilute the count and could
 * never contribute a match.
 *
 * @returns The serialisable top-level key names of the deploy/save payload.
 */
export function designPayloadKeys(): string[] {
	const projection = graphToForm([]);
	return Object.keys(projection).filter((k) => projection[k] !== undefined);
}

/**
 * Does this request carry the board's design off the page?
 *
 * @param request The request as observed.
 * @param keys The payload's key vocabulary, from {@link designPayloadKeys}.
 * @param min How many distinct keys must appear. Defaults to {@link MIN_KEYS}.
 * @returns True when the body is the `graphToForm` projection — i.e. an apply / deploy / save.
 */
export function carriesDesignPayload(
	request: ObservedRequest,
	keys: string[],
	min: number = MIN_KEYS,
): boolean {
	if (READ_METHODS.has(request.method.toUpperCase())) return false;
	const body = request.postData;
	if (!body) return false;
	// The quotes matter. Next serialises the action's arguments as JSON text, so the key appears as
	// `"storage_buckets":` — matching the bare word would also match it inside any prose a body
	// happens to carry, which is how a guard starts failing tests for the wrong reason.
	let hit = 0;
	for (const key of keys) {
		if (body.includes(`"${key}"`)) hit += 1;
		if (hit >= min) return true;
	}
	return false;
}

/** A one-line description of a request, for the failure message. */
export function describeRequest(request: ObservedRequest): string {
	let pathname = request.url;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		// A relative or malformed url is still worth printing verbatim.
	}
	return `${request.method} ${pathname} (${request.postData?.length ?? 0} bytes)`;
}

/** What a watcher hands back. */
export interface DesignPayloadWatch {
	/** Stop listening and return every request that carried the design. */
	stop(): ObservedRequest[];
	/** The requests seen so far, without stopping. */
	readonly seen: ObservedRequest[];
}

/**
 * Record every request from now on that carries the board's design off the page.
 *
 * Attach this AFTER the canvas is ready: creating the project legitimately posts the form to
 * `~/new`, and that request is the fixture, not a finding.
 *
 * @param page The page to watch.
 * @param keys The payload vocabulary; defaults to {@link designPayloadKeys}.
 * @returns A handle whose `stop()` returns the offending requests (empty is the pass).
 */
export function watchForDesignPayload(
	page: RequestEmitter,
	keys: string[] = designPayloadKeys(),
): DesignPayloadWatch {
	const seen: ObservedRequest[] = [];
	const onRequest = (request: ObservedRequest) => {
		if (carriesDesignPayload(request, keys)) seen.push(request);
	};
	page.on("request", onRequest);
	return {
		seen,
		stop() {
			page.off("request", onRequest);
			return seen;
		},
	};
}

/** The message a boundary breach prints. Shared so the assertion and its test cannot drift. */
export function breachMessage(requests: ObservedRequest[]): string {
	return (
		`the deploy boundary was crossed: ${requests.length} request(s) carried this board's design ` +
		`off the page. This spec designs on a project with no cloud identity and must never apply, ` +
		`save or provision — ${requests.map(describeRequest).join(", ")}`
	);
}

/** Verbs that ACTIVATE a control, as opposed to reading or locating it. */
const ACTIVATION = new Set(["click", "dblclick", "press", "tap", "setChecked", "selectOption"]);

/**
 * Wrap a locator so that activating it throws.
 *
 * The control is still located, still asserted on, still read — its presence and its label are the
 * evidence that the boundary exists at all. What it cannot do is fire. Borrowed wholesale from
 * `e2e/audit/destructive.spec.ts`'s `assertNeverPressed`, which makes the same move for a
 * destructive confirmation.
 *
 * @param locator The control that must never be activated.
 * @param why What is being protected, for the thrown message.
 * @returns A proxy of `locator` whose activation verbs throw.
 */
export function neverActivated<T extends object>(locator: T, why: string): T {
	return new Proxy(locator, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && ACTIVATION.has(prop)) {
				return () => {
					throw new Error(
						`${why}: this control must NEVER be activated by this spec. ` +
							`\`${prop}()\` was called on it.`,
					);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
