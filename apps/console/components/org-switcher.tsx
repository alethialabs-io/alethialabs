"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { planMeta } from "@repo/plan-catalog";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/**
 * Header organization switcher (Vercel-style). Lists the organizations the user
 * belongs to with their plan, marks the active one (which re-scopes the PDP + RLS on
 * switch), and offers a pinned "Create organization" action — always available, since
 * creating an org is the pay-to-collaborate path. The personal scope shows as
 * "Personal" (Free). Active org → "Create" opens the create sheet (name + plan → checkout).
 */
/** Compact initials for an org avatar — first letters of up to two words. */
function orgInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Where the switcher renders — `header` (compact inline) or `sidebar` (full-width row). */
type OrgSwitcherVariant = "header" | "sidebar";

export function OrgSwitcher({
	variant = "header",
}: { variant?: OrgSwitcherVariant } = {}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const { activeOrgId, organizations, fetchWorkspace, switchOrg } =
		useWorkspaceStore();

	useEffect(() => {
		fetchWorkspace();
	}, [fetchWorkspace]);

	const active =
		organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null;
	const meta = planMeta(active?.plan ?? "community");

	const handleSelect = async (orgId: string) => {
		setOpen(false);
		if (orgId === activeOrgId) return;
		await switchOrg(orgId);
		router.refresh(); // re-fetch server data under the new active org
	};

	const startCreate = () => {
		setOpen(false);
		setCreateOpen(true);
	};

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					{variant === "sidebar" ? (
						<Button
							variant="ghost"
							role="combobox"
							aria-expanded={open}
							className="h-auto w-full justify-start gap-2.5 px-2.5 py-2"
						>
							<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-foreground/20 to-foreground/5 text-[10px] font-semibold text-foreground">
								{orgInitials(active?.name ?? "Personal")}
							</span>
							<span className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium">
								{active?.name ?? "Personal"}
							</span>
							<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
								{meta.name}
							</span>
							<ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						</Button>
					) : (
						<Button
							variant="ghost"
							size="sm"
							role="combobox"
							aria-expanded={open}
							className="gap-2 px-2 text-sm font-medium"
						>
							<Building2 className="h-4 w-4 text-muted-foreground" />
							<span className="max-w-[12rem] truncate">
								{active?.name ?? "Personal"}
							</span>
							<ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
						</Button>
					)}
				</PopoverTrigger>
				<PopoverContent className="w-72 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find organization…" className="h-9" />
						<CommandList>
							<CommandEmpty>No organization found.</CommandEmpty>
							<CommandGroup heading="Organizations">
								{organizations.map((o) => {
									const meta = planMeta(o.plan);
									return (
										<CommandItem
											key={o.id}
											value={o.name}
											onSelect={() => handleSelect(o.id)}
											className="gap-2"
										>
											<Building2 className="h-4 w-4 text-muted-foreground" />
											<span className="flex-1 truncate">{o.name}</span>
											<Badge
												variant="outline"
												className="text-[10px] font-normal text-muted-foreground"
											>
												{meta.name}
											</Badge>
											{o.id === active?.id && (
												<Check className="h-4 w-4 shrink-0" />
											)}
										</CommandItem>
									);
								})}
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
									<span className="text-sm font-medium">Create organization</span>
									<span className="text-xs text-muted-foreground">
										Collaborate with others in a shared workspace
									</span>
								</span>
							</Button>
						</div>
					</Command>
				</PopoverContent>
			</Popover>

			<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
