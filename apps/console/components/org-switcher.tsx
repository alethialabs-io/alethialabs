"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/**
 * Header workspace switcher. Lists the organizations the user belongs to and sets
 * the active one (which re-scopes the PDP + RLS). Community has a single "Personal"
 * workspace, so it renders a static chip; multi-org + "Create organization" light up
 * only when the `organizations` entitlement is on (Enterprise).
 */
export function OrgSwitcher() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const { activeOrgId, organizations, entitlements, fetchWorkspace, switchOrg } =
		useWorkspaceStore();

	useEffect(() => {
		fetchWorkspace();
	}, [fetchWorkspace]);

	const active =
		organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null;
	const canManageOrgs = entitlements?.organizations ?? false;
	// Only an interactive switcher when there's more than one place to go.
	const interactive = organizations.length > 1 || canManageOrgs;

	const handleSelect = async (orgId: string) => {
		setOpen(false);
		if (orgId === activeOrgId) return;
		await switchOrg(orgId);
		router.refresh(); // re-fetch server data under the new active org
	};

	// Single personal workspace (community): a static, non-interactive chip.
	if (!interactive) {
		return (
			<div className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-foreground">
				<Building2 className="h-4 w-4 text-muted-foreground" />
				<span className="font-medium">{active?.name ?? "Personal"}</span>
			</div>
		);
	}

	return (
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
						{active?.name ?? "Select workspace"}
					</span>
					<ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-0" align="start">
				<Command>
					<CommandInput placeholder="Switch workspace…" className="h-9" />
					<CommandList>
						<CommandEmpty>No workspace found.</CommandEmpty>
						<CommandGroup heading="Organizations">
							{organizations.map((o) => (
								<CommandItem
									key={o.id}
									value={o.name}
									onSelect={() => handleSelect(o.id)}
									className="gap-2"
								>
									<Building2 className="h-4 w-4 text-muted-foreground" />
									<span className="flex-1 truncate">{o.name}</span>
									<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
										{o.role}
									</span>
									{o.id === active?.id && <Check className="h-4 w-4" />}
								</CommandItem>
							))}
						</CommandGroup>
						{canManageOrgs && (
							<>
								<CommandSeparator />
								<CommandGroup>
									<CommandItem
										onSelect={() => {
											setOpen(false);
											router.push("/dashboard/settings/organization");
										}}
										className="gap-2 text-muted-foreground"
									>
										<Plus className="h-4 w-4" />
										Create organization
									</CommandItem>
								</CommandGroup>
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
