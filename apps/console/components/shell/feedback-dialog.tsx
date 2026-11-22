"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Angry, Frown, Laugh, Meh, Smile } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { submitFeedback } from "@/app/server/actions/feedback";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import {
	type FeedbackInput,
	FEEDBACK_TOPIC_LABELS,
	FEEDBACK_TOPICS,
	feedbackSchema,
} from "@/lib/validations/feedback";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Textarea } from "@repo/ui/textarea";

/** The 1–5 satisfaction faces, low → high. */
const RATING_FACES = [
	{ value: 1, icon: Angry, label: "Very unhappy" },
	{ value: 2, icon: Frown, label: "Unhappy" },
	{ value: 3, icon: Meh, label: "Neutral" },
	{ value: 4, icon: Smile, label: "Happy" },
	{ value: 5, icon: Laugh, label: "Very happy" },
] as const;

/** The toast a sent message earns: the dialog closes, so nothing else on screen says it went. */
export const FEEDBACK_SENT_MESSAGE = "Thanks for the feedback.";

/** The form fields a server validation message can be placed under. */
const FEEDBACK_FIELDS = ["topic", "rating", "message"] as const;

interface FeedbackDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The hosted-only feedback dialog: pick a topic, rate the experience 1–5, write a message, and send.
 * Submits `submitFeedback` through the mutation contract (`useActionMutation`, R6 G-27): Send is
 * disabled while the message is in flight and a second press does nothing; a server validation
 * message lands under its field; an ended session brings up the session-ended dialog; anything else
 * is one toast. On success it toasts, clears and closes. Controlled by the account dropdown so the
 * "Feedback" item can open it.
 *
 * The rating is a fieldset of native radios (visually the faces) named by its legend, so arrow keys
 * move the choice and a screen reader hears the question with each face's name.
 */
export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
	const form = useForm<FeedbackInput>({
		resolver: zodResolver(feedbackSchema),
		defaultValues: { topic: "idea", rating: 5, message: "" },
	});
	const {
		register,
		control,
		reset,
		formState: { errors },
	} = form;

	const send = useActionMutation(submitFeedback, {
		invalidates: [],
		form: { instance: form, fields: FEEDBACK_FIELDS },
		successMessage: FEEDBACK_SENT_MESSAGE,
		closes: onOpenChange,
		onSuccess: () => reset(),
	});

	/** Sends the feedback once its schema passes; a second submit while one is in flight does nothing. */
	const onSubmit = form.handleSubmit((values) => send.submit(values));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Share feedback</DialogTitle>
					<DialogDescription>
						Tell us what&apos;s working and what isn&apos;t — we read every
						message.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="feedback-topic">Topic</Label>
						<Controller
							control={control}
							name="topic"
							render={({ field }) => (
								<Select value={field.value} onValueChange={field.onChange}>
									<SelectTrigger id="feedback-topic" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{FEEDBACK_TOPICS.map((topic) => (
											<SelectItem key={topic} value={topic}>
												{FEEDBACK_TOPIC_LABELS[topic]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						/>
					</div>

					<Controller
						control={control}
						name="rating"
						render={({ field }) => (
							<fieldset className="space-y-2">
								<legend className="text-sm font-medium leading-none">
									How was your experience?
								</legend>
								<div className="flex items-center gap-1.5">
									{RATING_FACES.map(({ value, icon: Icon, label }) => (
										<label key={value} className="cursor-pointer">
											<input
												type="radio"
												name={field.name}
												value={value}
												aria-label={label}
												checked={field.value === value}
												onChange={() => field.onChange(value)}
												onBlur={field.onBlur}
												className="peer sr-only"
											/>
											<span
												aria-hidden
												className="flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground peer-checked:border-foreground peer-checked:bg-muted peer-checked:text-foreground peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50"
											>
												<Icon className="h-5 w-5" />
											</span>
										</label>
									))}
								</div>
								{errors.rating && (
									<p className="text-xs text-destructive">{errors.rating.message}</p>
								)}
							</fieldset>
						)}
					/>

					<div className="space-y-2">
						<Label htmlFor="feedback-message">Message</Label>
						<Textarea
							id="feedback-message"
							rows={4}
							placeholder="Describe your experience…"
							aria-invalid={errors.message ? true : undefined}
							{...register("message")}
						/>
						{errors.message && (
							<p className="text-xs text-destructive">
								{errors.message.message}
							</p>
						)}
					</div>

					<FormRootError form={form} />

					<DialogFooter>
						<Button type="submit" disabled={send.isPending} aria-busy={send.isPending}>
							{send.isPending ? "Sending…" : "Send"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
