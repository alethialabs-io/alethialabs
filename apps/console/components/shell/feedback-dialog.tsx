"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Angry, Frown, Laugh, Meh, Smile } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { submitFeedback } from "@/app/server/actions/feedback";
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
import { cn } from "@repo/ui/utils";

/** The 1–5 satisfaction faces, low → high. */
const RATING_FACES = [
	{ value: 1, icon: Angry, label: "Very unhappy" },
	{ value: 2, icon: Frown, label: "Unhappy" },
	{ value: 3, icon: Meh, label: "Neutral" },
	{ value: 4, icon: Smile, label: "Happy" },
	{ value: 5, icon: Laugh, label: "Very happy" },
] as const;

interface FeedbackDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * The hosted-only feedback dialog: pick a topic, rate the experience 1–5, write a
 * message, and send. Submits via the `submitFeedback` server action (which emails the
 * team). Controlled by the account dropdown so the "Feedback" item can open it.
 */
export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
	const {
		register,
		handleSubmit,
		control,
		reset,
		formState: { errors, isSubmitting },
	} = useForm<FeedbackInput>({
		resolver: zodResolver(feedbackSchema),
		defaultValues: { topic: "idea", rating: 5, message: "" },
	});

	/** Sends the feedback, then toasts + closes (or surfaces the failure). */
	const onSubmit = handleSubmit(async (values) => {
		try {
			await submitFeedback(values);
			toast.success("Thanks for the feedback!");
			reset();
			onOpenChange(false);
		} catch {
			toast.error("Couldn't send your feedback. Please try again.");
		}
	});

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

					<div className="space-y-2">
						<Label>How was your experience?</Label>
						<Controller
							control={control}
							name="rating"
							render={({ field }) => (
								<div className="flex items-center gap-1.5">
									{RATING_FACES.map(({ value, icon: Icon, label }) => (
										<button
											key={value}
											type="button"
											aria-label={label}
											aria-pressed={field.value === value}
											onClick={() => field.onChange(value)}
											className={cn(
												"flex h-9 w-9 items-center justify-center rounded-md border transition-colors",
												field.value === value
													? "border-foreground bg-muted text-foreground"
													: "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
											)}
										>
											<Icon className="h-5 w-5" />
										</button>
									))}
								</div>
							)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="feedback-message">Message</Label>
						<Textarea
							id="feedback-message"
							rows={4}
							placeholder="Describe your experience…"
							{...register("message")}
						/>
						{errors.message && (
							<p className="text-xs text-destructive">
								{errors.message.message}
							</p>
						)}
					</div>

					<DialogFooter>
						<Button type="submit" disabled={isSubmitting}>
							{isSubmitting ? "Sending…" : "Send"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
