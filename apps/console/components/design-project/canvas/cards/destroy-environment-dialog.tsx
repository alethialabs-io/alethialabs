"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	type DestroyTreeNode,
	joinNames,
	placementLabel,
	splitDestroyTree,
} from "./destroy-tree-view";

/** Where the dialog is in reading the destroy tree. */
export type DestroyTreeState =
	| { phase: "loading" }
	| { phase: "error" }
	| { phase: "ready"; tree: DestroyTreeNode[] };

interface DestroyEnvironmentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The destroy tree as read so far. The dialog opens before the read lands. */
	state: DestroyTreeState;
	/** What a cascade asks the user to type. Falls back to the target environment's name when null. */
	projectName: string | null;
	/** Queue the destroy. `cascade` is true only from the type-to-confirm form. */
	onDestroy: (options: { cascade: boolean }) => void;
	/** The user chose to destroy the tenants themselves; they are passed back, in order. */
	onChildrenFirst: (tenants: DestroyTreeNode[]) => void;
}

/**
 * The confirmation in front of destroying an environment (#5261).
 *
 * With nothing placed on the environment's cluster it is the confirmation it always was. With live
 * tenants it lists every environment that will go — each tenant with its placement and status, then
 * the environment that owns the cluster — and offers the two ways forward the CLI offers: destroy the
 * children first (which cancels), or cascade, behind typing the project name.
 */
export function DestroyEnvironmentDialog({
	open,
	onOpenChange,
	state,
	projectName,
	onDestroy,
	onChildrenFirst,
}: DestroyEnvironmentDialogProps) {
	const split = state.phase === "ready" ? splitDestroyTree(state.tree) : null;
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				{split && split.tenants.length > 0 ? (
					<CascadeConfirm
						tenants={split.tenants}
						target={split.target}
						phrase={projectName?.trim() || split.target.name}
						phraseIsProject={Boolean(projectName?.trim())}
						onOpenChange={onOpenChange}
						onDestroy={onDestroy}
						onChildrenFirst={onChildrenFirst}
					/>
				) : (
					<SingleConfirm
						phase={state.phase}
						onOpenChange={onOpenChange}
						onDestroy={onDestroy}
					/>
				)}
			</AlertDialogContent>
		</AlertDialog>
	);
}

/**
 * Nothing else is placed on this environment's cluster: today's confirmation, unchanged. While the
 * tree is still being read the destroy button waits, so a click cannot outrun the question.
 */
function SingleConfirm({
	phase,
	onOpenChange,
	onDestroy,
}: {
	phase: DestroyTreeState["phase"];
	onOpenChange: (open: boolean) => void;
	onDestroy: (options: { cascade: boolean }) => void;
}) {
	return (
		<>
			<AlertDialogHeader>
				<AlertDialogTitle>Destroy this environment?</AlertDialogTitle>
				<AlertDialogDescription>
					This queues a DESTROY job that tears down the environment&apos;s provisioned cloud
					infrastructure. This cannot be undone.
				</AlertDialogDescription>
			</AlertDialogHeader>
			{phase === "loading" && (
				<p className="text-ui-md text-muted-foreground">
					Checking whether other environments are placed on this environment&apos;s cluster…
				</p>
			)}
			{phase === "error" && (
				<p className="text-ui-md text-muted-foreground">
					Couldn&apos;t check whether other environments are placed on this environment&apos;s
					cluster. If any are, the destroy is refused and nothing is queued.
				</p>
			)}
			<AlertDialogFooter>
				<AlertDialogCancel>Cancel</AlertDialogCancel>
				<AlertDialogAction
					variant="destructive"
					disabled={phase === "loading"}
					onClick={() => {
						onOpenChange(false);
						onDestroy({ cascade: false });
					}}
				>
					Destroy environment
				</AlertDialogAction>
			</AlertDialogFooter>
		</>
	);
}

/**
 * Live tenants: the ordered list, any FAILED tenant called out, and the two choices. The cascade sits
 * behind typing `phrase` — a destroy that takes several environments with it should not be one
 * misplaced click away.
 */
function CascadeConfirm({
	tenants,
	target,
	phrase,
	phraseIsProject,
	onOpenChange,
	onDestroy,
	onChildrenFirst,
}: {
	tenants: DestroyTreeNode[];
	target: DestroyTreeNode;
	phrase: string;
	phraseIsProject: boolean;
	onOpenChange: (open: boolean) => void;
	onDestroy: (options: { cascade: boolean }) => void;
	onChildrenFirst: (tenants: DestroyTreeNode[]) => void;
}) {
	const total = tenants.length + 1;
	const others = tenants.length;
	const failed = tenants.filter((t) => t.status === "FAILED");
	const schema = useMemo(
		() =>
			z.object({
				confirmation: z
					.string()
					.refine((v) => v.trim() === phrase, `Type ${phrase} exactly to confirm`),
			}),
		[phrase],
	);
	const form = useForm<z.infer<typeof schema>>({
		resolver: zodResolver(schema),
		defaultValues: { confirmation: "" },
		mode: "onChange",
	});
	const typed = useWatch({ control: form.control, name: "confirmation" });
	const matches = schema.safeParse({ confirmation: typed }).success;

	/** The typed name matched: close, then queue every environment in the tree. */
	function onSubmit() {
		onOpenChange(false);
		onDestroy({ cascade: true });
	}

	return (
		<>
			<AlertDialogHeader>
				<AlertDialogTitle>Destroy {total} environments?</AlertDialogTitle>
				<AlertDialogDescription>
					{target.name} owns the cluster that {others} other{" "}
					{others === 1 ? "environment is" : "environments are"} placed on. Destroying it
					destroys {others === 1 ? "that environment" : "them"} too: every environment below
					is destroyed in this order, the cluster&apos;s owner last. This cannot be undone.
				</AlertDialogDescription>
			</AlertDialogHeader>

			<ol
				aria-label="Environments that will be destroyed, in order"
				className="divide-y divide-border border border-border"
			>
				{[...tenants, target].map((node, i) => (
					<li
						key={node.environment_id}
						className="flex items-center gap-3 px-3 py-2 text-ui-md"
					>
						<span className="w-4 shrink-0 font-mono text-ui-xs tabular-nums text-muted-foreground">
							{i + 1}
						</span>
						<span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
						<span className="shrink-0 text-ui-sm text-muted-foreground">
							{placementLabel(node)}
						</span>
						<StatusBadge status={node.status} className="shrink-0" />
					</li>
				))}
			</ol>

			{failed.length > 0 && (
				<Alert variant="destructive">
					<TriangleAlert />
					<AlertTitle>
						{joinNames(failed.map((t) => t.name))} failed {failed.length === 1 ? "its" : "their"}{" "}
						last run
					</AlertTitle>
					<AlertDescription>
						<p>
							{target.name}&apos;s destroy waits until every environment above is gone. If{" "}
							{failed.length === 1 ? "that destroy fails" : "one of those destroys fails"}{" "}
							again, {target.name}&apos;s stays queued: retry the failed environment&apos;s
							destroy from its own settings, or cancel {target.name}&apos;s destroy job.
						</p>
					</AlertDescription>
				</Alert>
			)}

			<Form {...form}>
				<form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
					<FormField
						control={form.control}
						name="confirmation"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-ui-md font-normal">
									<span>
										Type the {phraseIsProject ? "project" : "environment"} name,{" "}
										<span className="font-mono font-medium">{phrase}</span>, to destroy all{" "}
										{total}
									</span>
								</FormLabel>
								<FormControl>
									<Input autoComplete="off" spellCheck={false} {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onChildrenFirst(tenants)}>
							Destroy children first
						</AlertDialogCancel>
						<Button type="submit" variant="destructive" disabled={!matches}>
							Destroy all {total} environments
						</Button>
					</AlertDialogFooter>
				</form>
			</Form>
		</>
	);
}
