"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ChevronDown, ChevronsUpDown, Component, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useZonesStore } from "@/lib/stores/use-zones-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref, specHref } from "@/lib/routing";

/**
 * Header spec (app) switcher — the third Vercel combobox, between zone and env. Lists
 * the current zone's specs (from the zones store, which already nests them with slugs)
 * and navigates to `/{org}/{zone}/{spec}`. Only renders on a zone drilldown route
 * (`/{org}/{zone}[/…]`, never the legacy `/dashboard` tree or the `~` global tree);
 * hidden when the zone has no specs.
 */
export function SpecSwitcher({
	variant = "header",
}: { variant?: "header" | "topbar" } = {}) {
	const router = useRouter();
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const [open, setOpen] = useState(false);
	const { zones, fetchZones } = useZonesStore();

	useEffect(() => {
		fetchZones();
	}, [fetchZones]);

	// Parse `/{org}/{zone}/{spec}[/…]` — never `/dashboard/*` or the `~` global tree.
	const segs = pathname.split("/").filter(Boolean);
	const isDrilldown =
		segs[0] !== "dashboard" && segs[1] !== "~" && segs.length >= 2;
	const [org, zoneSlug, specSlug] = segs;

	const zone = zones.find((z) => z.slug === zoneSlug) ?? null;
	const specs = zone?.specs ?? [];

	if (!isDrilldown || specs.length === 0) return null;

	const active = specs.find((s) => s.slug === specSlug) ?? null;

	const handleSelect = (slug: string | null, id: string) => {
		setOpen(false);
		router.push(
			slug && zone?.slug
				? specHref(org, zone.slug, slug)
				: `/dashboard/zones/${zone?.id}/specs/${id}`,
		);
	};

	const startCreate = () => {
		setOpen(false);
		router.push(globalHref(orgSlug, "design-spec"));
	};

	return (
		<>
			<span className="text-border/70 select-none" aria-hidden>
				/
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					{variant === "topbar" ? (
						<Button
							variant="ghost"
							role="combobox"
							aria-expanded={open}
							className="h-auto gap-2 px-2 py-1.5"
						>
							<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-muted-foreground">
								<Component className="h-3 w-3" />
							</span>
							<span className="flex flex-col items-start leading-tight">
								<span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">
									Spec
								</span>
								<span className="max-w-[10rem] truncate text-[13px] font-medium text-foreground">
									{active?.project_name ?? "Select a spec"}
								</span>
							</span>
							<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						</Button>
					) : (
						<Button
							variant="ghost"
							size="sm"
							role="combobox"
							aria-expanded={open}
							className="gap-2 px-2 text-sm font-medium"
						>
							<Component className="h-4 w-4 text-muted-foreground" />
							<span className="max-w-[12rem] truncate">
								{active?.project_name ?? "Select a spec"}
							</span>
							<ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
						</Button>
					)}
				</PopoverTrigger>
				<PopoverContent className="w-72 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find spec…" className="h-9" />
						<CommandList>
							<CommandEmpty>No spec found.</CommandEmpty>
							<CommandGroup heading="Specs">
								{specs.map((s) => (
									<CommandItem
										key={s.id}
										value={s.project_name}
										onSelect={() => handleSelect(s.slug, s.id)}
										className="gap-2"
									>
										<Component className="h-4 w-4 text-muted-foreground" />
										<span className="flex-1 truncate">{s.project_name}</span>
										{s.id === active?.id && (
											<Check className="h-4 w-4 shrink-0" />
										)}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
						<Separator />
						{/* Pinned footer — outside CommandList so search never hides it. */}
						<div className="p-1">
							<Button
								variant="ghost"
								onClick={startCreate}
								className="h-auto w-full justify-start gap-2 whitespace-normal px-2 py-2 text-left"
							>
								<Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="flex min-w-0 flex-col">
									<span className="text-sm font-medium">Create a Spec</span>
									<span className="text-xs text-muted-foreground">
										Design infrastructure in this zone
									</span>
								</span>
							</Button>
						</div>
					</Command>
				</PopoverContent>
			</Popover>
		</>
	);
}
