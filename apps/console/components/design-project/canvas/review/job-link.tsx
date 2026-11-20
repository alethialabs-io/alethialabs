"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { orgHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/**
 * A link to one job in the Jobs view, where its log and whatever it is waiting on are. It is a
 * link and reads as one: it navigates, it does not act.
 */
export function JobLink({
	jobId,
	children,
	variant = "outline",
	className,
}: {
	jobId: string;
	/** The link's words: "View log", "Open the job". */
	children: ReactNode;
	variant?: "outline" | "ghost" | "link";
	className?: string;
}) {
	const orgSlug = useActiveOrgSlug();
	return (
		<Button
			variant={variant}
			size="sm"
			className={className}
			render={<Link href={`${orgHref(orgSlug)}/~/jobs?job=${jobId}`} />}
		>
			{children}
		</Button>
	);
}
