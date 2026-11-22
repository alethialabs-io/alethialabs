// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `finishOnboarding` (WIZ-W6, #6929): the one server call behind the onboarding form.
//
// What is pinned here, each a property the old four-call form did not have:
//   - the server decides where setup stands FIRST: a finished setup, or a live plan with only the
//     completion write missing, starts nothing (no second trial from a second tab or from Back);
//   - every refusal is a VALUE through the mutation contract, under the field it is about;
//   - nothing is written before the checks that write nothing (the terms box, the payer facts);
//   - on Pro, the payer facts are declared on the org BEFORE the trial starts, so the purchase gate
//     the trial runs (#7107) reads them; the trial and the declaration NAME the org;
//   - a refused trial leaves setup NOT complete and shows the gate's own sentence;
//   - completion is the LAST write.

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const { GateRefusal } = vi.hoisted(() => ({
	GateRefusal: class GateRefusal extends Error {
		readonly reason = "market_closed";
	},
}));

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
vi.mock("@/lib/auth/onboarding", () => ({
	getPrimaryOrg: vi.fn(),
	completeOnboarding: vi.fn(),
	resolveOnboarding: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/observability/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/app/server/actions/billing", () => ({ startProTrial: vi.fn() }));
vi.mock("@/app/server/actions/legal", () => ({ acceptLegalDocuments: vi.fn(), declarePayer: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
vi.mock("@/lib/billing/eligibility", () => ({
	hasAcceptedCurrentDocuments: vi.fn(),
	PaidConversionNotAllowedError: GateRefusal,
}));

import { startProTrial } from "@/app/server/actions/billing";
import { acceptLegalDocuments, declarePayer } from "@/app/server/actions/legal";
import { finishOnboarding, type FinishOnboardingInput } from "@/app/server/actions/onboarding";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { ACCEPTED_DOCUMENTS } from "@/components/legal/terms-acceptance-copy";
import { completeOnboarding, getPrimaryOrg, resolveOnboarding } from "@/lib/auth/onboarding";
import { getOwner } from "@/lib/auth/owner";
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";
import { getServiceDb } from "@/lib/db";

const ORG = { id: "org-1", name: "Acme's Org", slug: "acme", logo: null, role: "owner" };

/** The documents the box shows today, at their current versions. */
const SHOWN = ACCEPTED_DOCUMENTS.map((d) => ({ id: d.id, version: d.version }));

/** A drizzle-ish chain: the slug-collision read answers `taken`, and writes record themselves. */
function mockDb(taken: unknown[] = []) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: () => {
			calls.push("rename");
			return db;
		},
		set: () => db,
		then: (resolve: (v: unknown) => void) => resolve(taken),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** A Hobby submission with the terms box ticked. */
function hobby(overrides: Partial<FinishOnboardingInput> = {}): FinishOnboardingInput {
	return {
		name: "Acme Cloud",
		slug: "acme-cloud",
		plan: "community",
		acceptedDocuments: SHOWN,
		clientTimestamp: "2026-11-22T10:00:00.000Z",
		payer: null,
		...overrides,
	};
}

/** A Pro-trial submission from a business payer in Germany. */
function pro(overrides: Partial<FinishOnboardingInput> = {}): FinishOnboardingInput {
	return hobby({
		plan: "team",
		payer: { capacity: "organization", billingCountry: "de", authorityAttestation: "Founder" },
		...overrides,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	calls.length = 0;
	vi.mocked(getOwner).mockResolvedValue("user-1");
	vi.mocked(getPrimaryOrg).mockResolvedValue(ORG);
	vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "not-started", org: ORG });
	vi.mocked(hasAcceptedCurrentDocuments).mockResolvedValue(false);
	vi.mocked(acceptLegalDocuments).mockImplementation(async () => {
		calls.push("accept");
		return { accepted: 1 };
	});
	vi.mocked(declarePayer).mockImplementation(async (input) => {
		calls.push("declare");
		return { capacity: input.capacity, billingCountry: input.billingCountry };
	});
	vi.mocked(startProTrial).mockImplementation(async () => {
		calls.push("trial");
	});
	vi.mocked(setActiveOrganization).mockImplementation(async () => {
		calls.push("scope");
		return { ok: true };
	});
	vi.mocked(completeOnboarding).mockImplementation(async () => {
		calls.push("complete");
	});
	mockDb();
});

describe("finishOnboarding — the server decides first", () => {
	it("starts nothing for a setup that is already complete", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "complete" });

		expect(await finishOnboarding(pro())).toEqual({ ok: true, data: { slug: "acme" } });
		expect(calls).toEqual([]);
	});

	it("finishes a setup whose trial already started, and starts no second one", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "settled", org: ORG });

		expect(await finishOnboarding(pro())).toEqual({ ok: true, data: { slug: "acme" } });
		expect(calls).toEqual(["complete"]);
	});

	it("refuses while a payment is unconfirmed, writing nothing", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "in-flight", org: ORG });

		const result = await finishOnboarding(pro());
		expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
		expect(calls).toEqual([]);
	});

	it("never reads an unreadable state as not started", async () => {
		vi.mocked(resolveOnboarding).mockResolvedValue({ kind: "unknown" });

		expect(await finishOnboarding(pro())).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		expect(calls).toEqual([]);
	});

	it("is unauthenticated with no session", async () => {
		vi.mocked(getOwner).mockResolvedValue(null);

		expect(await finishOnboarding(hobby())).toEqual({ ok: false, error: { kind: "unauthenticated" } });
	});
});

describe("finishOnboarding — Hobby", () => {
	it("names the org, records the acceptance, scopes the session, then completes — and starts no trial", async () => {
		expect(await finishOnboarding(hobby())).toEqual({ ok: true, data: { slug: "acme-cloud" } });
		expect(calls).toEqual(["rename", "accept", "scope", "complete"]);
		expect(startProTrial).not.toHaveBeenCalled();
		expect(declarePayer).not.toHaveBeenCalled();
		expect(acceptLegalDocuments).toHaveBeenCalledWith({
			documentIds: ACCEPTED_DOCUMENTS.map((d) => d.id),
			locale: "en",
			clientTimestamp: "2026-11-22T10:00:00.000Z",
		});
		expect(setActiveOrganization).toHaveBeenCalledWith("org-1");
	});

	it("records no acceptance when the current terms are already accepted", async () => {
		vi.mocked(hasAcceptedCurrentDocuments).mockResolvedValue(true);

		await finishOnboarding(hobby({ acceptedDocuments: [] }));
		expect(calls).toEqual(["rename", "scope", "complete"]);
	});
});

describe("finishOnboarding — the terms box", () => {
	it("refuses an unticked box under its field, before anything is written", async () => {
		const result = await finishOnboarding(hobby({ acceptedDocuments: [] }));

		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { acceptTerms: [expect.stringMatching(/Tick the box/)] } },
		});
		expect(calls).toEqual([]);
	});

	it("refuses an acceptance of a version the page did not show", async () => {
		const stale = SHOWN.map((d) => ({ ...d, version: "1999-01-01" }));
		const result = await finishOnboarding(hobby({ acceptedDocuments: stale }));

		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { acceptTerms: [expect.stringMatching(/changed/)] } },
		});
		expect(calls).toEqual([]);
	});
});

describe("finishOnboarding — the org's name and slug (A-23)", () => {
	it("puts a taken slug under the slug field", async () => {
		mockDb([{ id: "someone-else" }]);

		const result = await finishOnboarding(hobby());
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { slug: [expect.stringMatching(/taken/)] } },
		});
		expect(calls).toEqual([]);
	});

	it("puts a short name under the name field", async () => {
		const result = await finishOnboarding(hobby({ name: "A" }));
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { name: [expect.stringMatching(/name/)] } },
		});
	});
});

describe("finishOnboarding — the Pro trial behind the purchase gate", () => {
	it("declares the payer on the org, then starts the trial on it, then completes", async () => {
		expect(await finishOnboarding(pro())).toEqual({ ok: true, data: { slug: "acme-cloud" } });
		expect(calls).toEqual(["rename", "accept", "scope", "declare", "trial", "complete"]);
		expect(declarePayer).toHaveBeenCalledWith(
			{ capacity: "organization", billingCountry: "DE", authorityAttestation: "Founder" },
			{ orgId: "org-1" },
		);
		expect(startProTrial).toHaveBeenCalledWith({ orgId: "org-1" });
	});

	it("declares a consumer with no attestation, whatever the browser sent", async () => {
		await finishOnboarding(
			pro({ payer: { capacity: "consumer", billingCountry: "FR", authorityAttestation: "CEO" } }),
		);
		expect(declarePayer).toHaveBeenCalledWith(
			{ capacity: "consumer", billingCountry: "FR", authorityAttestation: null },
			{ orgId: "org-1" },
		);
	});

	it("refuses a business purchase with no role, under the role field, before anything is written", async () => {
		const result = await finishOnboarding(
			pro({ payer: { capacity: "organization", billingCountry: "DE", authorityAttestation: null } }),
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "validation", fields: { role: [expect.any(String)] } } });
		expect(calls).toEqual([]);
	});

	it("refuses a trial with no payer facts, under the country field", async () => {
		const result = await finishOnboarding(pro({ payer: null }));
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { billingCountry: [expect.any(String)] } },
		});
		expect(calls).toEqual([]);
	});

	it("shows the gate's own refusal and leaves setup NOT complete", async () => {
		const sentence = "Alethia is not yet able to sell to customers in this country in this capacity.";
		vi.mocked(startProTrial).mockRejectedValue(new GateRefusal(sentence));

		const result = await finishOnboarding(pro());
		expect(result).toEqual({ ok: false, error: { kind: "conflict", message: sentence } });
		expect(completeOnboarding).not.toHaveBeenCalled();
	});

	it("says the org is saved when the trial fails for any other reason, with a reference", async () => {
		vi.mocked(startProTrial).mockRejectedValue(new Error("stripe: connection reset"));

		const result = await finishOnboarding(pro());
		expect(result).toMatchObject({ ok: false, error: { kind: "conflict" } });
		const message = result.ok ? "" : "message" in result.error ? result.error.message : "";
		expect(message).toMatch(/organization is saved/);
		expect(message).toMatch(/Reference: [0-9a-f]{8}/);
		expect(message).not.toMatch(/stripe/);
		expect(completeOnboarding).not.toHaveBeenCalled();
	});
});
