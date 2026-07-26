// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// jest-dom matchers (toBeInTheDocument, toHaveValue, …) for the @repo/ui component tests.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount + reset the DOM between tests (we don't enable Vitest globals, so RTL's automatic
// afterEach cleanup isn't registered for us).
afterEach(() => cleanup());

// RTL's async utilities (`waitFor` / `findBy*`) default to a 1000ms timeout that is INDEPENDENT of
// vitest's per-test `testTimeout` (15000ms in vitest.config.ts). On a loaded CI runner the overlay-
// driven flows in these component tests — a base-ui Popover portal mounting, cmdk's async list
// filtering, the PhoneInput onChange settling a microtask after the last keystroke — routinely take
// longer than 1s to reach the settled state, so an individual `findBy`/`waitFor` would time out and
// RED the required TypeScript job on unrelated PRs (stalling the Mergify queue) even though the
// behaviour is correct. Give every async utility generous headroom (well under the 15s per-test
// budget) so the tests wait for the settled state instead of racing a too-short default. This is the
// systemic sibling of the existing `testTimeout` bump — it covers the per-assertion waits that
// `testTimeout` does not.
configure({ asyncUtilTimeout: 8000 });

// base-ui primitives (Popover/Select/Menu/Tooltip/…) and react-day-picker use a handful of DOM APIs
// that jsdom doesn't implement. Shim them so interaction tests can open popovers etc.
if (typeof window !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  // base-ui overlays call `getAnimations()` (via ScrollArea / popup enter-exit) which jsdom lacks;
  // returning [] makes it a harmless no-op instead of throwing inside the popup and blocking render.
  Element.prototype.getAnimations ??= () => [];
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement `PointerEvent`. base-ui's overlays open on pointer interactions (Floating UI
// listens for `pointerdown`), so without a `PointerEvent` constructor a `userEvent.click`/focus-open
// never drives the popup to mount. Polyfill a minimal one (extends `MouseEvent`).
if (
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { PointerEvent?: unknown }).PointerEvent ===
    "undefined" &&
  typeof MouseEvent !== "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  (globalThis as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}
