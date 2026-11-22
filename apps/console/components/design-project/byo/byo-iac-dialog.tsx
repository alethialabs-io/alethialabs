"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own IaC (E3) — the four-step attach flow (repository → path/ref → variables → review)
// opened from the canvas ⌘K "Sources" group. The repository step reuses the production
// RepositorySelector (the same git-provider auth / repo fetch the BYO Helm flow uses); the remaining
// steps collect the root-module path + git ref and the non-secret tfvars, then Review calls
// attachIacSourceAction — which pins a single project_iac_sources row per environment (v1 replace
// mode) and auto-queues the IAC_SCAN so provisioning can unlock.
//
// It runs on the shared wizard engine (`lib/wizard/`), as an overlay, exactly as ByoChartDialog does:
// open while the URL says `?wizard=byo-iac`, the step in `&step=<id>`, what was typed kept in the
// tab's draft so the return from linking a git provider lands on the same step with the same values,
// and a server field refusal taking the person to the step that shows the field.

import { type FormEvent, useEffect, useRef } from "react";
import { Controller, FormProvider, useFieldArray, useWatch } from "react-hook-form";
import { Boxes, Plus, Trash2 } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type StepperItem,
	Stepper,
	WizardFooter,
	WizardFormError,
	WizardRestoredNotice,
	WizardStepHeading,
} from "@repo/ui/wizard";
import { RepositorySelector } from "@/components/repository-selector";
import { attachIacSourceAction } from "@/app/server/actions/byo-iac";
import type { FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { WIZARD_PARAM } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import {
	IAC_VAR_KINDS,
	iacSourceFormSchema,
	toIacVarValues,
} from "@/lib/validations/byo-iac";
import { useWizardEnvironment, wizardOpener } from "@/lib/wizard/location";
import { useOpenRequest } from "@/lib/wizard/use-open-request";
import { useWizardEngine } from "@/lib/wizard/use-wizard";
import {
	BYO_IAC_WIZARD_ID,
	type ByoIacWizardOutput,
	type ByoIacWizardValues,
	byoIacWizard,
} from "@/components/design-project/byo/byo-iac.wizard";

interface ByoIacDialogProps {
	/** The canvas asks for the dialog. The URL (`?wizard=byo-iac`) is what keeps it open. */
	open: boolean;
	/** Told when the dialog opens or closes for a reason the canvas did not start (Back, a link). */
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a source is attached (the canvas re-fetches + re-renders the IaC overlay). */
	onAttached?: () => void;
}

// ── THE WORKED EXAMPLE ───────────────────────────────────────────────────────────────────────────
//
// The example a user reads is one they can paste and attach: a public repository holding real
// OpenTofu root modules, and the path of one of them. It used to be `acme/infra-tofu`, which 404s.
// `tests/components/design-project/byo/byo-iac-dialog.test.tsx` pins both values and refuses an
// `acme` example anywhere the dialog shows text.

/** A public repository of OpenTofu root modules. */
export const EXAMPLE_IAC_REPO_URL = "https://github.com/alethialabs-io/alethia-examples";

/** A root module in it: one cheap resource, no backend block (Alethia supplies the state). */
export const EXAMPLE_IAC_PATH = "iac/drift/aws";

// ── THE WIZARD ───────────────────────────────────────────────────────────────────────────────────
//
// The definition — steps, rules and draft — is `byo-iac.wizard.ts`. What is below is how this
// dialog shows it.

/** A fresh source: nothing typed, no variables. */
const DEFAULT_VALUES: ByoIacWizardValues = { repo_url: "", path: "", ref: "", variables: [] };

/** The step rail's accessible name. */
const STEPPER_LABEL = "Attach an IaC source";

/** The heading and one line of copy each step opens with. */
interface StepCopy {
	readonly title: string;
	readonly description: string;
}

/** Each step's heading, by step id. */
const STEP_COPY: Readonly<Record<string, StepCopy>> = {
	repository: { title: "Module repository", description: "The git repository that holds the OpenTofu root module." },
	"path-ref": { title: "Path and ref", description: "Where the root module is, and which revision to scan." },
	variables: { title: "Variables", description: "Non-secret tfvars the module is planned with." },
	review: { title: "Review", description: "Check the source, then attach it." },
};

/** What a step without its own copy would show; never reached while every step id is above. */
const FALLBACK_COPY: StepCopy = { title: "Attach an IaC source", description: "" };

/** The rail before the draft is read: the first step current, the rest not started. */
const FIRST_STEP_ITEMS: readonly StepperItem[] = byoIacWizard.steps.map((step, index) => ({
	id: step.id,
	label: step.label,
	state: index === 0 ? "current" : "todo",
}));

/** Where a refusal that names no field is filed: no step owns it, so the engine says it above the buttons. */
const FORM_LEVEL_KEY = "_form";

/** What the Variables step says after a restored draft: variables are the one thing it drops. */
export const VARIABLES_NOT_KEPT = "Variables are not kept across a reload. Add them again.";

/** The action's input keys, as the wizard field that shows each one. */
const SERVER_FIELD: Readonly<Record<string, string>> = {
	repoUrl: "repo_url",
	varValues: "variables",
};

/** A server's field refusals, keyed by the wizard field that shows each one. */
function toWizardFieldErrors(fields: FieldErrors): FieldErrors {
	const mapped: FieldErrors = {};
	for (const [key, messages] of Object.entries(fields)) {
		const field = SERVER_FIELD[key] ?? key;
		mapped[field] = [...(mapped[field] ?? []), ...(messages ?? [])];
	}
	return mapped;
}

/**
 * Each variable row's messages, by `<row>.<field>`, for the rows as they stand. The engine files a
 * Variables failure on the `variables` field as a whole; this says which row and which box.
 */
function variableRowMessages(variables: ByoIacWizardValues["variables"]): ReadonlyMap<string, string> {
	const parsed = iacSourceFormSchema.shape.variables.safeParse(variables);
	const messages = new Map<string, string>();
	if (parsed.success) return messages;
	for (const issue of parsed.error.issues) {
		const key = issue.path.map(String).join(".");
		if (!messages.has(key)) messages.set(key, issue.message);
	}
	return messages;
}

/** The "attach an IaC source" dialog: open while the URL names it, its wizard mounted only while open. */
export function ByoIacDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoIacDialogProps) {
	const env = useWizardEnvironment();
	const opener = wizardOpener(env.location, BYO_IAC_WIZARD_ID);
	// Opening drops the canvas's one-shot `?attachIac=1`, which would otherwise be read again and
	// strip the URL the dialog just opened.
	useOpenRequest(open, onOpenChange, opener, () =>
		env.location.push({ [WIZARD_PARAM]: BYO_IAC_WIZARD_ID, attachIac: null }),
	);

	return (
		<Dialog open={opener.open} onOpenChange={opener.setOpen}>
			<DialogContent className="sm:max-w-[560px]">
				{opener.open ? (
					<ByoIacWizard
						projectId={projectId}
						environmentId={environmentId}
						onAttached={onAttached}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** The dialog's header. */
function ByoIacHeader() {
	return (
		<DialogHeader>
			<DialogTitle className="flex items-center gap-2">
				<Boxes className="h-4 w-4 text-muted-foreground" />
				Bring your own IaC
			</DialogTitle>
			<DialogDescription>
				Point this environment at a git repo holding an OpenTofu root module — Alethia plans,
				verifies, and applies it instead of the built-in template (replace mode).
			</DialogDescription>
		</DialogHeader>
	);
}

/** The steps' frame. A fixed minimum height, so the footer does not move between steps. */
const STEP_BODY = "flex min-h-[260px] flex-col gap-3 py-2";

/** The wizard inside the dialog, while it is open. */
function ByoIacWizard({
	projectId,
	environmentId,
	onAttached,
}: Omit<ByoIacDialogProps, "open" | "onOpenChange">) {
	const env = useWizardEnvironment();
	// The wizard calls this when every step passes; it is pointed at the mutation after each render.
	const attachSource = useRef<(values: ByoIacWizardOutput) => void>(() => undefined);

	const wizard = useWizardEngine<ByoIacWizardValues, ByoIacWizardOutput>(
		byoIacWizard,
		{
			defaultValues: DEFAULT_VALUES,
			scope: `${projectId}:${environmentId ?? "default"}`,
			onSubmit: (values) => attachSource.current(values),
		},
		env,
	);
	const { control, register, formState } = wizard.form;
	const { errors } = formState;
	const { fields, append, remove } = useFieldArray({ control, name: "variables" });

	// The attach, on the mutation contract: pending while in flight (the double-submit guard), a
	// field refusal routed to its step, a refusal ("detach it before attaching another") said above
	// the buttons, and the source card plus the module's cards on the board (they ride on the
	// environment status) re-read when it settles.
	const attach = useActionMutation(attachIacSourceAction, {
		invalidates: [orpc.canvas.iacSource.key(), orpc.canvas.environmentStatus.key()],
		onValidationError: (fieldErrors) => wizard.applyFieldErrors(toWizardFieldErrors(fieldErrors)),
		onRefusal: (error) => wizard.applyFieldErrors({ [FORM_LEVEL_KEY]: [error.message] }),
		successMessage: "IaC source attached — scanning the module now.",
		onSuccess: () => {
			// The attach auto-queues the IAC_SCAN (best-effort) — no explicit scan call needed.
			wizard.complete();
			onAttached?.();
		},
	});

	useEffect(() => {
		attachSource.current = (values) =>
			attach.submit({
				projectId,
				environmentId,
				repoUrl: values.repo_url.trim(),
				ref: values.ref?.trim() ? values.ref.trim() : null,
				path: values.path?.trim() ?? "",
				varValues: toIacVarValues(values.variables),
			});
	});

	const [repoUrl, path, ref, variables] = useWatch({
		control,
		name: ["repo_url", "path", "ref", "variables"],
	});

	if (!wizard.ready) return <ByoIacWizardSkeleton />;

	const step = wizard.current.id;
	const copy = STEP_COPY[step] ?? FALLBACK_COPY;
	const pending = attach.isPending;
	const effectiveRef = ref?.trim() || "HEAD";
	const effectivePath = path?.trim().replace(/^\/+|\/+$/g, "") || "(repo root)";
	const varCount = fields.length;
	// Row messages only once a Variables check has failed, so a half-typed row is not scolded.
	const rowMessages = errors.variables ? variableRowMessages(variables) : null;

	/** Enter in a field means "go on": Next before Review, Attach on it. */
	function onEnter(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		void (wizard.isLast ? wizard.submit() : wizard.next());
	}

	return (
		<FormProvider {...wizard.form}>
			<ByoIacHeader />
			<Stepper label={STEPPER_LABEL} items={wizard.items} onSelect={wizard.goTo} />
			{wizard.restored ? <WizardRestoredNotice onStartOver={wizard.discard} /> : null}
			<form onSubmit={onEnter} noValidate className="flex flex-col gap-4">
				<div className={STEP_BODY}>
					<WizardStepHeading
						title={copy.title}
						description={copy.description}
						position={wizard.stepNumber}
						total={wizard.stepCount}
						level={3}
					/>

					{step === "repository" ? (
						<>
							<Controller
								control={control}
								name="repo_url"
								render={({ field }) => (
									<RepositorySelector
										value={field.value}
										onChange={field.onChange}
										label="Module repository"
										placeholder={EXAMPLE_IAC_REPO_URL}
										required
									/>
								)}
							/>
							{errors.repo_url ? (
								<p role="alert" className="text-xs text-destructive">
									{errors.repo_url.message}
								</p>
							) : null}
							<p className="text-xs text-muted-foreground">
								From the git providers you&apos;ve linked. No provider yet? The selector offers a
								connect step and brings you back here with what you typed.
							</p>
							<p className="text-xs text-muted-foreground">
								No module of your own yet? Switch the selector to manual entry and paste{" "}
								<code>{EXAMPLE_IAC_REPO_URL}</code>, with the root module at{" "}
								<code>{EXAMPLE_IAC_PATH}</code>.
							</p>
						</>
					) : null}

					{step === "path-ref" ? (
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="byo-iac-path">Root-module path</Label>
								<Input
									id="byo-iac-path"
									{...register("path")}
									placeholder={`${EXAMPLE_IAC_PATH} (default: repo root)`}
									className="font-mono"
									aria-invalid={errors.path ? true : undefined}
									autoFocus
								/>
								{errors.path ? (
									<p role="alert" className="text-xs text-destructive">
										{errors.path.message}
									</p>
								) : (
									<p className="text-xs text-muted-foreground">
										The directory inside the repo that holds the root <code>*.tf</code>. Leave blank
										for the repo root.
									</p>
								)}
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="byo-iac-ref">Git ref (optional)</Label>
								<Input
									id="byo-iac-ref"
									{...register("ref")}
									placeholder="main (default: HEAD)"
									className="font-mono"
									aria-invalid={errors.ref ? true : undefined}
								/>
								{errors.ref ? (
									<p role="alert" className="text-xs text-destructive">
										{errors.ref.message}
									</p>
								) : (
									<p className="text-xs text-muted-foreground">
										Branch, tag, or commit the scan pins. Leave blank for <code>HEAD</code>.
									</p>
								)}
							</div>
						</div>
					) : null}

					{step === "variables" ? (
						<>
							<div className="flex items-center justify-between">
								<Label>Variables (non-secret tfvars)</Label>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="h-7 gap-1.5 text-xs"
									onClick={() => append({ key: "", kind: "string", value: "" })}
								>
									<Plus className="h-3.5 w-3.5" /> Add
								</Button>
							</div>
							{wizard.restored && fields.length === 0 ? (
								<p className="text-xs text-muted-foreground">{VARIABLES_NOT_KEPT}</p>
							) : null}
							{fields.length === 0 ? (
								<EmptyState
									className="border px-3 py-6 md:px-3 md:py-6"
									title="No variables"
									description="The module runs with its own defaults."
								/>
							) : (
								<div className="flex flex-col gap-2">
									{fields.map((f, i) => {
										const keyMessage = rowMessages?.get(`${i}.key`);
										const valueMessage = rowMessages?.get(`${i}.value`);
										return (
											<div key={f.id} className="flex items-start gap-2">
												<div className="flex-1">
													<Input
														{...register(`variables.${i}.key`)}
														placeholder="region"
														className="font-mono text-xs"
														aria-label={`Variable ${i + 1} name`}
														aria-invalid={keyMessage ? true : undefined}
													/>
													{keyMessage ? (
														<p role="alert" className="mt-1 text-ui-xs text-destructive">
															{keyMessage}
														</p>
													) : null}
												</div>
												<Controller
													control={control}
													name={`variables.${i}.kind`}
													render={({ field }) => (
														<Select value={field.value} onValueChange={field.onChange}>
															<SelectTrigger
																className="w-[92px] font-mono text-xs"
																aria-label={`Variable ${i + 1} type`}
															>
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{IAC_VAR_KINDS.map((k) => (
																	<SelectItem key={k} value={k} className="font-mono text-xs">
																		{k}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													)}
												/>
												<div className="flex-1">
													<Input
														{...register(`variables.${i}.value`)}
														placeholder="us-east-1"
														className="font-mono text-xs"
														aria-label={`Variable ${i + 1} value`}
														aria-invalid={valueMessage ? true : undefined}
													/>
													{valueMessage ? (
														<p role="alert" className="mt-1 text-ui-xs text-destructive">
															{valueMessage}
														</p>
													) : null}
												</div>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
													onClick={() => remove(i)}
													aria-label={`Remove variable ${i + 1}`}
												>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
											</div>
										);
									})}
								</div>
							)}
							<p className="text-xs text-muted-foreground">
								Scalar values only (string / number / bool). Secrets belong in your cloud&apos;s
								secret store or the module&apos;s own data sources — never here.
							</p>
						</>
					) : null}

					{step === "review" ? (
						<>
							<div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-ui-xs text-muted-foreground">
								<div className="text-foreground">
									{repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "") || "—"}
								</div>
								<div>
									path {effectivePath} · ref {effectiveRef}
								</div>
								<div>
									{varCount} variable{varCount === 1 ? "" : "s"} · replace mode · scan on attach
								</div>
							</div>
							<p className="text-xs text-muted-foreground">
								Attaching queues a safety scan of the module. This environment&apos;s components are
								then governed by the module — the built-in template no longer applies.
							</p>
						</>
					) : null}

					<WizardFormError message={wizard.formError} />
				</div>

				<WizardFooter
					back={wizard.stepNumber > 1 ? wizard.back : null}
					primary={
						wizard.isLast
							? { kind: "submit", label: "Attach source", onPress: () => void wizard.submit() }
							: { kind: "next", label: "Next", onPress: () => void wizard.next() }
					}
					pending={pending}
				/>
			</form>
		</FormProvider>
	);
}

/** The dialog while the wizard reads its draft: the header, the rail and the step's frame. */
function ByoIacWizardSkeleton() {
	return (
		<div aria-busy="true" className="flex flex-col gap-4">
			<ByoIacHeader />
			<Stepper label={STEPPER_LABEL} items={FIRST_STEP_ITEMS} />
			<div className={STEP_BODY}>
				<Skeleton className="h-5 w-40" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-4 w-3/4" />
			</div>
			<div className="flex items-center justify-end">
				<Skeleton className="h-9 w-20" />
			</div>
		</div>
	);
}
