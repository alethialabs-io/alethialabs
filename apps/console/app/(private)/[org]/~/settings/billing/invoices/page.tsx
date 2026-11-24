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
import { globalHref } from "@/lib/routing";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import type { InvoiceListParams } from "@/lib/rpc/inputs/invoices";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Invoices · Billing",
	description: "Your organization's invoice history and downloadable receipts.",
});

/**
 * Invoices — the dedicated, filterable history of the org's paid invoices (#6127, ADR 0005 D1).
 *
 * Prefetches the first PAGE of the two walks the panel reads on first paint, in-process through the
 * read router, under the same infinite keys `useKeysetList` builds (#7493): the unfiltered walk (the
 * rows before the URL's filters are read into the store) and the URL's FILTERED walk — built by the
 * same codec and the same normaliser the panel uses, so both keys are the browser's. Each first
 * page carries the status facets. `loading.tsx` covers the prefetch window.
 */
export default async function InvoicesPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org } = await params;
	const filtered = normalizeInvoiceQuery(
		filterStateFromUrl(paramReader(await searchParams), DEFAULT_INVOICE_FILTERS),
	);
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	/** The first page of one filter's walk, under the infinite key `useKeysetList` reads. */
	const firstPage = (filter: InvoiceListParams) =>
		queryClient.prefetchInfiniteQuery(
			rpc.billing.invoices.infiniteOptions({
				input: (cursor: string | null) => (cursor === null ? filter : { ...filter, cursor }),
				initialPageParam: null,
				getNextPageParam: (last) => last.nextCursor,
			}),
		);
	await Promise.all([firstPage({}), firstPage(filtered)]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<div>
				{/* The org's Billing page by name, not `../`: from `…/settings/billing/invoices` (no
				    trailing slash) a relative `../` resolves to `…/settings/`, which redirects to General
				    (CON-L3, R6 F-02). */}
				<Link
					href={globalHref(org, "settings/billing")}
					className="mb-4 inline-flex items-center font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
				>
					← Billing
				</Link>
				<InvoicesPanel />
			</div>
		</HydrationBoundary>
	);
}
