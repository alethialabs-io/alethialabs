"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { OrgAvatar } from "@/components/org/org-avatar";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
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
import { Popover, PopoverContent } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { planMeta } from "@repo/plan-catalog";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { orgHref } from "@/lib/routing";

/**
 * Header organization switcher (Vercel-style). Lists the organizations the user
 * belongs to with their plan, marks the active one (which re-scopes the PDP + RLS on
 * switch), and offers a pinned "Create organization" action — always available, since
 * creating an org is the pay-to-collaborate path. The personal scope shows as
 * "Personal" (Free). "Create" opens the create sheet (name → pay → invite). The trigger is a
 * split button: clicking the org name/avatar navigates to the org home, only the chevron opens
 * the switcher.
 */
export function OrgSwitcher() {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
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
				<SwitcherTrigger
					variant="sidebar"
					open={open}
					href={orgHref(orgSlug)}
					ariaLabel="Switch organization"
					leading={
						<OrgAvatar
							name={active?.name ?? "Personal"}
							logo={active?.logo}
							size={24}
							className="rounded-full"
						/>
					}
					label={active?.name ?? "Personal"}
					badge={
						<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
							{meta.name}
						</span>
					}
				/>
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
											<OrgAvatar
												name={o.name}
												logo={o.logo}
												size={20}
												className="rounded-full"
											/>
											<span className="flex-1 truncate">{o.name}</span>
											{o.status === "trialing" && (
												<Badge className="bg-ink px-1.5 text-[9.5px] font-medium uppercase tracking-wide text-ink-foreground">
													Trial
												</Badge>
											)}
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
										Collaborate with others in a shared organization
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
