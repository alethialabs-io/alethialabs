// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the undici behaviour the console's GLOBAL fetch depends on (#5087).
//
// The console depends on the npm `undici` package (lib/net/ssrf-guard.ts). Importing it installs its
// Agent, wrapped in `Dispatcher1Wrapper`, into `Symbol.for("undici.globalDispatcher.1")` — the slot
// Node's OWN bundled fetch reads. So from that import on, every plain `fetch()` in the console (the
// GitHub OIDC and E2E-broker calls included) is carried by the npm undici's Agent.
//
// undici 8.11.0 stopped forcing HTTP/1.1 for those legacy (v1) callers (only WebSocket upgrades kept
// it). Over HTTP/2 the response reached Node's fetch WITHOUT its content-encoding header, so a
// Cloudflare brotli body was handed to `response.json()` undecoded: "Unexpected token '\x1b' ... is
// not valid JSON" in grid run 36611808450. 8.10.2 and 8.11.2 force `allowH2: false`; this test fails
// on any version that does not.

import { Dispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

const LEGACY_SLOT = Symbol.for("undici.globalDispatcher.1");
const CURRENT_SLOT = Symbol.for("undici.globalDispatcher.2");

const saved = {
	legacy: Reflect.get(globalThis, LEGACY_SLOT),
	current: Reflect.get(globalThis, CURRENT_SLOT),
};

afterEach(() => {
	Reflect.set(globalThis, LEGACY_SLOT, saved.legacy);
	Reflect.set(globalThis, CURRENT_SLOT, saved.current);
});

/** Narrows a global-slot value to something with a `dispatch` method. */
function isDispatcher(
	value: unknown,
): value is { dispatch: (opts: object, handler: object) => unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"dispatch" in value &&
		typeof value.dispatch === "function"
	);
}

describe("npm undici as the dispatcher behind Node's global fetch", () => {
	it("forces HTTP/1.1 for a legacy (Node-bundled fetch) request", () => {
		const inner = vi.fn((_opts: object) => true);
		/** Records the options the wrapper forwards instead of opening a socket. */
		class RecordingDispatcher extends Dispatcher {
			dispatch(opts: Dispatcher.DispatchOptions): boolean {
				return inner(opts);
			}
		}
		setGlobalDispatcher(new RecordingDispatcher());

		const legacy: unknown = Reflect.get(globalThis, LEGACY_SLOT);
		expect(isDispatcher(legacy)).toBe(true);
		if (!isDispatcher(legacy)) return;
		// The call shape Node's bundled fetch makes: a plain request with a v1 (onHeaders) handler.
		legacy.dispatch(
			{ origin: "https://e2e-issuer.example.test", path: "/v1/assertions", method: "POST" },
			{ onConnect() {}, onHeaders() {}, onData() {}, onComplete() {}, onError() {} },
		);

		expect(inner).toHaveBeenCalledTimes(1);
		const forwarded = inner.mock.calls[0]?.[0];
		expect(forwarded && "allowH2" in forwarded ? forwarded.allowH2 : undefined).toBe(false);
	});
});
