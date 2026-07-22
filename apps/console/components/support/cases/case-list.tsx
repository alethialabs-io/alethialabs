"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { listMyCases } from "@/app/server/actions/support";
import { ErrorState } from "@/components/errors/error-state";
import { qk } from "@/lib/query/keys";
import { CaseListItem } from "./case-list-item";

/** The status buckets surfaced as tabs; "all" maps to no server filter. */
const CASE_FILTERS = ["all", "active", "resolved"] as const;
type CaseFilter = (typeof CASE_FILTERS)[number];

/**
 * The support case list. Reads the server-prefetched/hydrated `listMyCases` cache and lets
 * the caller switch between All / Active / Resolved lifecycle buckets (each tab is its own
 * query key so switching is instant once cached). Renders one `CaseListItem` per row, or a
 * submit call-to-action when there are none. When `seeAll` (the caller holds manage_support),
 * the list is the whole org's cases — a caption says so and each foreign row shows its opener.
 */
export function CaseList({
	orgSlug,
	seeAll = false,
}: {
	orgSlug: string;
	seeAll?: boolean;
}) {
	const [filter, setFilter] = useState<CaseFilter>("all");

	const {
		data: cases = [],
		isPending,
		isError,
		refetch,
	} = useQuery({
		queryKey: qk.supportCases(filter),
		queryFn: () =>
			listMyCases(filter === "all" ? {} : { status: filter }),
	});

	return (
		<div className="space-y-4">
			{seeAll && (
				<p className="text-xs text-muted-foreground">
					Showing all support cases in this organization.
				</p>
			)}
			<Tabs
				value={filter}
				onValueChange={(v) => setFilter(coerceEnum(v, CASE_FILTERS, "all"))}
			>
				<TabsList>
					<TabsTrigger value="all">All</TabsTrigger>
					<TabsTrigger value="active">Active</TabsTrigger>
					<TabsTrigger value="resolved">Resolved</TabsTrigger>
				</TabsList>
			</Tabs>

			{isError ? (
				// A fetch failure must not render as "no cases yet".
				<ErrorState
					title="Couldn't load your cases"
					description="Something went wrong fetching your support cases. Check your connection and try again."
					actions={
						<Button variant="outline" size="sm" onClick={() => refetch()}>
							Retry
						</Button>
					}
				/>
			) : cases.length === 0 && !isPending ? (
				<Empty className="rounded-md border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<LifeBuoy />
						</EmptyMedia>
						<EmptyTitle>No cases yet</EmptyTitle>
						<EmptyDescription>
							When you open a support case it will appear here.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/support/submit`} />}>
							Submit a case
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<div className="overflow-hidden rounded-md border">
					{cases.map((item) => (
						<CaseListItem key={item.id} item={item} orgSlug={orgSlug} />
					))}
				</div>
			)}
		</div>
	);
}
