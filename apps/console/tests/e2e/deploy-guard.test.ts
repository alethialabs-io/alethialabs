// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas spec's deploy boundary, tested WITHOUT a browser.
//
// `e2e/helpers/deploy-guard.ts` is the thing that turns "nobody clicks Deploy" from a sentence in a
// file header into a control. A guard is only worth its line count if it FIRES, and a guard that
// can only be exercised by the browser leg is a guard nobody exercises: the canvas leg is not a
// required check, so it can sit broken behind a green PR indefinitely. Splitting the predicate out
// of the spec is what makes this file possible, and this file is the proof.
//
// ⚠ THE FIXTURE IS NOT COMPOSED. Every "this is what a deploy looks like" body below is
// `JSON.stringify(graphToForm(<a real board>))` — the exact projection `handleDeploy` hands to
// `applyStagedChanges`. A hand-written `'{"storage_buckets":[]}'` would test the matcher against a
// string written to satisfy it, which is the failure mode where the guard and its evidence are the
// same artefact and both are wrong together.

import { describe, expect, it, vi } from "vitest";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import {
	MIN_KEYS,
	breachMessage,
	carriesDesignPayload,
	describeRequest,
	designPayloadKeys,
	neverActivated,
	observe,
	watchForDesignPayload,
	watchPage,
	type ObservedRequest,
	type PlaywrightRequestLike,
} from "../../e2e/helpers/deploy-guard";

/** A board holding the project root and one bucket — the smallest thing a Deploy would send. */
function board(): CanvasNode[] {
	const node = (kind: "project" | "bucket", id: string, name: string) =>
		({
			id,
			type: kind,
			position: { x: 0, y: 0 },
			data: {
				kind,
				config: { ...NODE_REGISTRY[kind].defaultData("aws"), name },
				cloud_identity_id: null,
				provider: "aws",
			},
		}) as CanvasNode;
	return [node("project", "project-root", "guard-fixture"), node("bucket", "b1", "assets")];
}

/** The body the app would actually put on the wire for that board. */
const DEPLOY_BODY = JSON.stringify([
	"project-id",
	"environment-id",
	graphToForm(board()),
]);

const KEYS = designPayloadKeys();

function request(over: Partial<ObservedRequest> = {}): ObservedRequest {
	return {
		method: "POST",
		url: "http://localhost:3000/acme/proj/architecture",
		postData: null,
		...over,
	};
}

describe("the payload vocabulary is derived, not typed", () => {
	it("is exactly graphToForm's serialisable top-level keys", () => {
		const projection = graphToForm([]);
		const expected = Object.keys(projection).filter((k) => projection[k] !== undefined);
		expect(KEYS).toEqual(expected);
	});

	it("holds enough keys for the MIN_KEYS threshold to be reachable at all", () => {
		// A vocabulary that shrank below the threshold would make the guard permanently silent —
		// the shape where "it never fired" reads identically to "nothing bad happened".
		expect(KEYS.length).toBeGreaterThanOrEqual(MIN_KEYS);
	});

	it("names the collections the canvas actually ships", () => {
		expect(KEYS).toEqual(expect.arrayContaining(["storage_buckets", "nosql_tables", "secrets"]));
	});
});

describe("carriesDesignPayload fires on a real apply body and on nothing else", () => {
	it("fires on the projection handleDeploy sends", () => {
		expect(carriesDesignPayload(request({ postData: DEPLOY_BODY }), KEYS)).toBe(true);
	});

	it("does NOT fire on a jobs READ — the Activity card posts a server action too", () => {
		// `listCanvasJobs(projectId, environmentId, cursor)`: three ids, no design. This is the
		// case that makes "a Next-Action POST happened" unusable as the predicate, and three
		// currently-green tests in the canvas spec open the Activity card.
		const body = JSON.stringify(["project-id", "environment-id", null]);
		expect(carriesDesignPayload(request({ postData: body }), KEYS)).toBe(false);
	});

	it("does NOT fire on the Discard the spec legitimately performs", () => {
		const body = JSON.stringify(["project-id", "environment-id"]);
		expect(carriesDesignPayload(request({ postData: body }), KEYS)).toBe(false);
	});

	it("does NOT fire on a read method, even carrying the payload", () => {
		expect(
			carriesDesignPayload(request({ method: "GET", postData: DEPLOY_BODY }), KEYS),
		).toBe(false);
	});

	it("does NOT fire on a body with no post data at all", () => {
		expect(carriesDesignPayload(request(), KEYS)).toBe(false);
	});

	it("needs MIN_KEYS of them — one common word is not a design", () => {
		// `services` alone is a word; `services` + `secrets` + `topics` together are the projection.
		expect(carriesDesignPayload(request({ postData: '{"services":[]}' }), KEYS)).toBe(false);
	});

	it("matches the QUOTED key, so the same word in prose is not a match", () => {
		const prose = JSON.stringify({
			note: "check the storage_buckets and the nosql_tables and the secrets",
		});
		expect(carriesDesignPayload(request({ postData: prose }), KEYS)).toBe(false);
	});
});

describe("the watcher attaches, records and detaches", () => {
	/** A stand-in for Playwright's `Page` that records its own listener bookkeeping. */
	function emitter() {
		const handlers = new Set<(r: ObservedRequest) => void>();
		return {
			on: (_e: "request", h: (r: ObservedRequest) => void) => void handlers.add(h),
			off: (_e: "request", h: (r: ObservedRequest) => void) => void handlers.delete(h),
			emit: (r: ObservedRequest) => handlers.forEach((h) => h(r)),
			get size() {
				return handlers.size;
			},
		};
	}

	it("records a deploy and ignores a read", () => {
		const page = emitter();
		const watch = watchForDesignPayload(page, KEYS);

		page.emit(request({ method: "GET", postData: null }));
		page.emit(request({ postData: JSON.stringify(["p", "e", null]) }));
		expect(watch.seen).toHaveLength(0);

		page.emit(request({ postData: DEPLOY_BODY }));
		expect(watch.stop()).toHaveLength(1);
	});

	it("stops listening on stop(), so an afterEach cannot record the next test's traffic", () => {
		const page = emitter();
		const watch = watchForDesignPayload(page, KEYS);
		expect(page.size).toBe(1);
		watch.stop();
		expect(page.size).toBe(0);
		page.emit(request({ postData: DEPLOY_BODY }));
		expect(watch.seen).toHaveLength(0);
	});

	it("the Playwright adapter reads methods, and the predicate still fires through it", () => {
		// The seam between Playwright's method-shaped Request and the property-shaped predicate. A
		// broken adapter is the quietest way for this guard to go permanently silent: every unit
		// test above would stay green while the browser leg recorded nothing.
		const handlers = new Set<(r: PlaywrightRequestLike) => void>();
		const page = {
			on: (_e: "request", h: (r: PlaywrightRequestLike) => void) => void handlers.add(h),
			off: (_e: "request", h: (r: PlaywrightRequestLike) => void) => void handlers.delete(h),
		};
		const asPlaywright = (r: ObservedRequest): PlaywrightRequestLike => ({
			method: () => r.method,
			url: () => r.url,
			postData: () => r.postData,
		});

		const watch = watchPage(page, KEYS);
		handlers.forEach((h) => h(asPlaywright(request({ postData: JSON.stringify(["p", "e"]) }))));
		expect(watch.seen).toHaveLength(0);
		handlers.forEach((h) => h(asPlaywright(request({ postData: DEPLOY_BODY }))));
		expect(watch.stop()).toHaveLength(1);
		expect(handlers.size).toBe(0);
	});

	it("observe() copies every field the predicate reads", () => {
		const source = request({ postData: DEPLOY_BODY });
		expect(
			observe({
				method: () => source.method,
				url: () => source.url,
				postData: () => source.postData,
			}),
		).toEqual(source);
	});

	it("the breach message names the request rather than just counting", () => {
		const message = breachMessage([request({ postData: DEPLOY_BODY })]);
		expect(message).toContain("/acme/proj/architecture");
		expect(message).toContain("1 request(s)");
	});

	it("describeRequest survives a url it cannot parse", () => {
		expect(describeRequest(request({ url: "not-a-url" }))).toContain("not-a-url");
	});
});

describe("neverActivated makes 'never clicked' a property of the code", () => {
	const verbs = ["click", "dblclick", "press", "tap", "setChecked", "selectOption"] as const;

	it.each(verbs)("throws on %s()", (verb) => {
		const locator = { [verb]: vi.fn(), textContent: () => "Deploy" } as Record<string, unknown>;
		const guarded = neverActivated(locator, "Deploy");
		expect(() => (guarded[verb] as () => void)()).toThrow(/must NEVER be activated/);
		expect(locator[verb]).not.toHaveBeenCalled();
	});

	it("leaves every read verb alone — the control is still asserted on", () => {
		const locator = {
			click: vi.fn(),
			textContent: () => "Deploy",
			isVisible: () => true,
		};
		const guarded = neverActivated(locator, "Deploy");
		expect(guarded.textContent()).toBe("Deploy");
		expect(guarded.isVisible()).toBe(true);
	});
});
