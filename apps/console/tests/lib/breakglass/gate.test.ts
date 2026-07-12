// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the break-glass GATE + catalog invariants (no DB needed): the master switch is
// truly default-off, the operator allowlist is distinct from support-staff, HIGH-blast ⇒ two-person,
// and the route guard refuses (404 off / 403 non-operator) before anything privileged runs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	breakglassOperators,
	isBreakglassEnabled,
	isBreakglassOperator,
	isOrphanCleanArmed,
} from "@/lib/breakglass/config";
import { resolveBreakglassOperator } from "@/lib/breakglass/auth";
import { BREAKGLASS_CATALOG, catalogSpec } from "@/lib/breakglass/catalog";
import { guardBreakglass } from "@/lib/breakglass/guard";

const ENV_KEYS = [
	"ALETHIA_BREAKGLASS_ENABLED",
	"BREAKGLASS_OPERATORS",
	"BREAKGLASS_DEV_EMAIL",
	"ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED",
	"BREAKGLASS_ACCESS_PROXY_SECRET",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("break-glass master switch (default-off)", () => {
	it("is OFF when the flag is unset", () => {
		expect(isBreakglassEnabled()).toBe(false);
	});
	it("is OFF for anything other than the exact string 'true'", () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "1";
		expect(isBreakglassEnabled()).toBe(false);
		process.env.ALETHIA_BREAKGLASS_ENABLED = "TRUE";
		expect(isBreakglassEnabled()).toBe(false);
		process.env.ALETHIA_BREAKGLASS_ENABLED = "yes";
		expect(isBreakglassEnabled()).toBe(false);
	});
	it("is ON only for 'true'", () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
		expect(isBreakglassEnabled()).toBe(true);
	});
	it("orphan-clean arming is independent + default-off", () => {
		expect(isOrphanCleanArmed()).toBe(false);
		process.env.ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED = "true";
		expect(isOrphanCleanArmed()).toBe(true);
	});
});

describe("break-glass operator allowlist (distinct from support-staff)", () => {
	it("parses + lowercases the comma-separated list", () => {
		process.env.BREAKGLASS_OPERATORS = " Alice@x.io ,BOB@x.io ";
		expect(breakglassOperators()).toEqual(["alice@x.io", "bob@x.io"]);
	});
	it("authorizes only listed emails, case-insensitively", () => {
		process.env.BREAKGLASS_OPERATORS = "alice@x.io";
		expect(isBreakglassOperator("ALICE@x.io")).toBe(true);
		expect(isBreakglassOperator("mallory@x.io")).toBe(false);
		expect(isBreakglassOperator(null)).toBe(false);
	});
	it("nobody is an operator when the list is empty (fail-closed)", () => {
		expect(isBreakglassOperator("alice@x.io")).toBe(false);
	});
});

describe("catalog invariants", () => {
	it("every HIGH-blast action requires two-person approval", () => {
		for (const [action, spec] of Object.entries(BREAKGLASS_CATALOG)) {
			if (spec.blastRadius === "high") {
				expect(spec.requiresApproval, `${action} is high-blast but not two-person`).toBe(true);
			}
		}
	});
	it("read-only actions never require approval and never mutate", () => {
		for (const spec of Object.values(BREAKGLASS_CATALOG)) {
			if (spec.readOnly) expect(spec.requiresApproval).toBe(false);
		}
	});
	it("the force-destroy actions are marked inert (fail-closed)", () => {
		expect(BREAKGLASS_CATALOG.orphan_clean.inert).toBe(true);
		expect(BREAKGLASS_CATALOG.state_surgery.inert).toBe(true);
	});
	it("open_session has no dispatch spec", () => {
		expect(catalogSpec("open_session")).toBeNull();
	});
});

describe("route guard (fail-closed)", () => {
	it("returns 404 when break-glass is disabled (surface indistinguishable from absent)", async () => {
		const res = await guardBreakglass(new Request("https://c/api/breakglass/execute"));
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error.status).toBe(404);
	});
	it("returns 403 when enabled but the caller is not an operator", async () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
		// No CF-Access header, no bearer, no dev email → resolveBreakglassOperator returns null.
		const res = await guardBreakglass(new Request("https://c/api/breakglass/execute"));
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error.status).toBe(403);
	});
	it("returns 403 when a CF-Access identity is present but not allowlisted", async () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
		process.env.BREAKGLASS_OPERATORS = "alice@x.io";
		const res = await guardBreakglass(
			new Request("https://c/api/breakglass/execute", {
				headers: { "cf-access-authenticated-user-email": "mallory@x.io" },
			}),
		);
		expect("error" in res).toBe(true);
		if ("error" in res) expect(res.error.status).toBe(403);
	});
});

describe("CF-Access header spoofing defense", () => {
	it("REJECTS an allowlisted CF-Access email when the proxy secret is unset (header path disabled)", async () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
		process.env.BREAKGLASS_OPERATORS = "alice@x.io";
		// A direct-to-console request spoofing the header for a real operator — must NOT be trusted.
		const op = await resolveBreakglassOperator(
			new Request("https://c/api/breakglass/execute", {
				headers: { "cf-access-authenticated-user-email": "alice@x.io" },
			}),
		);
		expect(op).toBeNull();
	});
	it("REJECTS an allowlisted CF-Access email when the proxy secret is wrong", async () => {
		process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
		process.env.BREAKGLASS_OPERATORS = "alice@x.io";
		process.env.BREAKGLASS_ACCESS_PROXY_SECRET = "correct-secret";
		const op = await resolveBreakglassOperator(
			new Request("https://c/api/breakglass/execute", {
				headers: {
					"cf-access-authenticated-user-email": "alice@x.io",
					"x-breakglass-proxy-secret": "WRONG",
				},
			}),
		);
		expect(op).toBeNull();
	});
});
