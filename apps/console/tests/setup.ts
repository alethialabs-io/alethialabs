// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount + reset the DOM between tests (Vitest globals are off, so RTL's automatic
// afterEach cleanup isn't registered for us).
afterEach(() => cleanup());

// Better Auth (lib/config/auth.ts) and the DB client (lib/config/database.ts)
// validate env at import. Provide test-safe values; no real connection is made
// (postgres-js connects lazily).
const TEST_ENV: Record<string, string> = {
	BETTER_AUTH_SECRET: "test-secret-not-used",
	NEXT_PUBLIC_APP_URL: "http://localhost:3000",
	ALETHIA_DATABASE_URL: "postgres://test:test@localhost:5432/test",
};
Object.assign(process.env, TEST_ENV);

// next-runtime-env's env() throws for non-public vars in a browser (jsdom) runtime;
// resolve straight from process.env in tests so server-only config (auth/db) loads.
vi.mock("next-runtime-env", () => ({
	env: (key: string) => process.env[key],
}));

// jsdom lacks a few DOM APIs that Radix UI / cmdk touch on mount (ResizeObserver, layout
// measurement, pointer capture). Stub them so dialog/command/select-based components render in
// component tests. Purely additive — only fills gaps jsdom doesn't provide.
if (!globalThis.ResizeObserver) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
// Element only exists in the jsdom project; node-environment tests skip these DOM stubs.
if (typeof Element !== "undefined") {
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
	if (!Element.prototype.hasPointerCapture) {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (!Element.prototype.releasePointerCapture) {
		Element.prototype.releasePointerCapture = () => {};
	}
	// jsdom doesn't implement the Web Animations `Element.getAnimations()`. base-ui's ScrollArea
	// calls viewport.getAnimations({ subtree: true }) to recompute the scrollbar thumb — without
	// this it throws "getAnimations is not a function" and flips the test run to exit 1.
	if (!Element.prototype.getAnimations) {
		Element.prototype.getAnimations = () => [];
	}
}
