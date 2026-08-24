// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI transparency gate (#2373).
//
// The behaviour that matters is a refusal, and refusals are the easiest thing to soften later —
// "just warn for now" is exactly how a feature ships ahead of its paperwork. So these assert that
// EVERY missing item refuses on its own, that the refusal names what is missing AND the variable
// that fixes it, and that the disclosure says something a reader can actually use.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-runtime-env", () => ({ env: vi.fn() }));

import { env } from "next-runtime-env";
import {
	AI_SYSTEM_CLASSIFICATION,
	AI_SYSTEM_DISCLOSURE,
	providerEvidence,
	providerGate,
	transparencyRecord,
} from "@/lib/ai/transparency";

/** Arms the four evidence vars for anthropic, minus whichever are named. */
function withEvidence(missing: string[] = []) {
	const values: Record<string, string> = {
		ALETHIA_AI_ANTHROPIC_DPA: "Anthropic Commercial Terms + DPA (2026-08-01)",
		ALETHIA_AI_ANTHROPIC_TRANSFER: "EU SCCs module 2, plus the EU-US DPF certification",
		ALETHIA_AI_ANTHROPIC_RETENTION: "30 days for abuse monitoring, then deleted",
		ALETHIA_AI_ANTHROPIC_NO_TRAINING: "Commercial terms exclude training on inputs and outputs",
	};
	for (const k of missing) delete values[k];
	vi.mocked(env).mockImplementation((name: string) => values[name]);
}

afterEach(() => vi.resetAllMocks());

describe("the provider gate", () => {
	it("allows a provider once all four are configured", () => {
		withEvidence();
		const gate = providerGate("anthropic");
		expect(gate.allowed).toBe(true);
		expect(gate.allowed && gate.evidence.dpa).toContain("DPA");
	});

	// Each on its own. A gate that only refuses when EVERYTHING is missing is a gate that passes the
	// realistic case — three of four in place and the awkward one outstanding.
	it("refuses when any single item is missing", () => {
		for (const name of [
			"ALETHIA_AI_ANTHROPIC_DPA",
			"ALETHIA_AI_ANTHROPIC_TRANSFER",
			"ALETHIA_AI_ANTHROPIC_RETENTION",
			"ALETHIA_AI_ANTHROPIC_NO_TRAINING",
		]) {
			withEvidence([name]);
			const gate = providerGate("anthropic");
			expect(gate.allowed).toBe(false);
			expect(gate.allowed === false && gate.missing).toHaveLength(1);
			// The refusal has to name the variable, or the operator cannot act on it.
			expect(gate.allowed === false && gate.message).toContain(name);
		}
	});

	it("refuses a provider with nothing configured, and lists all four", () => {
		vi.mocked(env).mockReturnValue(undefined);
		const gate = providerGate("openai");
		expect(gate.allowed).toBe(false);
		expect(gate.allowed === false && gate.missing).toHaveLength(4);
		// It says WHY, not just what — the reason is the thing that stops it being softened.
		expect(gate.allowed === false && gate.message).toMatch(/infrastructure and code/i);
	});

	// Whitespace is not evidence. An operator setting a variable to " " to get past the gate is the
	// exact bypass this would otherwise have.
	it("treats blank and whitespace-only evidence as missing", () => {
		vi.mocked(env).mockImplementation((name: string) =>
			name === "ALETHIA_AI_ANTHROPIC_DPA" ? "   " : "set",
		);
		const gate = providerGate("anthropic");
		expect(gate.allowed).toBe(false);
		expect(gate.allowed === false && gate.missing).toEqual(["dpa"]);
	});

	it("reads each provider's own variables, not another's", () => {
		withEvidence(); // anthropic only
		expect(providerGate("anthropic").allowed).toBe(true);
		expect(providerGate("openai").allowed).toBe(false);
		expect(providerEvidence("openai").dpa).toBeNull();
	});

	it("reports the record for every configured provider, allowed or not", () => {
		withEvidence();
		const record = transparencyRecord(["anthropic", "openai"]);
		expect(record).toHaveLength(2);
		expect(record[0].allowed).toBe(true);
		expect(record[1].allowed).toBe(false);
		expect(record[1].missing).toHaveLength(4);
	});
});

describe("the disclosure", () => {
	// "May produce inaccurate output" tells nobody anything. The limitations have to be specific
	// enough to change how much someone trusts a plan the assistant proposed.
	it("names concrete limitations, not a disclaimer", () => {
		expect(AI_SYSTEM_DISCLOSURE.limitations.length).toBeGreaterThan(2);
		for (const l of AI_SYSTEM_DISCLOSURE.limitations) {
			expect(l.length).toBeGreaterThan(40);
		}
		expect(AI_SYSTEM_DISCLOSURE.identification.toLowerCase()).toContain("not a person");
	});

	it("gives a route to a human and a route to report harm, and they are different", () => {
		expect(AI_SYSTEM_DISCLOSURE.humanContact).toContain("@");
		expect(AI_SYSTEM_DISCLOSURE.incidentPath).toContain("@");
		expect(AI_SYSTEM_DISCLOSURE.incidentPath).not.toBe(AI_SYSTEM_DISCLOSURE.humanContact);
	});

	// The claim that makes the classification defensible: it proposes, a human applies. If that ever
	// stops being true the classification has to be redone, which is why it is written down.
	it("states the autonomy limit the classification rests on", () => {
		expect(AI_SYSTEM_DISCLOSURE.autonomy).toMatch(/proposes/i);
		expect(AI_SYSTEM_CLASSIFICATION.highRisk).toBe(false);
		expect(AI_SYSTEM_CLASSIFICATION.highRiskBasis.length).toBeGreaterThan(60);
		expect(AI_SYSTEM_CLASSIFICATION.reassessIf).toMatch(/without human approval/i);
	});
});
