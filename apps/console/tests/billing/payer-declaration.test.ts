// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE OTHER HALF OF `eligibility-coverage.test.ts` (#4633).
//
// That test asks whether the gate is CALLED. It cannot ask whether the gate's input can be
// SATISFIED, and for six weeks it could not have been: `declarePayer` — the one writer of
// `organization_billing.payer_capacity` — had no caller anywhere in the repo, so every conversion
// reached `assertPaidConversionAllowed` with `capacity: null` and was refused
// `capacity_not_declared`. A gate nobody can pass looks exactly like a gate nobody has reached, and
// nothing in the suite could tell them apart.
//
// So this test asks the missing question from both ends:
//
//   · STRUCTURALLY — the declaration is collected somewhere a customer can reach, and each of the
//     three conversion paths that takes the payer facts as a PARAMETER is actually handed them.
//     Source text, for the same reason the coverage test is source text: a behavioural test proves
//     the sheets we know about wire it up and says nothing about the next sheet.
//   · BEHAVIOURALLY — the attestation rule holds in both directions at the writer, so the UI is not
//     the only thing enforcing it.
//
// WHAT THIS TEST DOES NOT SAY. It does not say a paid conversion now COMPLETES. `PAID_MARKETS` in
// packages/legal/src/commerce.ts is empty and deliberately so, which refuses every country ×
// capacity cell at the LAST of the gate's four checks. Declaring the payer moves the refusal from
// `capacity_not_declared` to `market_closed`; opening a cell is a compliance decision with four
// recorded conditions (docs/legal/PAID_MARKETS.md), not a code change, and `commerce.test.ts` pins
// the empty set on purpose. Read any green here as "the product can now ask, record and forward the
// declaration", never as "money can be taken".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
	authorizeInOrg: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { declarePayer, payerConversionStatus } from "@/app/server/actions/legal";

const CONSOLE = process.cwd();
const UPGRADE_SHEET = join(CONSOLE, "components/org/upgrade-org-sheet.tsx");
const CREATE_SHEET = join(CONSOLE, "components/org/create-org-sheet.tsx");
const DECLARATION_FORM = join(
	CONSOLE,
	"components/billing/payer-declaration-form.tsx",
);

function read(path: string): string {
	return readFileSync(path, "utf8");
}

// ── The declaration is collected, and forwarded ────────────────────────────────────────────

describe("the payer declaration is reachable from the product", () => {
	// If the files stop being readable, or stop being the purchase sheets, every scan below passes
	// trivially. That is the failure mode of a source-text test, so it is checked first.
	it("reads the two purchase sheets and the declaration form", () => {
		expect(read(UPGRADE_SHEET)).toContain("UpgradeOrgSheet");
		expect(read(CREATE_SHEET)).toContain("CreateOrgSheet");
		expect(read(DECLARATION_FORM)).toContain("PayerDeclarationForm");
	});

	it("collects the declaration in BOTH purchase sheets", () => {
		for (const [name, path] of [
			["upgrade-org-sheet", UPGRADE_SHEET],
			["create-org-sheet", CREATE_SHEET],
		] as const) {
			const src = read(path);
			if (!src.includes("<PayerDeclarationForm")) {
				throw new Error(
					`${name} does not render <PayerDeclarationForm>. The maintainer's ruling on #4633 is ` +
						`that the consumer-vs-organization declaration is a required choice in the two ` +
						`purchase sheets, made at the moment of purchase — a sheet that does not ask it ` +
						`reaches the eligibility gate with capacity: null and is refused.`,
				);
			}
			expect(src).toContain("<PayerDeclarationForm");
		}
	});

	it("gives `declarePayer` a caller — the defect this test exists for", () => {
		const callers = [UPGRADE_SHEET, CREATE_SHEET].filter((p) =>
			read(p).includes("declarePayer("),
		);
		if (callers.length === 0) {
			throw new Error(
				"`declarePayer` has no caller in either purchase sheet. It is the ONLY writer of " +
					"organization_billing.payer_capacity; with no caller, every paid conversion is refused " +
					"capacity_not_declared and nothing in the product can lift the refusal.",
			);
		}
		expect(callers.length).toBeGreaterThan(0);
	});

	// The create path has no organization yet, so there is no row for the gate to read — the facts
	// travel as a PARAMETER through three calls. Each takes `payer`; none passed it before #4633,
	// and the type system could not notice because every one of them is optional (it has to be:
	// the gate's inputs are optional, its verdict is not).
	it("passes `payer` to every conversion call that takes it", () => {
		const src = read(CREATE_SHEET);
		for (const call of [
			"createNewOrgSubscriptionIntent",
			"linkSubscriptionToNewOrg",
		]) {
			const at = src.indexOf(`${call}(`);
			if (at === -1) throw new Error(`${call} has disappeared from create-org-sheet.tsx`);
			// Every occurrence, not the first: the currency toggle re-creates the intent, and an
			// un-declared re-creation is refused exactly as the first one would have been.
			let index = at;
			while (index !== -1) {
				const body = src.slice(index, index + 600);
				if (!body.includes("payer:")) {
					throw new Error(
						`a call to ${call} in create-org-sheet.tsx does not pass \`payer:\`. Without it the ` +
							`eligibility gate sees capacity: null and refuses the sale.`,
					);
				}
				index = src.indexOf(`${call}(`, index + 1);
			}
			expect(src.slice(at, at + 600)).toContain("payer:");
		}
	});

	// The reason the upgrade sheet showed "Billing may not be configured on this deployment": it
	// opened the intent from a mount effect, before any form could have collected anything. The
	// intent must be downstream of the declaration, not of the sheet being visible.
	it("does not open the upgrade intent before the declaration exists", () => {
		const src = read(UPGRADE_SHEET);
		const at = src.indexOf("createSubscriptionIntent(");
		if (at === -1) throw new Error("createSubscriptionIntent has left upgrade-org-sheet.tsx");
		// The guard that stands between the effect and the call, within the same effect body.
		const preamble = src.slice(Math.max(0, at - 600), at);
		if (!preamble.includes("!declaration")) {
			throw new Error(
				"upgrade-org-sheet.tsx reaches createSubscriptionIntent without first checking that a " +
					"declaration exists. That is the mount-effect defect in #4633: the conversion is " +
					"attempted before the payer has been asked, and the refusal is then reported to the " +
					"customer as a deployment misconfiguration.",
			);
		}
		expect(preamble).toContain("!declaration");
	});

	// Nothing may pre-select a capacity. A default answers the one question the gate exists to stop
	// the product answering on the payer's behalf — and in the `organization` direction it would
	// strip a real consumer of rights they cannot waive.
	it("pre-selects no capacity", () => {
		const src = read(DECLARATION_FORM);
		expect(src).toContain("capacity: undefined");
		for (const preset of ['capacity: "consumer"', 'capacity: "organization"']) {
			if (src.includes(`defaultValues`) && src.includes(preset)) {
				const defaultsAt = src.indexOf("defaultValues");
				const presetAt = src.indexOf(preset);
				if (presetAt > defaultsAt && presetAt < defaultsAt + 240) {
					throw new Error(
						`the declaration form defaults the capacity to ${preset}. It must be chosen.`,
					);
				}
			}
		}
	});
});

// ── The attestation rule, at the writer ────────────────────────────────────────────────────

/**
 * A drizzle-shaped stub: every row lookup finds `rows`; updates and inserts are recorded.
 *
 * `rows` is one knob standing for two different reads, which is worth saying out loud because the
 * eligibility gate's FIRST check is the acceptance lookup: leave it empty and every verdict is
 * `terms_not_accepted`, and a test meaning to measure a later door would silently measure that one.
 */
function stubDb(rows: unknown[] = []) {
	const writes: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }> = [];
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows),
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				writes.push({ kind: "insert", values });
				return Promise.resolve(undefined);
			},
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				writes.push({ kind: "update", values });
				return { where: () => Promise.resolve(undefined) };
			},
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(
		chain as unknown as ReturnType<typeof getServiceDb>,
	);
	return writes;
}

beforeEach(() => {
	vi.mocked(currentActor).mockResolvedValue({ userId: "u-1", orgId: "org-1" });
	vi.mocked(authorize).mockResolvedValue({ userId: "u-1", orgId: "org-1" });
	vi.mocked(authorizeInOrg).mockResolvedValue({ userId: "u-1", orgId: "org-new" });
});
afterEach(() => vi.resetAllMocks());

describe("declarePayer records what the payer said, and refuses what they did not", () => {
	it("records an organization declaration with its attestation", async () => {
		const writes = stubDb();
		const out = await declarePayer({
			capacity: "organization",
			billingCountry: "bg",
			authorityAttestation: "Director",
		});
		expect(out).toEqual({ capacity: "organization", billingCountry: "BG" });
		expect(writes).toHaveLength(1);
		expect(writes[0].values).toMatchObject({
			organizationId: "org-1",
			payerCapacity: "organization",
			// Upper-cased on the way in, so the gate's country comparison is total.
			billingCountry: "BG",
			authorityAttestation: "Director",
		});
	});

	it("refuses an organization declaration with no attestation", async () => {
		stubDb();
		await expect(
			declarePayer({
				capacity: "organization",
				billingCountry: "BG",
				authorityAttestation: null,
			}),
		).rejects.toThrow(/bind this organization/i);
	});

	// The direction that used to pass. A consumer attestation was silently normalised to null,
	// which leaves a record saying something other than what was submitted — the one thing a file
	// of evidence must not do.
	it("refuses a consumer declaration that carries an attestation", async () => {
		const writes = stubDb();
		await expect(
			declarePayer({
				capacity: "consumer",
				billingCountry: "BG",
				authorityAttestation: "Director",
			}),
		).rejects.toThrow(/binds nobody but you/i);
		expect(writes).toEqual([]);
	});

	it("records a consumer declaration with no attestation", async () => {
		const writes = stubDb();
		await declarePayer({
			capacity: "consumer",
			billingCountry: "DE",
			authorityAttestation: null,
		});
		expect(writes[0].values).toMatchObject({
			payerCapacity: "consumer",
			billingCountry: "DE",
			authorityAttestation: null,
		});
	});

	// NAMED, not ambient (#4133). The create-org sheet declares for the org it has just created
	// while sitting on a page inside the OLD one, so an ambient write lands on the wrong org — and
	// both writes succeed, which is what makes it silent.
	it("writes to the NAMED organization when one is given", async () => {
		const writes = stubDb();
		await declarePayer(
			{ capacity: "consumer", billingCountry: "BG", authorityAttestation: null },
			{ orgId: "org-new" },
		);
		expect(vi.mocked(authorizeInOrg)).toHaveBeenCalledWith(
			"manage_billing",
			{ type: "billing" },
			"org-new",
		);
		expect(vi.mocked(authorize)).not.toHaveBeenCalled();
		expect(writes[0].values).toMatchObject({ organizationId: "org-new" });
	});
});

describe("payerConversionStatus answers instead of throwing", () => {
	// The whole reason it exists: a refusal thrown across the server-action boundary arrives with
	// its class gone and its message redacted, so the sheet could only show a generic sentence.
	it("returns the gate's reason for a refusal", async () => {
		// A row for every lookup, so the acceptance check — the gate's FIRST door — is satisfied and
		// the verdict below is about the market rather than about the terms.
		stubDb([{ id: "accepted-1" }]);
		const verdict = await payerConversionStatus({
			capacity: "consumer",
			billingCountry: "BG",
			authorityAttestation: null,
		});
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) throw new Error("expected a refusal while PAID_MARKETS is empty");
		// Not `capacity_not_declared`: the declaration is supplied here, and this is the measurement
		// that says which door is now the closed one.
		expect(verdict.reason).toBe("market_closed");
		expect(verdict.message).toMatch(/not yet able to sell/i);
	});

	it("refuses a declaration whose attestation contradicts its capacity", async () => {
		stubDb([{ id: "accepted-1" }]);
		await expect(
			payerConversionStatus({
				capacity: "consumer",
				billingCountry: "BG",
				authorityAttestation: "Director",
			}),
		).rejects.toThrow(/binds nobody but you/i);
	});
});
