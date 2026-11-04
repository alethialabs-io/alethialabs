// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hook tests for `useLivePlanPrice` — the client hook that resolves a module-cached price map and
// writes it into state from inside `.then()` — and for `aiPriceView`, the pure function the AI
// section prices its tier with since #6127 moved the AI price list onto the read router
// (`billing.liveAiPrices`, prefetched with the page). The `useLiveAiPrice` hook and its module
// cache were deleted with it; the tier-change race its last test pinned cannot recur, because the
// view is computed from the WHOLE map (`map[tier]`) on every render, not a per-tier row in state.
//
// WHY THIS FILE EXISTS, beyond "the module had no test" (#3342).
//
// `apps/console/lib/billing` has twice measured ONE statement fewer than its zero-slack floor on
// PRs that contained no TypeScript at all, dequeuing an unrelated PR from the merge queue each
// time. A stable total with a moving covered count is a statement that executes on some runs and
// not others, and the shape both hooks have is exactly that:
//
//     loadPrices().then((m) => { if (active) setData(m[plan]); })
//
// Nothing awaits that resolution. `if (active)` is entered whenever the microtask runs, but
// `setData(m[plan])` — one statement — executes only when the component is still mounted at that
// moment. Before this file, the ONLY things that reached either hook were component tests
// (`usage-panel.test.tsx` through `ai-usage-section`) that assert on other text entirely and never
// wait for a price to arrive; there, whether that statement runs is decided by whether React has
// re-run the effect with a new `tier` (the summary loads and flips `ai_free` -> `ai_plus`, which
// sets `active = false` on the first effect) before the already-resolved promise flushes.
//
// So every assertion below that reads `loading === false` is load-bearing: `loading` is
// `data === null`, so it CANNOT be false unless `setData` actually ran. That turns a statement
// that was covered by a race into one covered by an assertion, on every run.
//
// This is not a claim that this statement is THE one behind the two observed dequeues — that was
// never measured, and #3587's five-run probe could not reproduce the flap. It is the one candidate
// in the directory that could be removed rather than re-measured.
//
// The tests run in order on purpose. The module-level `pending` cache is shared by
// every test in this file (Vitest isolates modules per FILE, not per test), so the failure case has
// to come first: it is the only state from which the retry-after-failure reset is observable, and
// the cache-sharing assertions that follow it need a cache that is already warm.

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { money } from "@repo/format";
import { aiPlanMeta, planMeta } from "@repo/plan-catalog";
import type { LiveAiPriceMap, LivePlanPriceMap } from "@/lib/billing/pricing";

vi.mock("@/app/server/actions/billing", () => ({
	getLivePlanPrices: vi.fn(),
}));

import { getLivePlanPrices } from "@/app/server/actions/billing";
import { aiPriceView, useLivePlanPrice } from "@/lib/billing/use-live-plan-price";

// Deliberately NOT the catalog amounts — the hook must render what Stripe returned, and a fixture
// that happened to match the fallback could not tell the two apart.
const planPrices: LivePlanPriceMap = {
	community: {
		amounts: { usd: money(0, "usd"), eur: money(0, "eur") },
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
	team: {
		amounts: { usd: money(2500, "usd"), eur: money(2200, "eur") },
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
	enterprise: {
		// No key at all, which is how `LivePriceAmounts` says "custom / Let's talk" — the old
		// `unitAmountUsd: null` pair could not distinguish that from "zero".
		amounts: {},
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
};

const aiPrices: LiveAiPriceMap = {
	ai_free: {
		amounts: { usd: money(0, "usd"), eur: money(0, "eur") },
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
	ai_plus: {
		amounts: { usd: money(2500, "usd"), eur: money(2200, "eur") },
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
	// 88, not the catalog's 90. `aiPlanMeta("ai_max")` is 100/90, so a fixture that matched it
	// would satisfy the EUR assertion below whether or not the hook ever read Stripe's EUR amount
	// — inverting the currency branch to prefer the catalog would have left this suite green.
	// `community`, `enterprise` and `ai_free` still match their catalog rows because their amounts
	// are 0 or null and there is nothing else to be; `team`, `ai_plus` and now `ai_max` are what
	// discriminate.
	ai_max: {
		amounts: { usd: money(10000, "usd"), eur: money(8800, "eur") },
		currency: "usd",
		interval: "month",
		label: "ignored — the hook re-derives the label",
	},
};

describe("useLivePlanPrice", () => {
	it("shows the catalog price while the live map has not arrived", async () => {
		vi.mocked(getLivePlanPrices).mockRejectedValueOnce(new Error("stripe down"));

		const { result } = renderHook(() => useLivePlanPrice("team"));
		await waitFor(() => expect(getLivePlanPrices).toHaveBeenCalledTimes(1));

		// Nothing was written, so the catalog value is the whole answer and `loading` stays true.
		expect(result.current.loading).toBe(true);
		expect(result.current.label).toBe(planMeta("team").priceLabel);
		expect(result.current.unitAmount).toEqual(
			money(planMeta("team").priceMonthly?.usd ?? -1, "usd"),
		);
		expect(result.current.currency).toBe("usd");
	});

	it("writes the resolved price into state, and a failed fetch did not poison the cache", async () => {
		vi.mocked(getLivePlanPrices).mockResolvedValue(planPrices);

		// A DELTA, not a total. The mock is never cleared between tests (no `clearMocks` in
		// vitest.config.ts or tests/setup.ts), so an absolute count asserts "what every earlier
		// test did, plus this" — which makes this test unrunnable under `-t` or a temporary
		// `it.only`, and makes inserting a case above it fail here with a message pointing at the
		// cache claim rather than at the edit. The property being asserted is this mount's own
		// fetch, so that is what is measured.
		const before = vi.mocked(getLivePlanPrices).mock.calls.length;
		const { result } = renderHook(() => useLivePlanPrice("team"));
		// `loading` is `data === null`. It can only go false by way of `setData(m[plan])` — the
		// statement that is otherwise executed or skipped depending on unmount timing.
		await waitFor(() => expect(result.current.loading).toBe(false));

		expect(result.current.label).toBe("$25 / seat / mo");
		expect(result.current.unitAmount).toEqual(money(2500, "usd"));
		// ONE MORE call proves the previous test's rejection reset the module cache — had `pending`
		// stayed as the rejected promise, this mount would have re-subscribed to it and never
		// resolved. That reset (`pending = null; throw e`) has no other observable.
		expect(vi.mocked(getLivePlanPrices).mock.calls.length).toBe(before + 1);
	});

	it("serves every later consumer from one fetch, in either currency", async () => {
		const before = vi.mocked(getLivePlanPrices).mock.calls.length;
		const eur = renderHook(() => useLivePlanPrice("team", "eur"));
		await waitFor(() => expect(eur.result.current.loading).toBe(false));
		expect(eur.result.current.label).toBe("€22 / seat / mo");
		expect(eur.result.current.currency).toBe("eur");

		// Not per-seat: a flat "<amount> / <interval>" label rather than the per-seat one.
		const flat = renderHook(() => useLivePlanPrice("community"));
		await waitFor(() => expect(flat.result.current.loading).toBe(false));
		expect(flat.result.current.label).toBe("$0 / mo");

		// Custom-priced: a live row with no amount falls back to the catalog's own label.
		const custom = renderHook(() => useLivePlanPrice("enterprise"));
		await waitFor(() => expect(custom.result.current.loading).toBe(false));
		expect(custom.result.current.unitAmount).toBeNull();
		expect(custom.result.current.label).toBe(planMeta("enterprise").priceLabel);

		// ZERO further fetches across three more mounts — the map is fetched once and shared, which
		// is the point of the module cache.
		expect(vi.mocked(getLivePlanPrices).mock.calls.length).toBe(before);
	});
});

describe("aiPriceView", () => {
	it("shows the AI catalog price, and says it is not authoritative, while there is no live row", () => {
		const view = aiPriceView("ai_plus", undefined);
		expect(view.loading).toBe(true);
		expect(view.label).toBe(aiPlanMeta("ai_plus").priceLabel);
	});

	it("renders the live amount when the row is there", () => {
		const view = aiPriceView("ai_plus", aiPrices.ai_plus);
		expect(view.loading).toBe(false);
		expect(view.label).toBe("$25 / mo");
		expect(view.unitAmount).toEqual(money(2500, "usd"));
	});

	it("prices in the asked currency from Stripe's own amount, not the catalog's", () => {
		expect(aiPriceView("ai_max", aiPrices.ai_max, "eur").label).toBe("€88 / mo");
	});

	it("keeps 'Free' free: a live amount of 0 keeps the catalog word, never '$0 / mo'", () => {
		const view = aiPriceView("ai_free", aiPrices.ai_free);
		expect(view.unitAmount).toEqual(money(0, "usd"));
		expect(view.label).toBe(aiPlanMeta("ai_free").priceLabel);
	});
});
