// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import Link from "next/link";
import {
	DEFAULT_INVOICE_FILTERS,
	normalizeInvoiceQuery,
} from "@/components/settings/billing/invoices-filters";
import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Invoices · Billing",
	description: "Your organization's invoice history and downloadable receipts.",
});

/**
 * Invoices — the dedicated, filterable history of the org's paid invoices (#6127, ADR 0005 D1).
 *
 * Prefetches the two keys the panel reads on first paint, in-process through the read router: the
 * UNFILTERED universe (the facet counts, and the rows before the URL's filters are read into the
 * store) and the URL's FILTERED view — built by the same codec and the same normaliser the panel
 * uses, so both keys are the browser's. `loading.tsx` covers the prefetch window.
 */
export default async function InvoicesPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const filtered = normalizeInvoiceQuery(
		filterStateFromUrl(paramReader(await searchParams), DEFAULT_INVOICE_FILTERS),
	);
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.billing.invoices.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.billing.invoices.queryOptions({ input: filtered })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<div>
				<Link
					href="../"
					className="mb-4 inline-flex items-center font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
				>
					← Billing
				</Link>
				<InvoicesPanel />
			</div>
		</HydrationBoundary>
	);
}
