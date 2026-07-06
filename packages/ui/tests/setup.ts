// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// jest-dom matchers (toBeInTheDocument, toHaveValue, …) for the @repo/ui component tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount + reset the DOM between tests (we don't enable Vitest globals, so RTL's automatic
// afterEach cleanup isn't registered for us).
afterEach(() => cleanup());

// Radix primitives (Popover/Select) and react-day-picker use a handful of DOM APIs that
// jsdom doesn't implement. Shim them so interaction tests can open popovers etc.
if (typeof window !== "undefined") {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => {};
	Element.prototype.releasePointerCapture ??= () => {};
	Element.prototype.scrollIntoView ??= () => {};
	window.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

