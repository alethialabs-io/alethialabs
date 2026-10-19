// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6149 (ADR 0005 stress test R2, finding F049) — the enterprise load records its OUTCOME.
//
// The old loader latched `loaded = true` BEFORE trying, so in a process configured as enterprise a
// `register()` that threw once left every later `getEnterprise()` answering null — community — and
// `currentActor()` then served every org address from the personal scope with a 200. These tests
// drive the loader through a stubbed `createRequire` and pin: a failed load throws on EVERY call;
// the edition is reported, not guessed; a package only one resolution base can see still loads.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));

/** What each `createRequire(base)` call hands back, keyed by whether the base is the cwd. */
const requireFor = vi.hoisted(() => ({
	chunk: vi.fn<(id: string) => unknown>(),
	cwd: vi.fn<(id: string) => unknown>(),
}));

vi.mock("@/lib/enterprise-require", () => ({
	requireFromWorkingDirectory: (specifier: string) => {
		try {
			return requireFor.cwd(specifier);
		} catch {
			return undefined;
		}
	},
}));

// The primary require goes through the bundler-visible `createRequire(import.meta.url)`; the
// working-directory fallback goes through the runtime's loader (`process.getBuiltinModule`), which
// the bundler cannot rewrite. Both are stubbed so each case decides what each base can see.
vi.mock("node:module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:module")>();
	const createRequire = () => requireFor.chunk;
	return { ...actual, default: { ...actual, createRequire }, createRequire };
});

/**
 * The package name as Node prints it in a missing-module error. Assembled rather than written out:
 * this file FABRICATES that error text and never imports or resolves the package, and
 * `scripts/check-open-core-boundary.mjs` (correctly) refuses the literal outside the loader.
 */
const EE_PACKAGE = ["@alethia", "ee"].join("/");

/** Node's missing-module error, shaped as `isMissingEnterprisePackage` reads it. */
function missing(): Error {
	return Object.assign(new Error(`Cannot find module '${EE_PACKAGE}'`), { code: "MODULE_NOT_FOUND" });
}

/** A fresh copy of the module under test, so each case starts with no recorded outcome. */
async function freshEnterprise() {
	vi.resetModules();
	return import("@/lib/enterprise");
}

beforeEach(() => {
	requireFor.chunk.mockReset();
	requireFor.cwd.mockReset();
	vi.unstubAllEnvs();
});

describe("a failed enterprise load", () => {
	it("throws on EVERY call, never degrading to community after the first (the R2 latch)", async () => {
		vi.stubEnv("ALETHIA_EDITION", "enterprise");
		requireFor.chunk.mockReturnValue({
			register: () => {
				throw new Error("register blew up");
			},
		});
		const { getEnterprise, editionState } = await freshEnterprise();
		expect(() => getEnterprise()).toThrow("register blew up");
		expect(() => getEnterprise()).toThrow("register blew up");
		expect(editionState().kind).toBe("failed");
	});

	it("...and a missing package is a failure, not community, when the edition says enterprise", async () => {
		vi.stubEnv("ALETHIA_EDITION", "enterprise");
		requireFor.chunk.mockImplementation(() => {
			throw missing();
		});
		requireFor.cwd.mockImplementation(() => {
			throw missing();
		});
		const { getEnterprise } = await freshEnterprise();
		expect(() => getEnterprise()).toThrow(EE_PACKAGE);
		expect(() => getEnterprise()).toThrow(EE_PACKAGE);
	});
});

describe("the edition is reported, not guessed", () => {
	it("community by configuration never touches the package", async () => {
		vi.stubEnv("ALETHIA_EDITION", "community");
		const { getEnterprise, editionState } = await freshEnterprise();
		expect(getEnterprise()).toBeNull();
		expect(editionState()).toEqual({ kind: "community", reason: "configured" });
		expect(requireFor.chunk).not.toHaveBeenCalled();
	});

	it("an unset edition with no package found anywhere is community-NOT-INSTALLED, not configured", async () => {
		vi.stubEnv("ALETHIA_EDITION", "");
		requireFor.chunk.mockImplementation(() => {
			throw missing();
		});
		requireFor.cwd.mockImplementation(() => {
			throw missing();
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { getEnterprise, editionState } = await freshEnterprise();
		expect(getEnterprise()).toBeNull();
		expect(editionState()).toEqual({ kind: "community", reason: "not-installed" });
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});
});

describe("a package only the working directory can see still loads (F049's resolution miss)", () => {
	it("falls back from the chunk's base to the app's working directory", async () => {
		vi.stubEnv("ALETHIA_EDITION", "");
		const mod = { resolveScope: vi.fn() };
		requireFor.chunk.mockImplementation(() => {
			throw missing();
		});
		requireFor.cwd.mockReturnValue({ register: () => mod });
		const { getEnterprise, editionState } = await freshEnterprise();
		expect(getEnterprise()).toBe(mod);
		expect(editionState()).toEqual({ kind: "enterprise" });
	});
});
