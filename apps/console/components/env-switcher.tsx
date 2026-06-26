"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Boxes, Check, ChevronDown, ChevronsUpDown } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	getEnvironmentsForSlug,
	type SwitcherEnv,
} from "@/app/server/actions/resolve";
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
import { envHref } from "@/lib/routing";

/**
 * Header environment switcher — the third Vercel combobox, after org + zone. Shows
 * the current spec's environments and navigates to `/{org}/{zone}/{spec}/{env}`.
 * Only renders on a spec drilldown route (`/{org}/{zone}/{spec}[/{env}]`); hidden on
 * the legacy `/dashboard/*` routes and anywhere above a spec.
 */
export function EnvSwitcher({
	variant = "header",
}: { variant?: "header" | "topbar" } = {}) {
	const router = useRouter();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	const [envs, setEnvs] = useState<SwitcherEnv[]>([]);

	// Parse `/{org}/{zone}/{spec}[/{env}]` — but never the legacy /dashboard tree.
	const segs = pathname.split("/").filter(Boolean);
	const isDrilldown = segs[0] !== "dashboard" && segs.length >= 3;
	const [org, zone, spec, env] = segs;

	useEffect(() => {
		if (!isDrilldown) return;
		let live = true;
		getEnvironmentsForSlug(zone, spec)
			.then((rows) => {
				if (live) setEnvs(rows);
			})
			.catch(() => {
				if (live) setEnvs([]);
			});
		return () => {
			live = false;
		};
	}, [isDrilldown, zone, spec]);

	if (!isDrilldown || envs.length === 0) return null;

	const active =
		envs.find((e) => e.name === env) ??
		envs.find((e) => e.is_default) ??
		envs[0];

	const handleSelect = (name: string) => {
		setOpen(false);
		router.push(envHref(org, zone, spec, name));
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
								<Boxes className="h-3 w-3" />
							</span>
							<span className="flex flex-col items-start leading-tight">
								<span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">
									Env
								</span>
								<span className="max-w-[10rem] truncate text-[13px] font-medium text-foreground">
									{active?.name}
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
							<Boxes className="h-4 w-4 text-muted-foreground" />
							<span className="max-w-[10rem] truncate">{active?.name}</span>
							<ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
						</Button>
					)}
				</PopoverTrigger>
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
