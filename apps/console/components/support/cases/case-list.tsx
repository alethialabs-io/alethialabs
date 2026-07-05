"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
import { qk } from "@/lib/query/keys";
import { CaseListItem } from "./case-list-item";

/** The status buckets surfaced as tabs; "all" maps to no server filter. */
type CaseFilter = "all" | "active" | "resolved";

/**
 * The "My cases" list. Reads the server-prefetched/hydrated `listMyCases` cache and lets
 * the caller switch between All / Active / Resolved lifecycle buckets (each tab is its own
 * query key so switching is instant once cached). Renders one `CaseListItem` per row, or a
 * submit call-to-action when there are none.
 */
export function CaseList({ orgSlug }: { orgSlug: string }) {
	const [filter, setFilter] = useState<CaseFilter>("all");

	const { data: cases = [], isPending } = useQuery({
		queryKey: qk.supportCases(filter),
		queryFn: () =>
			listMyCases(filter === "all" ? {} : { status: filter }),
	});

	return (
		<div className="space-y-4">
			<Tabs
				value={filter}
				onValueChange={(v) => setFilter(v as CaseFilter)}
			>
				<TabsList>
					<TabsTrigger value="all">All</TabsTrigger>
					<TabsTrigger value="active">Active</TabsTrigger>
					<TabsTrigger value="resolved">Resolved</TabsTrigger>
				</TabsList>
			</Tabs>

			{cases.length === 0 && !isPending ? (
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
						<Button asChild size="sm">
							<Link href={`/${orgSlug}/~/support/submit`}>Submit a case</Link>
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
