"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules editor, as a right-side drawer. Each gate is individually
// toggleable; evaluated when a promotion into this environment is planned (lib/promotions/gates.ts).
//
// EVERY GATE CONTROL IN HERE IS NAMED BY THE TEXT ALREADY BESIDE IT, AND THE ROWS ARE `<div>`s.
//
// They used to be `<label>`s wrapping their text and their control, on the assumption that implicit
// label association would do the naming. It cannot: implicit association reaches a LABELABLE
// element only, and `@repo/ui/switch` is base-ui, which renders a `<span role="switch">`. So the
// three gates reached a screen reader as three identical unnamed switches, and
// `getByRole("switch", { name: … })` matched nothing — which is how the defect was found, by an
// e2e lane whose click hung to the 180s timeout (#4630).
//
// An `id`/`htmlFor` pair is NOT the fix and is worth saying out loud, because it is the obvious
// one: `htmlFor` is the explicit half of the same mechanism and is equally inert against a
// `<span>`. The name has to be authored — `aria-labelledby` pointing at the rendered title.
// That is the shape `PermissionRow` in components/settings/roles/permission-matrix.tsx already
// uses, and this file follows it rather than inventing a second one.

//
// THE READ AND THE WRITE (#6120, ADR 0005). The rules are the `environments.protectionRules` GET
// procedure, read when the drawer opens; the form is reset from them once they land, and the form
// is not editable before then — so a save can never send the defaults over rules it never saw. The
// save is `setProtectionRules` through `useActionMutation`: pending + double-submit guard, field
// errors onto the fields, and the page's read invalidated so the env card's gate chips update.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { type Control, Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { setProtectionRules } from "@/app/server/actions/protection";
import { RegionError } from "@/components/errors/region-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
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

/** The server's field paths (the action's input) mapped onto this form's fields. */
const FIELD_OF_PATH: Record<string, keyof RulesForm | undefined> = {
	"rules.require_predecessor": "require_predecessor",
	"rules.require_verify_pass": "require_verify_pass",
	"rules.require_approval": "require_approval",
	"rules.approvers.min_count": "min_count",
	"rules.soak_minutes": "soak_minutes",
	"rules.cost_delta_threshold": "cost_delta_threshold",
};

const DEFAULTS: RulesForm = {
	require_predecessor: false,
	require_verify_pass: false,
	require_approval: false,
	min_count: 1,
	soak_minutes: null,
	cost_delta_threshold: null,
};

/** Drawer editor for one environment's promotion protection rules. */
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
	const minCountLabelId = useId();
	const { control, handleSubmit, reset, watch, setError } = useForm<RulesForm>({
		resolver: zodResolver(rulesSchema),
		defaultValues: DEFAULTS,
	});

	const rulesQuery = useQuery({
		...orpc.environments.protectionRules.queryOptions({
			input: { projectId, environmentId: envId },
		}),
		enabled: open,
	});
	const loaded = rulesQuery.data;

	// Seed the form from the stored rules ONCE, when they first land. A live update while the drawer
	// is open refreshes the read but does not reset the form: that would discard what the person is
	// in the middle of editing. The drawer mounts per open, so each open seeds afresh.
	const seeded = useRef(false);
	useEffect(() => {
		if (!loaded || seeded.current) return;
		seeded.current = true;
		const row = loaded.rules;
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
	}, [loaded, reset]);

	const requireApproval = watch("require_approval");

	const save = useActionMutation(setProtectionRules, {
		// The rules editor's own read, and the page's (the env card's "gates into this env" chips).
		invalidates: [orpc.environments.key()],
		successMessage: "Protection rules saved",
		onValidationError: (fields) => {
			for (const [path, messages] of Object.entries(fields)) {
				const message = messages?.[0];
				if (!message) continue;
				const field = FIELD_OF_PATH[path];
				if (field) setError(field, { message });
			}
		},
		onSuccess: () => onOpenChange(false),
	});

	const onSubmit = handleSubmit((values) => {
		if (save.isPending) return;
		save.mutate({
			projectId,
			environmentId: envId,
			rules: {
				require_predecessor: values.require_predecessor,
				require_verify_pass: values.require_verify_pass,
				require_approval: values.require_approval,
				approvers: { user_ids: [], role: null, min_count: values.min_count },
				soak_minutes: values.soak_minutes,
				cost_delta_threshold: values.cost_delta_threshold,
			},
		});
	});

	// The form is only editable once the stored rules are in it.
	const ready = !!loaded;
	const failed = rulesQuery.isError && !loaded;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[min(420px,92vw)] gap-0 p-0 sm:max-w-none"
			>
				<form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
					{/* header */}
					<div className="flex items-start justify-between gap-3 border-b px-[22px] py-5">
						<div>
							<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
								Protection rules
							</div>
							<div className="mt-1.5 font-mono text-ui-xl text-text-primary">
								{envName}
							</div>
							<p className="mt-2 max-w-[40ch] text-ui-sm text-text-tertiary">
								Gates a promotion must clear before it deploys into this environment.
							</p>
						</div>
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							aria-label="Close"
							className="grid size-8 shrink-0 place-items-center rounded-sm text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
						>
							<X className="size-4" />
						</button>
					</div>

					{/* rules — a failed read is its own render, never the defaults shown as if stored */}
					{failed ? (
						<div className="flex-1 px-[22px] py-[18px]">
							<RegionError
								title="Couldn't load the protection rules"
								description="The rules for this environment failed to load."
								onRetry={() => void rulesQuery.refetch()}
							/>
						</div>
					) : !ready ? (
						// Not editable before the stored rules are in the form: a toggle flipped now
						// would be overwritten when they land, and a save would send the defaults.
						<div
							className="flex flex-1 flex-col gap-3 px-[22px] py-[18px]"
							aria-busy
							data-state="pending"
						>
							{[0, 1, 2, 3, 4].map((i) => (
								<Skeleton key={i} className="h-[62px] w-full rounded-lg" />
							))}
						</div>
					) : (
						<div className="flex flex-1 flex-col gap-3 overflow-y-auto px-[22px] py-[18px]">
							<ToggleRow
								control={control}
								name="require_predecessor"
								title="Require predecessor"
								desc="The lower environment must have deployed this design and be in sync."
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
								<div className="flex items-center justify-between gap-3 pl-[26px] pr-3.5">
									<span id={minCountLabelId} className="text-ui-sm text-text-secondary">
										Approvals required
									</span>
									<Controller
										control={control}
										name="min_count"
										render={({ field, fieldState }) => (
											<Input
												type="number"
												min={1}
												max={10}
												aria-labelledby={minCountLabelId}
												aria-invalid={fieldState.error ? true : undefined}
												className="h-[34px] w-[84px] text-sm"
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
								desc="Minutes to wait after the predecessor deploy. Blank = off."
							/>
							<NumberRow
								control={control}
								name="cost_delta_threshold"
								title="Cost threshold ($/mo)"
								desc="Cost increases above this force approval. Blank = off."
							/>
						</div>
					)}

					{/* footer */}
					<div className="flex justify-end gap-2 border-t px-[22px] py-4">
						<Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button type="submit" size="sm" disabled={!ready || save.isPending}>
							{save.isPending && <Loader2 className="size-3.5 animate-spin" />}
							Save rules
						</Button>
					</div>
				</form>
			</SheetContent>
		</Sheet>
	);
}

/**
 * A named boolean gate toggle bound to the form.
 *
 * The switch takes its accessible name from the row's title, and the sentence under it is the
 * switch's DESCRIPTION rather than a second `aria-labelledby` id: a whole sentence read out as a
 * control's name is not a name. Ids come from `useId`, so two drawers rendered at once cannot
 * point every switch at the first one's title.
 */
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
	const titleId = useId();
	const descId = useId();
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3">
			<span className="min-w-0">
				<span id={titleId} className="text-ui-md font-medium text-text-primary">
					{title}
				</span>
				<span id={descId} className="mt-0.5 block text-ui-xs text-text-tertiary">
					{desc}
				</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Switch
						aria-labelledby={titleId}
						aria-describedby={descId}
						checked={field.value}
						onCheckedChange={field.onChange}
					/>
				)}
			/>
		</div>
	);
}

/**
 * A named nullable-number gate input bound to the form (blank = null = off).
 *
 * `<Input>` IS a labelable element, so an `htmlFor` pair would have worked here — but these two
 * rows sat in the same drawer as the three unnamed switches and were unnamed for the plainer
 * reason that nothing named them at all. They are given the same `aria-labelledby` shape as
 * `ToggleRow` so one drawer names its controls one way.
 */
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
	const titleId = useId();
	const descId = useId();
	const errorId = useId();
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3">
			<span className="min-w-0">
				<span id={titleId} className="text-ui-md font-medium text-text-primary">
					{title}
				</span>
				<span id={descId} className="mt-0.5 block text-ui-xs text-text-tertiary">
					{desc}
				</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field, fieldState }) => (
					<span className="flex flex-col items-end gap-1">
						<Input
							type="number"
							min={0}
							placeholder="off"
							aria-labelledby={titleId}
							aria-describedby={fieldState.error ? `${descId} ${errorId}` : descId}
							aria-invalid={fieldState.error ? true : undefined}
							className="h-[34px] w-[92px] font-mono text-sm"
							value={field.value ?? ""}
							onChange={(e) =>
								field.onChange(e.target.value === "" ? null : Number(e.target.value))
							}
						/>
						{fieldState.error?.message ? (
							<span id={errorId} role="alert" className="text-ui-xs text-destructive">
								{fieldState.error.message}
							</span>
						) : null}
					</span>
				)}
			/>
		</div>
	);
}
