"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Boxes, Check } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	getEnvironmentsForSlug,
	type SwitcherEnv,
} from "@/app/server/actions/resolve";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
import { Badge } from "@repo/ui/badge";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { Popover, PopoverContent } from "@repo/ui/popover";
import { envHref } from "@/lib/routing";

/**
 * Header environment switcher — the Vercel combobox after org + project. Shows the
 * current project's environments and navigates to `/{org}/{project}/{env}`. Only renders
 * on a project drilldown route (`/{org}/{project}[/{env}]`); hidden on the legacy
 * `/dashboard/*` routes, the `~` org-global tree, and the bare org overview.
 */
export function EnvSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const [envs, setEnvs] = useState<SwitcherEnv[]>([]);

	// Parse `/{org}/{project}[/{env}]` — never the legacy /dashboard or `~` global tree.
	const segs = pathname.split("/").filter(Boolean);
	const isDrilldown =
		segs[0] !== "dashboard" && segs[1] !== "~" && segs.length >= 2;
	const [org, project, env] = segs;

	useEffect(() => {
		if (!isDrilldown) return;
		let live = true;
		getEnvironmentsForSlug(project)
			.then((rows) => {
				if (live) setEnvs(rows);
			})
			.catch(() => {
				if (live) setEnvs([]);
			});
		return () => {
			live = false;
		};
	}, [isDrilldown, project]);

	if (!isDrilldown || envs.length === 0) return null;

	const active =
		envs.find((e) => e.name === env) ??
		envs.find((e) => e.is_default) ??
		envs[0];

	const handleSelect = (name: string) => {
		setOpen(false);
		router.push(envHref(org, project, name));
	};

	return (
		<>
			<span className="text-border/70 select-none" aria-hidden>
				/
			</span>
			<Popover open={open} onOpenChange={setOpen}>
				<SwitcherTrigger
					variant="topbar"
					open={open}
					leading={
						<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-muted-foreground">
							<Boxes className="h-3 w-3" />
						</span>
					}
					caption="Env"
					label={active?.name ?? ""}
				/>
				<PopoverContent className="w-64 p-0" align="start">
					<Command>
						<CommandInput placeholder="Find environment…" className="h-9" />
						<CommandList>
							<CommandEmpty>No environment found.</CommandEmpty>
							<CommandGroup heading="Environments">
								{envs.map((e) => (
									<CommandItem
										key={e.id}
										value={e.name}
										onSelect={() => handleSelect(e.name)}
										className="gap-2"
									>
										<Boxes className="h-4 w-4 text-muted-foreground" />
										<span className="flex-1 truncate">{e.name}</span>
										<Badge
											variant="outline"
											className="text-[10px] font-normal text-muted-foreground"
										>
											{e.stage}
										</Badge>
										{e.name === active?.name && (
											<Check className="h-4 w-4 shrink-0" />
										)}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</>
	);
}
