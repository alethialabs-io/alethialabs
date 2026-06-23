"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Box, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
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
import { zoneHref } from "@/lib/routing";

/**
 * Header zone (workspace) switcher — the Vercel "project" combobox sitting next to
 * the org switcher. Lists the active org's zones, marks the one in the current path
 * (`/dashboard/zones/{id}`), and navigates on select. A pinned "Create a Spec" footer
 * is always available. Rendered only when the org has at least one zone, so a fresh
 * org's chrome stays clean until there's something to switch between.
 */
export function ZoneSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const [open, setOpen] = useState(false);
	const { zones, fetchZones } = useZonesStore();

	useEffect(() => {
		fetchZones();
	}, [fetchZones]);

	// Active zone = the slug in the drilldown path `/{org}/{zone}/…` (or the legacy
	// `/dashboard/zones/{id}` path during the transition).
	const segs = pathname.split("/").filter(Boolean);
	const active =
		zones.find(
			(z) =>
				(segs[0] !== "dashboard" && z.slug && z.slug === segs[1]) ||
				pathname.startsWith(`/dashboard/zones/${z.id}`),
		) ?? null;

	const handleSelect = (zoneSlug: string | null, zoneId: string) => {
		setOpen(false);
		router.push(zoneSlug ? zoneHref(orgSlug, zoneSlug) : `/dashboard/zones/${zoneId}`);
	};

	const startCreate = () => {
		setOpen(false);
		router.push("/dashboard/design-spec");
	};

	// Nothing to switch between yet — hide the control entirely.
	if (zones.length === 0) return null;

	return (
		<>
			<span className="text-border/70 select-none" aria-hidden>
				/
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						role="combobox"
						aria-expanded={open}
						className="gap-2 px-2 text-sm font-medium"
					>
						<Box className="h-4 w-4 text-muted-foreground" />
						<span className="max-w-[12rem] truncate">
							{active?.name ?? "Select a zone"}
						</span>
						<ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-72 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find zone…" className="h-9" />
						<CommandList>
							<CommandEmpty>No zone found.</CommandEmpty>
							<CommandGroup heading="Zones">
								{zones.map((z) => (
									<CommandItem
										key={z.id}
										value={z.name}
										onSelect={() => handleSelect(z.slug, z.id)}
										className="gap-2"
									>
										<Box className="h-4 w-4 text-muted-foreground" />
										<span className="flex-1 truncate">{z.name}</span>
										{z.id === active?.id && (
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
								className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
							>
								<Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="flex flex-col">
									<span className="text-sm font-medium">Create a Spec</span>
									<span className="text-xs text-muted-foreground">
										Design infrastructure in a zone
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
