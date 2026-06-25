"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org root — a Vercel-projects-style grid of the org's zones. Each card opens the zone
// (whose detail view lists its specs); the topbar zone picker handles quick-switching once
// inside. This replaced the old stats dashboard when the sidebar zone tree was removed.

import { Boxes, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ZoneWithSpecs } from "@/app/server/actions/zones";
import { ProviderIcon } from "@/components/provider-icon";
import { SidebarZoneActions } from "@/components/sidebar-zone-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { globalHref, zoneHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useZonesStore } from "@/lib/stores/use-zones-store";

export default function OrgOverviewPage() {
	const orgSlug = useActiveOrgSlug();
	const { zones, isLoading, fetchZones } = useZonesStore();
	const [query, setQuery] = useState("");

	useEffect(() => {
		fetchZones();
	}, [fetchZones]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return zones;
		return zones.filter((z) => z.name.toLowerCase().includes(q));
	}, [zones, query]);

	return (
		<div className="mx-auto w-full max-w-5xl space-y-6">
			{/* Header */}
			<div className="flex items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Zones
					</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Infrastructure workspaces in this organization.
					</p>
				</div>
				<Link href={globalHref(orgSlug, "design-spec")}>
					<Button size="sm" className="h-8 gap-1.5 text-xs">
						<Plus className="h-3.5 w-3.5" />
						Create a Spec
					</Button>
				</Link>
			</div>

			{/* Toolbar */}
			{zones.length > 0 && (
				<div className="relative max-w-sm">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search zones…"
						className="h-9 pl-9"
					/>
				</div>
			)}

			{/* Content */}
			{isLoading && zones.length === 0 ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-32 w-full rounded-lg" />
					))}
				</div>
			) : zones.length === 0 ? (
				<EmptyState orgSlug={orgSlug} />
			) : filtered.length === 0 ? (
				<p className="py-10 text-center text-sm text-muted-foreground">
					No zones match &ldquo;{query}&rdquo;.
				</p>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{filtered.map((zone) => (
						<ZoneCard key={zone.id} zone={zone} orgSlug={orgSlug} />
					))}
				</div>
			)}
		</div>
	);
}

/** A single clickable zone card with an overlaid link and a corner actions menu. */
function ZoneCard({ zone, orgSlug }: { zone: ZoneWithSpecs; orgSlug: string }) {
	const specs = zone.specs ?? [];
	const activeCount = specs.filter((s) => s.status === "ACTIVE").length;
	const providers = Array.from(
		new Set(
			specs
				.map((s) => s.cloud_provider)
				.filter((p): p is string => p != null),
		),
	);
	const href = zone.slug
		? zoneHref(orgSlug, zone.slug)
		: `/dashboard/zones/${zone.id}`;

	return (
		<div className="group/zone relative rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-muted/20">
			{/* Full-card click target (sits behind the content + menu). */}
			<Link
				href={href}
				aria-label={`Open ${zone.name}`}
				className="absolute inset-0 z-0 rounded-lg"
			/>

			<div className="pointer-events-none relative z-10 flex flex-col gap-3">
				<div className="flex items-center gap-2.5">
					<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
						<Boxes className="h-4 w-4" />
					</span>
					<span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
						{zone.name}
					</span>
				</div>

				<div className="flex h-5 items-center gap-1.5">
					{providers.length > 0 ? (
						providers.map((p) => (
							<ProviderIcon
								key={p}
								provider={p}
								size={16}
								className="opacity-70 grayscale"
							/>
						))
					) : (
						<span className="font-mono text-[11px] text-muted-foreground/70">
							Empty zone
						</span>
					)}
				</div>

				<div className="flex items-center justify-between border-t pt-3 font-mono text-[11px] text-muted-foreground">
					<span>
						{specs.length} spec{specs.length === 1 ? "" : "s"}
					</span>
					<span className="flex items-center gap-1.5">
						<span
							className={
								activeCount > 0
									? "h-1.5 w-1.5 rounded-full bg-foreground"
									: "h-1.5 w-1.5 rounded-full border border-border"
							}
						/>
						{activeCount} active
					</span>
				</div>
			</div>

			{/* Corner actions — above the link so its dropdown is clickable. */}
			<div className="absolute right-3 top-3 z-20">
				<SidebarZoneActions
					zoneId={zone.id}
					zoneName={zone.name}
					specCount={specs.length}
				/>
			</div>
		</div>
	);
}

/** First-run state when the org has no zones at all. */
function EmptyState({ orgSlug }: { orgSlug: string }) {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
			<div className="mb-4 rounded-full bg-muted/50 p-3">
				<Boxes className="h-7 w-7 text-muted-foreground" />
			</div>
			<h3 className="mb-1 text-sm font-medium text-foreground">No zones yet</h3>
			<p className="mb-4 max-w-sm text-xs text-muted-foreground">
				Create your first spec to provision infrastructure — it lands in a zone you
				can manage here.
			</p>
			<Link href={globalHref(orgSlug, "design-spec")}>
				<Button size="sm" className="h-8 gap-1.5 text-xs">
					<Plus className="h-3.5 w-3.5" />
					Create a Spec
				</Button>
			</Link>
		</div>
	);
}
