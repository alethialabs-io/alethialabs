// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The capability promise's POSITIVE CONTROLS.
//
// `helpers/capabilities.ts` says a leg that promises `stripe` has Stripe. This file is what makes
// that a measurement rather than a declaration: it drives the promise to the UI (the team persona's
// billing page must say the org is trialing — Stripe reached the page, not merely the env) and it
// drives the enforcement in-process (the CI branch must throw, the local branch must skip with a
// reason that says NOT MEASURED). A promise nothing checks is the `HAVE_MEMBER` shape again.

import { test, expect } from "../fixtures/qa";
import { assertEnvForPromises, PROMISE_VAR, promised, requireCapability } from "../helpers/capabilities";

test.describe("capabilities — the promise reaches the product", () => {
	test("stripe: the team persona's org is trialing on a real Stripe subscription", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(`/${team.orgSlug}/~/settings/billing`);
		await expect(team.page).not.toHaveURL(/\/login/);
		// The self-managed short-circuit is what an UNCONFIGURED console renders. Its presence here
		// means the promise was kept in the env and broken in the product.
		await expect(team.page.getByText(/self-managed deployment/i)).toHaveCount(0);
		await expect(team.page.getByText(/trialing/i).first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("capabilities — the enforcement fires in both directions", () => {
	test("an unpromised need is a failure in CI and a NOT MEASURED skip locally", () => {
		expect(() => requireCapability("stripe", { env: { CI: "1" }, skip: () => {} })).toThrow(/does not promise it/);
		let reason = "";
		expect(requireCapability("stripe", { env: {}, skip: (r) => (reason = r) })).toBe("skipped");
		expect(reason).toMatch(/^NOT MEASURED/);
		expect(requireCapability("stripe", { env: { [PROMISE_VAR]: "stripe" }, skip: () => {} })).toBe("promised");
	});

	test("a misspelt promise promises nothing — loudly", () => {
		expect(() => promised({ [PROMISE_VAR]: "stripe-test" })).toThrow(/not a capability/);
		expect(assertEnvForPromises({ [PROMISE_VAR]: "stripe" })).toHaveLength(4);
		expect(assertEnvForPromises({})).toEqual([]);
	});
});
