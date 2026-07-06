"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SendHorizontal, Sparkles } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { SupportCaseStatus } from "@repo/support/enums";
import { postStaffReply } from "@/app/actions";
import type { StaffCaseDetail } from "@/lib/queries";
import { applyMacro, SUPPORT_MACROS } from "@/lib/macros";

/** One optimistic thread message (matches the staff SupportMessage row shape). */
type StaffMessage = StaffCaseDetail["messages"][number];

/**
 * The staff reply composer: a textarea, an "Internal note" toggle (an internal note is
 * inserted without emailing/showing the customer, and never changes status), a canned-reply
 * picker that inserts a placeholder-filled macro, and a Send button. On send it optimistically
 * appends the message to the `["admin","case",id]` cache, calls `postStaffReply`, and
 * invalidates on settle. Public replies are blocked once the case is closed; internal notes
 * are still allowed.
 */
export function StaffCaseComposer({
	caseId,
	caseNumber,
	caseStatus,
	customerName,
	agentName,
	staffId,
}: {
	caseId: string;
	caseNumber: number;
	caseStatus: SupportCaseStatus;
	customerName: string | null;
	agentName: string;
	staffId: string;
}) {
	const [body, setBody] = useState("");
	const [isInternal, setIsInternal] = useState(false);
	const queryClient = useQueryClient();
	const internalCheckboxId = useId();
	const key = ["admin", "case", caseId] as const;

	// A public reply can't go out on a closed case; an internal note always can.
	const sendDisabled = caseStatus === "closed" && !isInternal;

	const mutation = useMutation({
		mutationFn: (input: { text: string; internal: boolean }) =>
			postStaffReply({
				caseId,
				body: input.text,
				isInternal: input.internal,
			}),
		onMutate: async (input) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<StaffCaseDetail | null>(key);
			const optimistic: StaffMessage = {
				id: `optimistic-${crypto.randomUUID()}`,
				case_id: caseId,
				author_type: "staff",
				author_id: staffId,
				author_name: agentName,
				body: input.text,
				is_internal: input.internal,
				created_at: new Date(),
			};
			queryClient.setQueryData<StaffCaseDetail | null>(key, (current) =>
				current
					? { ...current, messages: [...current.messages, optimistic] }
					: current,
			);
			return { previous };
		},
		onError: (error, _input, context) => {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(key, context.previous);
			}
			toast.error(
				error instanceof Error ? error.message : "Failed to send reply",
			);
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: key });
			void queryClient.invalidateQueries({
				queryKey: ["admin", "cases"],
			});
		},
	});

	/** Inserts a filled macro at the end of the current draft. */
	function insertMacro(macroBody: string) {
		const filled = applyMacro(macroBody, {
			caseNumber,
			customerName: customerName ?? undefined,
			agentName,
		});
		setBody((current) => (current.trim() ? `${current}\n\n${filled}` : filled));
	}

	/** Sends the trimmed reply, clearing the input immediately for the optimistic bubble. */
	function handleSend() {
		const text = body.trim();
		if (!text || mutation.isPending || sendDisabled) return;
		const internal = isInternal;
		setBody("");
		mutation.mutate({ text, internal });
	}

	return (
		<div className="space-y-2">
			<Textarea
				value={body}
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						handleSend();
					}
				}}
				placeholder={
					isInternal
						? "Write an internal note (not visible to the customer)…"
						: "Write a reply… (⌘/Ctrl + Enter to send)"
				}
				className="min-h-24 resize-y"
			/>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-2">
						<Checkbox
							id={internalCheckboxId}
							checked={isInternal}
							onCheckedChange={(v) => setIsInternal(v === true)}
						/>
						<Label
							htmlFor={internalCheckboxId}
							className="text-xs font-normal text-muted-foreground"
						>
							Internal note
						</Label>
					</div>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								<Sparkles className="size-4" />
								Canned reply
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="max-w-72">
							<DropdownMenuLabel>Insert a macro</DropdownMenuLabel>
							{SUPPORT_MACROS.map((macro) => (
								<DropdownMenuItem
									key={macro.id}
									onSelect={() => insertMacro(macro.body)}
								>
									{macro.title}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				<Button
					size="sm"
					onClick={handleSend}
					disabled={
						sendDisabled || mutation.isPending || body.trim().length === 0
					}
				>
					<SendHorizontal className="size-4" />
					{isInternal ? "Add note" : "Send"}
				</Button>
			</div>
			{sendDisabled && (
				<p className="text-xs text-muted-foreground">
					This case is closed — reopen it to send a public reply, or add an
					internal note.
				</p>
			)}
		</div>
	);
}
