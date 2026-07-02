"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules editor. Each gate is individually toggleable; evaluated when a
// promotion into this environment is planned (lib/promotions/gates.ts).

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { type Control, Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { getProtectionRules, setProtectionRules } from "@/app/server/actions/protection";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";

const rulesSchema = z.object({
	require_predecessor: z.boolean(),
	require_verify_pass: z.boolean(),
	require_approval: z.boolean(),
	min_count: z.number().int().min(1).max(10),
	soak_minutes: z.number().int().min(0).nullable(),
	cost_delta_threshold: z.number().min(0).nullable(),
});
type RulesForm = z.infer<typeof rulesSchema>;

const DEFAULTS: RulesForm = {
	require_predecessor: false,
	require_verify_pass: false,
	require_approval: false,
	min_count: 1,
	soak_minutes: null,
	cost_delta_threshold: null,
};

/** Editor dialog for one environment's promotion protection rules. */
export function ProtectionRulesDialog({
	open,
	onOpenChange,
	projectId,
	envId,
	envName,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	projectId: string;
	envId: string;
	envName: string;
}) {
	const { control, handleSubmit, reset, watch, formState } = useForm<RulesForm>({
		resolver: zodResolver(rulesSchema),
		defaultValues: DEFAULTS,
	});

	// Load current rules when the dialog opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		getProtectionRules(projectId, envId)
			.then((row) => {
				if (cancelled) return;
				reset(
					row
						? {
								require_predecessor: row.require_predecessor,
								require_verify_pass: row.require_verify_pass,
								require_approval: row.require_approval,
								min_count: row.approvers?.min_count ?? 1,
								soak_minutes: row.soak_minutes,
								cost_delta_threshold: row.cost_delta_threshold,
							}
						: DEFAULTS,
				);
			})
			.catch(() => toast.error("Failed to load protection rules"));
		return () => {
			cancelled = true;
		};
	}, [open, projectId, envId, reset]);

	const requireApproval = watch("require_approval");

	const onSubmit = handleSubmit(async (values) => {
		try {
			await setProtectionRules(projectId, envId, {
				require_predecessor: values.require_predecessor,
				require_verify_pass: values.require_verify_pass,
				require_approval: values.require_approval,
				approvers: { user_ids: [], role: null, min_count: values.min_count },
				soak_minutes: values.soak_minutes,
				cost_delta_threshold: values.cost_delta_threshold,
			});
			toast.success("Protection rules saved");
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save rules");
		}
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Protection rules · {envName}</DialogTitle>
					<DialogDescription>
						Gates a promotion must clear before it deploys into this environment.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={onSubmit} className="space-y-3">
					<ToggleRow
						control={control}
						name="require_predecessor"
						title="Require predecessor"
						desc="A lower environment must have deployed this design and be in sync."
					/>
					<ToggleRow
						control={control}
						name="require_verify_pass"
						title="Require verify pass"
						desc="The plan's elench report must have no unwaived hard failures."
					/>
					<ToggleRow
						control={control}
						name="require_approval"
						title="Require approval"
						desc="A reviewer must approve before the deploy runs."
					/>
					{requireApproval && (
						<div className="flex items-center justify-between pl-3">
							<label className="text-xs text-muted-foreground">Approvals required</label>
							<Controller
								control={control}
								name="min_count"
								render={({ field }) => (
									<Input
										type="number"
										min={1}
										max={10}
										className="h-8 w-20 text-sm"
										value={field.value}
										onChange={(e) =>
											field.onChange(e.target.value === "" ? 1 : Number(e.target.value))
										}
									/>
								)}
							/>
						</div>
					)}

					<NumberRow
						control={control}
						name="soak_minutes"
						title="Soak timer (min)"
						desc="Wait this long after the predecessor deploy. Blank = off."
					/>
					<NumberRow
						control={control}
						name="cost_delta_threshold"
						title="Cost threshold ($/mo)"
						desc="Cost increases above this need approval. Blank = off."
					/>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={formState.isSubmitting}>
							{formState.isSubmitting ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
								</>
							) : (
								"Save"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A labelled boolean gate toggle bound to the form. */
function ToggleRow({
	control,
	name,
	title,
	desc,
}: {
	control: Control<RulesForm>;
	name: "require_predecessor" | "require_verify_pass" | "require_approval";
	title: string;
	desc: string;
}) {
	return (
		<label className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5">
			<span className="min-w-0 text-sm">
				{title}
				<span className="block text-[11px] text-muted-foreground">{desc}</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Switch checked={field.value} onCheckedChange={field.onChange} />
				)}
			/>
		</label>
	);
}

/** A nullable-number gate input bound to the form (blank = null = off). */
function NumberRow({
	control,
	name,
	title,
	desc,
}: {
	control: Control<RulesForm>;
	name: "soak_minutes" | "cost_delta_threshold";
	title: string;
	desc: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5">
			<span className="min-w-0 text-sm">
				{title}
				<span className="block text-[11px] text-muted-foreground">{desc}</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Input
						type="number"
						min={0}
						placeholder="off"
						className="h-8 w-24 text-sm"
						value={field.value ?? ""}
						onChange={(e) =>
							field.onChange(e.target.value === "" ? null : Number(e.target.value))
						}
					/>
				)}
			/>
		</div>
	);
}
