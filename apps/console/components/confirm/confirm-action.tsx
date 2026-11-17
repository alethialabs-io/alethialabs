"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's one confirmation in front of an action that cannot be taken back.
//
// The dialog OWNS the three things every caller used to wire by hand, and wired differently:
//
// - pending: while the confirmed action runs the primary button shows `pendingLabel` and is
//   disabled (the double-submit guard), and Cancel and Escape do nothing;
// - close on success: the dialog calls `onOpenChange(false)` itself once the action has succeeded,
//   so a caller cannot forget to;
// - stay open on failure: a refused or failed action leaves the question on screen, beside the
//   toast or inline sentence that says why.
//
// What is confirmed is given in one of two forms. A write that goes through the mutation contract
// passes `mutation` and `variables` (`useActionMutation`'s result). Anything else passes `run`: a
// function that is done when it returns, or when the promise it returns settles. A `run` that
// resolves `false`, or rejects, counts as a failure.

import { zodResolver } from "@hookform/resolvers/zod";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

/**
 * How much stands between the click and the action.
 *
 * `confirm` is a yes/no question. `destroy` is for what removes a whole resource: the dialog lists
 * the `consequences` and the primary button stays disabled until `subject` (the resource's name)
 * has been typed.
 */
export type ConfirmSeverity =
	| { level: "confirm" }
	| { level: "destroy"; subject: string; consequences: readonly string[] };

/**
 * The part of a mutation the dialog drives. The result of `useActionMutation` satisfies it; a
 * mutation whose action takes no input is given `{}` as its variables.
 */
export interface ConfirmableMutation<V> {
	/** True while a call is in flight. */
	isPending: boolean;
	/** Starts the call; `onSuccess` runs after the mutation's own success handling. */
	mutate: (variables: V, options?: { onSuccess?: () => void }) => void;
}

interface ConfirmActionBase {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	/** The primary button's text. */
	confirmLabel: string;
	/** The primary button's text while the action runs. */
	pendingLabel?: string;
	severity: ConfirmSeverity;
}

/** What the primary button does: a contract mutation, or a plain function. */
type ConfirmSource<V> =
	| {
			/** The write to run on confirm. */
			mutation: ConfirmableMutation<V>;
			/** Its input; `null` while there is nothing to act on (the dialog is closed). */
			variables: NoInfer<V> | null;
			run?: never;
	  }
	| {
			/**
			 * Runs on confirm. Done when it returns, or when the promise it returns settles;
			 * resolving `false` or rejecting keeps the dialog open.
			 */
			run: () => unknown;
			mutation?: never;
			variables?: never;
	  };

export type ConfirmActionProps<V = never> = ConfirmActionBase & ConfirmSource<V>;

/** A confirmation that runs the action itself and closes only when it has succeeded. */
export function ConfirmAction<V = never>({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	pendingLabel = "Working…",
	severity,
	mutation,
	variables,
	run,
}: ConfirmActionProps<V>) {
	const [running, setRunning] = useState(false);
	const pending = mutation ? mutation.isPending : running;
	/** Set on the click itself, because `pending` only changes on the next render. */
	const started = useRef(false);
	useEffect(() => {
		if (!pending) started.current = false;
	}, [pending]);

	/** Runs the confirmed action once, and closes the dialog when it has succeeded. */
	const confirm = () => {
		if (pending || started.current) return;
		if (mutation) {
			if (variables == null) return;
			started.current = true;
			mutation.mutate(variables, { onSuccess: () => onOpenChange(false) });
			return;
		}
		if (!run) return;
		const result: unknown = run();
		if (!(result instanceof Promise)) {
			if (result !== false) onOpenChange(false);
			return;
		}
		started.current = true;
		setRunning(true);
		void result
			.then(
				(outcome: unknown) => {
					if (outcome !== false) onOpenChange(false);
				},
				() => {
					// The action has already said what went wrong; the question stays on screen.
				},
			)
			.finally(() => {
				started.current = false;
				setRunning(false);
			});
	};

	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next && pending) return;
				onOpenChange(next);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{severity.level === "destroy" ? (
					<TypedConfirmation
						subject={severity.subject}
						consequences={severity.consequences}
						confirmLabel={confirmLabel}
						pendingLabel={pendingLabel}
						pending={pending}
						onConfirm={confirm}
					/>
				) : (
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
						<Button
							variant="destructive"
							disabled={pending}
							aria-busy={pending}
							onClick={confirm}
						>
							{pending ? pendingLabel : confirmLabel}
						</Button>
					</AlertDialogFooter>
				)}
			</AlertDialogContent>
		</AlertDialog>
	);
}

interface TypedConfirmationProps {
	subject: string;
	consequences: readonly string[];
	confirmLabel: string;
	pendingLabel: string;
	pending: boolean;
	onConfirm: () => void;
}

/**
 * The body of a `destroy` confirmation: what goes, and a field the resource's name is typed into.
 * Mounted with the dialog's content, so each opening starts with an empty field.
 */
function TypedConfirmation({
	subject,
	consequences,
	confirmLabel,
	pendingLabel,
	pending,
	onConfirm,
}: TypedConfirmationProps) {
	const schema = useMemo(
		() =>
			z.object({
				confirmation: z
					.string()
					.refine(
						(value) => subject !== "" && value.trim() === subject,
						`Type ${subject} exactly to confirm`,
					),
			}),
		[subject],
	);
	const form = useForm<z.infer<typeof schema>>({
		resolver: zodResolver(schema),
		defaultValues: { confirmation: "" },
	});
	const typed = useWatch({ control: form.control, name: "confirmation" });
	const matches = schema.safeParse({ confirmation: typed }).success;

	return (
		<>
			{consequences.length > 0 && (
				<ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					{consequences.map((consequence) => (
						<li key={consequence}>{consequence}</li>
					))}
				</ul>
			)}
			<Form {...form}>
				<form onSubmit={form.handleSubmit(onConfirm)} className="grid gap-4">
					<FormField
						control={form.control}
						name="confirmation"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-ui-md font-normal">
									<span>
										Type <span className="font-mono font-medium">{subject}</span> to confirm
									</span>
								</FormLabel>
								<FormControl>
									<Input
										autoComplete="off"
										spellCheck={false}
										{...field}
										disabled={pending}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
						<Button
							type="submit"
							variant="destructive"
							disabled={!matches || pending}
							aria-busy={pending}
						>
							{pending ? pendingLabel : confirmLabel}
						</Button>
					</AlertDialogFooter>
				</form>
			</Form>
		</>
	);
}
