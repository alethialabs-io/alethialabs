"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	ChevronDown,
	Loader2,
	RotateCcw,
	UserMinus,
	UserPlus,
	XCircle,
} from "lucide-react";
import { toast } from "sonner";
import type { SupportCaseStatus } from "@repo/support/enums";
import {
	assignCaseToMe,
	staffCloseCase,
	staffReopenCase,
	staffResolveCase,
	unassignCase,
} from "@/app/actions";

/** Every staff action performable from the case-detail menu. */
type StaffAction = "assign" | "unassign" | "resolve" | "reopen" | "close";

/** The lifecycle transitions a staff member may perform from each status. */
const LIFECYCLE_ACTIONS: Record<SupportCaseStatus, StaffAction[]> = {
	open: ["resolve", "close"],
	pending_support: ["resolve", "close"],
	pending_customer: ["resolve", "close"],
	resolved: ["reopen", "close"],
	closed: ["reopen"],
};

/** The server action + menu label + icon for each staff action. */
const ACTION_META: Record<
	StaffAction,
	{
		label: string;
		run: (id: string) => Promise<void>;
		icon: typeof CheckCircle2;
		success: string;
	}
> = {
	assign: {
		label: "Assign to me",
		run: assignCaseToMe,
		icon: UserPlus,
		success: "Case assigned to you",
	},
	unassign: {
		label: "Unassign",
		run: unassignCase,
		icon: UserMinus,
		success: "Case unassigned",
	},
	resolve: {
		label: "Mark resolved",
		run: staffResolveCase,
		icon: CheckCircle2,
		success: "Case marked resolved",
	},
	reopen: {
		label: "Reopen case",
		run: staffReopenCase,
		icon: RotateCcw,
		success: "Case reopened",
	},
	close: {
		label: "Close case",
		run: staffCloseCase,
		icon: XCircle,
		success: "Case closed",
	},
};

/**
 * The staff case-detail action menu: an "Assign to me" / "Unassign" toggle (based on
 * whether the case is assigned to the acting staff member) plus the status transitions
 * valid for the current status. Each action runs its server action then invalidates both
 * the case-detail query and the case-list queries so badges + list rows update in lockstep.
 */
export function StaffCaseActions({
	caseId,
	status,
	assignedStaffId,
	staffId,
}: {
	caseId: string;
	status: SupportCaseStatus;
	assignedStaffId: string | null;
	staffId: string;
}) {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: (action: StaffAction) => ACTION_META[action].run(caseId),
		onSuccess: async (_data, action) => {
			toast.success(ACTION_META[action].success);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["admin", "case", caseId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["admin", "cases"],
				}),
			]);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Something went wrong",
			);
		},
	});

	const assignAction: StaffAction =
		assignedStaffId === staffId ? "unassign" : "assign";
	const lifecycle = LIFECYCLE_ACTIONS[status];

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
				{(() => {
					const { label, icon: Icon } = ACTION_META[assignAction];
					return (
						<DropdownMenuItem onSelect={() => mutation.mutate(assignAction)}>
							<Icon className="size-4" />
							{label}
						</DropdownMenuItem>
					);
				})()}
				{lifecycle.length > 0 && <DropdownMenuSeparator />}
				{lifecycle.map((action) => {
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
