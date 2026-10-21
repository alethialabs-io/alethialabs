"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import { Textarea } from "@repo/ui/textarea";
import { Loader2, SendHorizontal } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { postCaseMessage } from "@/app/server/actions/support";
import { FieldMessage } from "@/components/support/field-message";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { CaseWithThread, PublicMessage } from "@/lib/queries/support";
import { randomUuid } from "@/lib/random-id";
import { postMessageSchema } from "@/lib/validations/support";
import { caseKey, supportCaseKeys } from "./case-queries";

/** The composer's one field, validated by the same rule the server applies. */
const replyForm = postMessageSchema.pick({ body: true });

type ReplyForm = z.input<typeof replyForm>;

/** True when `value` is a cached case read (what the optimistic patch may append to). */
function isCaseRead(value: unknown): value is CaseWithThread {
	return typeof value === "object" && value !== null && "messages" in value && Array.isArray(value.messages);
}

/**
 * The reply composer for an OPEN, PENDING or RESOLVED case (a closed case shows a closed notice
 * instead — `CaseDetail`). A react-hook-form form over the server's own rule, through the mutation
 * contract: the reply appears in the thread at once (an optimistic patch of the case read, rolled
 * back if the action fails), Send is disabled while it is in flight (the double-submit guard), a
 * validation refusal lands under the field rather than in a toast, and on settle every key that
 * shows the case is invalidated — the thread, the "My cases" buckets and the bell.
 */
export function CaseComposer({ caseId }: { caseId: string }) {
	const form = useForm<ReplyForm>({
		resolver: zodResolver(replyForm),
		defaultValues: { body: "" },
	});
	const {
		register,
		handleSubmit,
		reset,
		setError,
		watch,
		formState: { errors },
	} = form;

	const send = useActionMutation(postCaseMessage, {
		invalidates: supportCaseKeys(),
		optimistic: [
			{
				key: caseKey(caseId),
				update: (current, variables) => {
					if (!isCaseRead(current)) return current;
					const optimistic: PublicMessage = {
						id: `optimistic-${randomUuid()}`,
						case_id: caseId,
						author_type: "customer",
						author_id: null,
						author_name: null,
						body: variables.body,
						created_at: new Date(),
					};
					return { ...current, messages: [...current.messages, optimistic] };
				},
			},
		],
		onValidationError: (fields) => {
			const message = fields.body?.[0] ?? fields._form?.[0];
			if (message) setError("body", { message });
		},
		onSuccess: () => reset({ body: "" }),
	});

	const onSubmit = handleSubmit((values) => {
		if (send.isPending) return;
		send.mutate({ caseId, body: values.body.trim() });
	});

	const body = watch("body");
	const messageId = `case-reply-message-${caseId}`;

	return (
		<form className="space-y-1" onSubmit={onSubmit} noValidate>
			<Textarea
				aria-label="Reply"
				aria-invalid={errors.body ? true : undefined}
				aria-describedby={messageId}
				placeholder="Write a reply… (⌘/Ctrl + Enter to send)"
				className="min-h-24 resize-y"
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void onSubmit();
					}
				}}
				{...register("body")}
			/>
			<div className="flex items-start justify-between gap-4">
				<FieldMessage id={messageId} message={errors.body?.message} />
				<Button
					type="submit"
					size="sm"
					className="shrink-0"
					disabled={send.isPending || body.trim().length === 0}
				>
					{send.isPending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
					Send
				</Button>
			</div>
		</form>
	);
}
