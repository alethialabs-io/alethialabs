"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Loader2, RotateCcw, XCircle } from "lucide-react";
import {
	closeCase,
	reopenCase,
	resolveCase,
} from "@/app/server/actions/support";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import { qk } from "@/lib/query/keys";

/** The lifecycle actions available on a case, resolved from its current status. */
type CaseAction = "resolve" | "reopen" | "close";

/** Maps each status to the transitions a customer may perform from it. */
const AVAILABLE_ACTIONS: Record<SupportCaseStatus, CaseAction[]> = {
	open: ["resolve", "close"],
	pending_support: ["resolve", "close"],
	pending_customer: ["resolve", "close"],
	resolved: ["reopen", "close"],
	closed: ["reopen"],
};

/** The server action + menu label for each lifecycle transition. */
const ACTION_META: Record<
	CaseAction,
	{ label: string; run: (id: string) => Promise<void>; icon: typeof CheckCircle2 }
> = {
	resolve: { label: "Mark resolved", run: resolveCase, icon: CheckCircle2 },
	reopen: { label: "Reopen case", run: reopenCase, icon: RotateCcw },
	close: { label: "Close case", run: closeCase, icon: XCircle },
};

/**
 * The status-transition control for a case. Presents only the transitions valid for the
 * current status; each runs its server action then invalidates both the case-detail query
 * and every case-list query so the badge and the "My cases" buckets update in lockstep.
 */
export function CaseActions({
	caseId,
	status,
}: {
	caseId: string;
	status: SupportCaseStatus;
}) {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: (action: CaseAction) => ACTION_META[action].run(caseId),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.supportCase(caseId) }),
				queryClient.invalidateQueries({ queryKey: ["support", "cases"] }),
			]);
		},
	});

	const actions = AVAILABLE_ACTIONS[status];
	if (actions.length === 0) return null;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="sm" disabled={mutation.isPending}>
					{mutation.isPending ? (
						<Loader2 className="size-4 animate-spin" />
					) : null}
					Actions
					<ChevronDown className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{actions.map((action) => {
					const { label, icon: Icon } = ACTION_META[action];
					return (
						<DropdownMenuItem
							key={action}
							onSelect={() => mutation.mutate(action)}
						>
							<Icon className="size-4" />
							{label}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
