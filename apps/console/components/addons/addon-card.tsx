"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One marketplace catalog card: the add-on's identity + a status/action footer. Not installed
// → Enable; installed → status badge + Configure / Remove. Free-OSS is stated up front.

import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@repo/ui/card";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import { useDisableAddon } from "@/lib/query/use-addons-query";
import { AddonIcon, AddonStatusBadge } from "./addon-visuals";

export function AddonCard({
	item,
	projectId,
	environmentId,
	onConfigure,
}: {
	item: AddonMarketItem;
	projectId: string;
	environmentId: string | null;
	onConfigure: (item: AddonMarketItem) => void;
}) {
	const disable = useDisableAddon(projectId, environmentId);
	const installed = item.install !== null;

	const onRemove = async () => {
		try {
			await disable.mutateAsync({
				projectId,
				environmentId,
				addonId: item.id,
			});
			toast.success(`${item.name} removed`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to remove add-on");
		}
	};

	return (
		<Card className="flex flex-col">
			<CardHeader className="flex-row items-start gap-3 space-y-0">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/30">
					<AddonIcon icon={item.icon} className="h-5 w-5" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate font-medium">{item.name}</span>
						{installed && (
							<AddonStatusBadge
								status={item.install!.status}
								health={item.install!.health}
							/>
						)}
					</div>
					<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
						<Badge variant="outline" className="text-[10px] uppercase">
							Free · OSS
						</Badge>
						<span>{item.license}</span>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex-1">
				<p className="text-sm text-muted-foreground">{item.summary}</p>
			</CardContent>
			<CardFooter className="flex items-center justify-between gap-2">
				<a
					href={item.docsUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Docs <ExternalLink className="h-3 w-3" />
				</a>
				<div className="flex gap-2">
					{installed ? (
						<>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={onRemove}
								disabled={disable.isPending}
							>
								Remove
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => onConfigure(item)}
							>
								Configure
							</Button>
						</>
					) : (
						<Button type="button" size="sm" onClick={() => onConfigure(item)}>
							Enable
						</Button>
					)}
				</div>
			</CardFooter>
		</Card>
	);
}
