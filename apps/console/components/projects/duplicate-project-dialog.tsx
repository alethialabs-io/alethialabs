"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-cloud "Quick Duplicate" dialog. Copies a project's design onto another cloud, translating
// every provider-specific value (region, instance types, DB engines, cache nodes, …) via
// `convertProjectConfig` server-side and surfacing the conversion notes. The new project is created
// in DRAFT so nothing is provisioned until the user reviews it in the canvas ("duplicate & edit").
//
// THE NAME IS A FIELD, not a derivation the user only finds out about afterwards (#4162). It is
// pre-filled with what the server would have derived — `${source} (${target})`, de-duplicated — so
// the common case is still pick-account, pick-region, click. The field exists because that
// derivation can produce a name no project may carry: the suffix is 6–10 characters against
// `PROJECT_NAME_MAX_LENGTH` (100), a bound `createProject` has ENFORCED since #4738, so a project
// whose own name is 95 characters (91 onto Alibaba) had become impossible to duplicate at all and
// the dialog offered nothing to fix it with.

import {
	ArrowRight,
	CircleAlert,
	CircleX,
	Info,
	Loader2,
} from "lucide-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { getProvider, isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { tryDuplicateProjectForProvider } from "@/app/server/actions/projects";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import type { ConversionWarning } from "@/lib/cloud-providers";
import { groupRegions, REGION_LABELS } from "@/lib/cloud-providers";
import {
	type CloudProviderMeta,
	type CloudProviderSlug,
	PROVIDERS,
} from "@/lib/cloud-providers/generated/catalog";
import { errorDigest } from "@/lib/errors";
import { projectHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import type { DuplicateCategory } from "@/lib/rpc/procedures/projects";
import { canSlugify } from "@/lib/utils/slugify";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/validations/project-form.schema";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { ScrollArea } from "@repo/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";

/**
 * The form's shape. SHAPE ONLY — nothing here asks whether the org already holds the name.
 *
 * The three `projectName` rules are the schema's three, written the way `updateProjectName` and the
 * Configure screen already write them: the predicate is `canSlugify` itself and the bound is
 * `PROJECT_NAME_MAX_LENGTH` interpolated, so widening the rule in
 * `lib/validations/project-form.schema.ts` moves this with it rather than leaving a second opinion
 * behind. `createProject` re-asks all three server-side (#4738); these answer without a round trip.
 *
 * UNIQUENESS IS DELIBERATELY ABSENT. The org's taken names are a server-side read, the winner of a
 * race is decided by `projects_org_id_project_name_key` and not by anything the client saw, and the
 * slug is derived and de-duplicated independently of the display name. A client-side uniqueness
 * check would therefore be a second source of truth that drifts within one open dialog — so the
 * refusal comes back from the action as a value and is attached to this field by `setError`.
 */
const duplicateFormSchema = z.object({
	projectName: z
		.string()
		.trim()
		.min(1, "A project name is required")
		.max(
			PROJECT_NAME_MAX_LENGTH,
			`Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
		)
		.refine((v) => canSlugify(v), "Enter at least one letter or number"),
	cloudIdentityId: z.string().min(1, "Select a cloud account"),
	region: z.string().min(1, "Select a region"),
});

type DuplicateFormValues = z.infer<typeof duplicateFormSchema>;

/** Maps a design category to its label + the provider-metadata field naming that cloud's service. */
const CATEGORY_SERVICE: Record<
	DuplicateCategory,
	{ label: string; field: keyof CloudProviderMeta }
> = {
	network: { label: "Network", field: "networkName" },
	cluster: { label: "Kubernetes", field: "clusterService" },
	dns: { label: "DNS", field: "dnsService" },
	databases: { label: "Database", field: "dbService" },
	caches: { label: "Cache", field: "cacheService" },
	nosql: { label: "NoSQL", field: "nosqlService" },
	queues: { label: "Queue", field: "queueService" },
	topics: { label: "Topic", field: "topicService" },
	secrets: { label: "Secrets", field: "secretsService" },
};

/** Grayscale severity treatment — icon + mono label, `destructive` reserved for hard errors. */
const SEVERITY_META = {
	error: { icon: CircleX, label: "ERROR", tone: "text-destructive" },
	warning: { icon: CircleAlert, label: "REVIEW", tone: "text-foreground" },
	info: { icon: Info, label: "NOTE", tone: "text-muted-foreground" },
} as const;

interface DuplicateResult {
	newProjectSlug: string;
	warnings: ConversionWarning[];
}

/** What the duplicate mutation is handed: the source project and the submitted form. */
interface DuplicateVariables {
	sourceProjectId: string;
	values: DuplicateFormValues;
}

/**
 * `tryDuplicateProjectForProvider` in the mutation contract's shape (ADR 0005 D4). Its refusals are
 * sentences about the NAME (taken, or no schema accepts it) or about a stored credential, all shown
 * beside the name field — so they travel as a `validation` error on `projectName` and reach the
 * field, not a toast. A failure thrown out of the `"use server"` export is a digest in a production
 * build; it becomes `unexpected`, toasted once with that digest as its reference.
 */
async function duplicateAction({
	sourceProjectId,
	values,
}: DuplicateVariables): Promise<ActionResult<DuplicateResult>> {
	try {
		// `tryDuplicateProjectForProvider`, not `duplicateProjectForProvider`: a THROWN refusal is
		// redacted to an opaque `digest` in a production build — the #4644 defect.
		const res = await tryDuplicateProjectForProvider(
			sourceProjectId,
			values.cloudIdentityId,
			values.region,
			values.projectName,
		);
		if (!res.ok) {
			return {
				ok: false,
				error: { kind: "validation", message: res.error, fields: { projectName: [res.error] } },
			};
		}
		return { ok: true, data: { newProjectSlug: res.newProjectSlug, warnings: res.warnings } };
	} catch (err) {
		return { ok: false, error: { kind: "unexpected", ref: errorDigest(err) ?? "unavailable" } };
	}
}

/**
 * Dialog for duplicating a project onto a different cloud provider. `sourceProjectId` /
 * `sourceProjectName` identify the project being copied; `orgSlug` is used to navigate into the new
 * project's canvas on success.
 */
export function DuplicateProjectDialog(props: DuplicateProjectDialogProps) {
	// Mounted only while open: the dialog's read (and its query client) belongs to the open dialog,
	// so a project card or table row that merely CAN open it reads nothing and needs no provider —
	// and every open starts from a fresh form.
	return props.open ? <OpenDuplicateProjectDialog {...props} /> : null;
}

/** {@link DuplicateProjectDialog}'s props. */
interface DuplicateProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sourceProjectId: string;
	sourceProjectName: string;
	orgSlug: string;
}

/** The dialog itself, while it is open. */
function OpenDuplicateProjectDialog({
	open,
	onOpenChange,
	sourceProjectId,
	sourceProjectName,
	orgSlug,
}: DuplicateProjectDialogProps) {
	const router = useRouter();

	// The source's design summary, the per-cloud default names and the target accounts — ONE GET
	// read (`projects.duplicateTargets`), made when the dialog opens. It used to be two server
	// actions in an effect, queued as POSTs behind every other action on the page, with a failure
	// reported only as a toast over a dialog that then said "No other-cloud accounts connected".
	const targets = useQuery({
		...orpc.projects.duplicateTargets.queryOptions({ input: { projectId: sourceProjectId } }),
		enabled: open,
		// An expected refusal (the project is gone, or not this viewer's to read) answers the same
		// the second time: no retry for it, and its own sentence below — not "try again".
		retry: retryUnlessRefused,
	});
	const targetsRefusal = targets.isError ? refusalOf(targets.error) : null;
	const sourceProvider = targets.data?.provider ?? null;
	const categories: DuplicateCategory[] = targets.data?.categories ?? [];
	const identities = targets.data?.identities ?? [];
	// The server's default name PER TARGET CLOUD, because the suffix names that cloud. Empty until
	// the read lands; the name field is pre-filled from it when an account is chosen.
	const suggestedNames: Partial<Record<CloudProviderSlug, string>> =
		targets.data?.suggestedNames ?? {};
	const loadingContext = open && targets.isPending;
	const [result, setResult] = useState<DuplicateResult | null>(null);

	const form = useForm<DuplicateFormValues>({
		resolver: zodResolver(duplicateFormSchema),
		defaultValues: { projectName: "", cloudIdentityId: "", region: "" },
		mode: "onChange",
	});
	// Read during render so react-hook-form's proxy actually subscribes this component to them —
	// `form.formState.x` inside a callback alone does not.
	const { dirtyFields, isSubmitting } = form.formState;
	const cloudIdentityId = form.watch("cloudIdentityId");
	const region = form.watch("region");

	/** Resets every field to its initial state (on close + after a successful duplicate). */
	const reset = useCallback(() => {
		form.reset({ projectName: "", cloudIdentityId: "", region: "" });
		setResult(null);
	}, [form]);

	// Every open starts from a clean form.
	useEffect(() => {
		if (open) reset();
	}, [open, reset]);

	// A clone is a new project: every read of the org's projects moves with it — the shell's list
	// (switcher, breadcrumbs, palette; F036), the setup guide, the usage counts, and the reads that
	// answer against the org's project names.
	const duplicate = useActionMutation(duplicateAction, {
		invalidates: [
			orpc.workspace.projects.key(),
			orpc.workspace.setupGuide.key(),
			orpc.usage.resources.key(),
			orpc.projects.nameAvailability.key(),
			orpc.projects.duplicateTargets.key(),
		],
		onValidationError: (fields) => {
			const message = fields.projectName?.[0];
			if (message) form.setError("projectName", { type: "server", message });
		},
		// No success toast: the dialog itself turns into the "Project duplicated" result.
		onSuccess: (duplicated) => setResult(duplicated),
	});

	const targetIdentity = identities.find((i) => i.id === cloudIdentityId);
	const targetProvider =
		targetIdentity && isCloudProviderSlug(targetIdentity.provider)
			? targetIdentity.provider
			: undefined;

	/**
	 * Applies the target account: clears the region, and re-fills the name with that cloud's default.
	 *
	 * The name is only re-filled while the user has NOT edited it. The suffix names the target
	 * cloud, so a field still reading " (aws)" after the target moved to GCP would be wrong rather
	 * than merely stale — but silently discarding a name somebody typed would be worse. `setValue`
	 * without `shouldDirty` leaves the field pristine, so this keeps working across a second change
	 * of mind. `shouldValidate` is what makes an over-cap default say so on sight instead of on
	 * submit: that is the #4162 case, and it needs to be visible next to a field that can fix it.
	 */
	function onTargetAccountChange(id: string) {
		form.setValue("cloudIdentityId", id, { shouldValidate: true });
		form.setValue("region", "");
		if (dirtyFields.projectName) return;
		const identity = identities.find((i) => i.id === id);
		const slug =
			identity && isCloudProviderSlug(identity.provider)
				? identity.provider
				: undefined;
		const suggested = slug ? suggestedNames[slug] : undefined;
		if (suggested !== undefined) {
			form.setValue("projectName", suggested, { shouldValidate: true });
		}
	}

	/** Submits the duplication request and shows the conversion result, or the server's refusal. */
	async function onSubmit(values: DuplicateFormValues) {
		if (duplicate.isPending) return;
		// `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true for the whole round trip; a
		// failure is routed by the mutation itself (the field, or one toast), so it is not rethrown.
		await duplicate.mutateAsync({ sourceProjectId, values }).catch(() => undefined);
	}

	/** Opens the new project's canvas so the user can review before the first deploy. */
	function openInCanvas() {
		if (!result) return;
		onOpenChange(false);
		router.push(projectHref(orgSlug, result.newProjectSlug));
	}

	// --- Success state: conversion notes + "open in canvas" ---
	if (result) {
		const grouped = groupWarnings(result.warnings);
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Project duplicated</DialogTitle>
						<DialogDescription>
							<span className="font-medium text-foreground">
								{sourceProjectName}
							</span>{" "}
							was copied to{" "}
							{targetProvider ? getProvider(targetProvider).shortName : "the target cloud"}
							{" "}as a draft. Review it in the canvas before you deploy.
						</DialogDescription>
					</DialogHeader>

					{result.warnings.length > 0 ? (
						<ScrollArea className="max-h-64 rounded-md border border-border">
							<ul className="divide-y divide-border">
								{grouped.map((w, idx) => {
									const meta = SEVERITY_META[w.severity];
									const Icon = meta.icon;
									return (
										<li
											key={`${w.component}-${idx}`}
											className="flex items-start gap-2.5 p-3"
										>
											<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.tone)} />
											<div className="min-w-0 space-y-0.5">
												<div className="flex items-center gap-2">
													<span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
														{meta.label}
													</span>
													<span className="text-xs font-medium">
														{w.component}
													</span>
												</div>
												<p className="text-xs text-muted-foreground">
													{w.message}
												</p>
											</div>
										</li>
									);
								})}
							</ul>
						</ScrollArea>
					) : (
						<p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
							No conversion notes — every service mapped cleanly.
						</p>
					)}

					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button onClick={openInCanvas}>Open in canvas</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	// --- Form state ---
	const targetRegionCodes = targetProvider
		? Object.keys(REGION_LABELS[targetProvider] ?? {})
		: [];
	const noTargets = !loadingContext && !targets.isError && identities.length === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Duplicate to another cloud</DialogTitle>
					<DialogDescription>
						Copy{" "}
						<span className="font-medium text-foreground">{sourceProjectName}</span>
						{sourceProvider ? ` from ${getProvider(sourceProvider).shortName}` : ""} to a
						different cloud. Every service is translated to its native equivalent there.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="cloudIdentityId"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs font-medium">
										Target cloud account
									</FormLabel>
									{targetsRefusal ? (
										<p role="alert" className="text-sm text-muted-foreground">
											{targetsRefusal === "forbidden"
												? "You don’t have permission to duplicate this project."
												: targetsRefusal === "not-found"
													? "This project no longer exists, or isn’t in this organization."
													: "Duplicating this project isn’t included in your plan."}
										</p>
									) : targets.isError ? (
										<p role="alert" className="text-sm text-muted-foreground">
											Couldn’t load this project’s details.{" "}
											<button
												type="button"
												onClick={() => void targets.refetch()}
												className="underline underline-offset-2 hover:text-foreground"
											>
												Try again
											</button>
										</p>
									) : loadingContext ? (
										<div className="flex items-center gap-2 text-sm text-muted-foreground">
											<Loader2 className="h-4 w-4 animate-spin" />
											Loading accounts…
										</div>
									) : noTargets ? (
										<p className="text-sm text-muted-foreground">
											No other-cloud accounts connected. Add one in Integrations to
											duplicate across clouds.
										</p>
									) : (
										<Select
											value={field.value}
											onValueChange={onTargetAccountChange}
										>
											<FormControl>
												<SelectTrigger className="h-9 text-sm">
													<SelectValue placeholder="Select cloud account" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{identities.map((identity) => (
													<SelectItem key={identity.id} value={identity.id}>
														<span className="flex items-center gap-2">
															<ProviderIcon
																provider={identity.provider}
																size={16}
																className="shrink-0 grayscale"
															/>
															<span>{identity.name}</span>
															{identity.displayId && (
																<span className="font-mono text-xs text-muted-foreground">
																	{identity.displayId}
																</span>
															)}
														</span>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="region"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs font-medium">
										Target region
									</FormLabel>
									<Select
										value={field.value}
										onValueChange={field.onChange}
										disabled={!targetProvider}
									>
										<FormControl>
											<SelectTrigger className="h-9 text-sm">
												<SelectValue
													placeholder={
														targetProvider
															? "Select region"
															: "Select an account first"
													}
												/>
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{targetProvider &&
												groupRegions(targetRegionCodes, targetProvider).map(
													(group) => (
														<SelectGroup key={group.group}>
															<SelectLabel>{group.group}</SelectLabel>
															{group.regions.map((r) => (
																<SelectItem key={r.value} value={r.value}>
																	{r.label}{" "}
																	<span className="font-mono text-xs text-muted-foreground">
																		({r.value})
																	</span>
																</SelectItem>
															))}
														</SelectGroup>
													),
												)}
										</SelectContent>
									</Select>
								</FormItem>
							)}
						/>

						{/* The clone's name. Pre-filled with the server's derived default — edit it when
						    that default is too long, or when the copy deserves a name of its own. */}
						<FormField
							control={form.control}
							name="projectName"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs font-medium">
										New project name
									</FormLabel>
									<FormControl>
										<Input
											className="h-9 text-sm"
											placeholder={
												targetProvider
													? "Name the duplicate"
													: "Select an account first"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-ui-xs" />
								</FormItem>
							)}
						/>

						{/* Service-mapping preview — what each managed service becomes on the target. */}
						{sourceProvider && targetProvider && categories.length > 0 && (
							<div className="space-y-2">
								<Separator />
								<p className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
									Service mapping
								</p>
								<ul className="space-y-1">
									{categories.map((cat) => {
										const { label, field } = CATEGORY_SERVICE[cat];
										const from = PROVIDERS[sourceProvider][field];
										const to = PROVIDERS[targetProvider][field];
										return (
											<li
												key={cat}
												className="flex items-center gap-2 text-xs"
											>
												<span className="w-16 shrink-0 text-muted-foreground">
													{label}
												</span>
												<span className="font-mono">{from}</span>
												<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
												<span className="font-mono">{to}</span>
											</li>
										);
									})}
								</ul>
							</div>
						)}

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={isSubmitting || !cloudIdentityId || !region}
							>
								{isSubmitting ? (
									<>
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										Duplicating…
									</>
								) : (
									"Duplicate"
								)}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}

/** Orders conversion warnings error → warning → info so the most severe surface first. */
function groupWarnings(warnings: ConversionWarning[]): ConversionWarning[] {
	const order = { error: 0, warning: 1, info: 2 } as const;
	return [...warnings].sort((a, b) => order[a.severity] - order[b.severity]);
}
