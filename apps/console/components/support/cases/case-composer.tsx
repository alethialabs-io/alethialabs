"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Textarea } from "@repo/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SendHorizontal } from "lucide-react";
import { useState } from "react";
import { postCaseMessage } from "@/app/server/actions/support";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import { qk } from "@/lib/query/keys";
import type { CaseWithThread, PublicMessage } from "@/lib/queries/support";

/**
 * The reply composer for a case thread. On send it optimistically appends the customer's
 * message to the `["support","case",id]` cache (so the bubble shows immediately), calls the
 * `postCaseMessage` server action, and invalidates the case query on settle to reconcile
 * with server truth. Disabled once the case is `closed`.
 */
export function CaseComposer({
	caseId,
	caseStatus,
}: {
	caseId: string;
	caseStatus: SupportCaseStatus;
}) {
	const [body, setBody] = useState("");
	const queryClient = useQueryClient();
	const isClosed = caseStatus === "closed";

	const mutation = useMutation({
		mutationFn: (text: string) =>
			postCaseMessage({ caseId, body: text }),
		onMutate: async (text: string) => {
			const key = qk.supportCase(caseId);
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<CaseWithThread | null>(key);
			const optimistic: PublicMessage = {
				id: `optimistic-${crypto.randomUUID()}`,
				case_id: caseId,
				author_type: "customer",
				author_id: null,
				author_name: null,
				body: text,
				created_at: new Date(),
			};
			queryClient.setQueryData<CaseWithThread | null>(key, (current) =>
				current
					? { ...current, messages: [...current.messages, optimistic] }
					: current,
			);
			return { previous };
		},
		onError: (_err, _text, context) => {
			// Roll back the optimistic append on failure.
			if (context?.previous !== undefined) {
				queryClient.setQueryData(qk.supportCase(caseId), context.previous);
			}
		},
		onSettled: () => {
			void queryClient.invalidateQueries({
				queryKey: qk.supportCase(caseId),
			});
		},
	});

	/** Sends the trimmed reply, clearing the input immediately for the optimistic bubble. */
	function handleSend() {
		const text = body.trim();
		if (!text || mutation.isPending || isClosed) return;
		setBody("");
		mutation.mutate(text);
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
				disabled={isClosed}
				placeholder={
					isClosed
						? "This case is closed."
						: "Write a reply… (⌘/Ctrl + Enter to send)"
				}
				className="min-h-24 resize-y"
			/>
			<div className="flex justify-end">
				<Button
					size="sm"
					onClick={handleSend}
					disabled={isClosed || mutation.isPending || body.trim().length === 0}
				>
					<SendHorizontal className="size-4" />
					Send
				</Button>
			</div>
		</div>
	);
}
