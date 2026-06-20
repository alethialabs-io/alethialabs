"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Badge } from "@/components/ui/badge";
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
import { planMeta } from "@/lib/billing/plan-catalog";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/**
 * Header organization switcher (Vercel-style). Lists the organizations the user
 * belongs to with their plan, marks the active one (which re-scopes the PDP + RLS on
 * switch), and offers a pinned "Create organization" action — always available, since
 * creating an org is the pay-to-collaborate path. The personal scope shows as
 * "Personal" (Free). Active org → "Create" opens the create sheet (name + plan → checkout).
 */
export function OrgSwitcher() {
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
								className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
							>
								<Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="flex flex-col">
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
