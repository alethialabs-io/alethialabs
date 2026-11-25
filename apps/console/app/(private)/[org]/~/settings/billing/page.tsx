// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { WithdrawalSection } from "@/components/billing/withdrawal-section";
import { BillingPanel } from "@/components/settings/billing/billing-panel";
import { RECENT_INVOICES_INPUT } from "@/components/settings/billing/invoices-filters";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Billing · Settings",
	description: "Plan, payment methods, transactions, and invoices.",
});

/**
 * Billing & subscription: current plan (with the AI tier as one row — the AI card, its meters and
 * spend limits live on the Usage page, #6133), payment methods, plan history, transactions,
 * invoices (#6127, ADR 0005 D1).
 *
 * Prefetches EXACTLY the reads the panel makes on first paint, in-process through the read router,
 * and hands the dehydrated cache to the client — the page used to render `<BillingPanel />` bare
 * and fetch all six reads from the browser in `useEffect`. The summary goes first because it
 * decides which sections exist: a self-managed instance or a person with no organization renders
 * one card; a member without the billing permission never reads the billing-admin sections (they
 * would only be refused); and cards, charges and invoices exist only once a Stripe customer does.
 * A failed prefetch is not dehydrated; that section then reads in the browser and renders its own
 * error or refusal. `loading.tsx` covers the prefetch window.
 *
 * The consumer withdrawal section (#7221) follows the panel for a hosted org's billing admin — the
 * only viewer `getWithdrawalRight` answers — and renders nothing unless the org's order was a
 * consumer purchase.
 */
export default async function BillingPage() {
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const summary = await queryClient
		.fetchQuery(rpc.billing.summary.queryOptions())
		.catch(() => null);
	if (summary?.hosted && summary.hasOrg) {
		const admin = summary.canManageBilling;
		const customer = admin && summary.canManage;
		await Promise.all([
			queryClient.prefetchQuery(rpc.usage.ai.queryOptions()),
			admin ? queryClient.prefetchQuery(rpc.billing.planHistory.queryOptions()) : null,
			customer ? queryClient.prefetchQuery(rpc.billing.paymentMethods.queryOptions()) : null,
			// The ledger's FIRST page, under the infinite key `useKeysetList` reads (#7493).
			customer
				? queryClient.prefetchInfiniteQuery(
						rpc.billing.transactions.infiniteOptions({
							input: (cursor: string | null) => (cursor === null ? {} : { cursor }),
							initialPageParam: null,
							getNextPageParam: (last) => last.nextCursor,
						}),
					)
				: null,
			customer
				? queryClient.prefetchQuery(
						rpc.billing.invoices.queryOptions({ input: RECENT_INVOICES_INPUT }),
					)
				: null,
		]);
	}

	const showWithdrawal = Boolean(summary?.hosted && summary.hasOrg && summary.canManageBilling);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<BillingPanel />
			{showWithdrawal ? <WithdrawalSection /> : null}
		</HydrationBoundary>
	);
}
