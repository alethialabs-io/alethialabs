"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment's bring-your-own admission setting (#6541), as a right-side drawer.
//
// A BYO namespace in which a chart already ran starts in admission `warn`: Pod Security and the BYO
// admission policy only REPORT what they would refuse, so a running chart is never broken by a rule
// it did not break when it was attached. This setting is the product path from `warn` to `enforce`:
// with it on, the next deploy puts every BYO namespace of the environment in `enforce`; turned off,
// the namespaces it moved return to `warn` (the runner marks them, see Go `ByoAdmissionSourceLabel`).
//
// THE REPORT COMES FIRST. Turning refusal on is only safe for a person who has seen what it will
// refuse, so the drawer shows the latest deploy's per-namespace report (the #6495 Deploy-tab
// findings, read fresh through getGitopsDeployStatus) ABOVE the switch, with the deploy's date, and
// turning it on asks for an explicit acknowledgement of that report. Consent is BLOCKED until the
// latest deploy produced a COMPLETE report (byoAdmissionReportComplete): a kind the runner could not
// check is shown as "could not be checked", never as "nothing found", and a missing report is not
// an empty one. The drawer also says what no report can cover: pods that were not running at that
// deploy, and charts attached after it. The switch names itself with `aria-labelledby`, for
// the reason protection-rules-dialog.tsx records (#4630): `@repo/ui/switch` renders a `<span>`.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { getGitopsDeployStatus } from "@/app/server/actions/gitops-status";
import { setByoAdmissionEnforce } from "@/app/server/actions/projects";
import { RegionError } from "@/components/errors/region-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { byoAdmissionReportComplete } from "@/lib/gitops/deploy-status";
import { orpc } from "@/lib/rpc/client";
import type { ByoAdmissionNamespaceReport } from "@/types/jsonb.types";
import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { EmptyState } from "@repo/ui/empty";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { settleThrown } from "./settle-action";

/**
 * The form's schema for an environment whose stored setting is `current`, when the latest deploy's
 * report is `reportComplete`: turning refusal ON needs a complete report AND the acknowledgement;
 * keeping it, or turning it off, needs neither — the off switch is never blocked.
 */
export function byoAdmissionFormSchema(current: boolean, reportComplete: boolean) {
	return z
		.object({ enforce: z.boolean(), acknowledged: z.boolean() })
		.refine((v) => current || !v.enforce || reportComplete, {
			path: ["enforce"],
			message: "Deploy this environment first: refusal can be turned on only over a complete report from the latest deploy.",
		})
		.refine((v) => current || !v.enforce || v.acknowledged, {
			path: ["acknowledged"],
			message: "Confirm you have read what turning refusal on will refuse.",
		});
}
type ByoAdmissionForm = z.infer<ReturnType<typeof byoAdmissionFormSchema>>;

/** A namespace's mode as a grayscale tier: refusing is active, reporting idle, refused failed. */
function modeTier(mode: ByoAdmissionNamespaceReport["mode"]): StatusTier {
	if (mode === "enforce") return "active";
	if (mode === "refused") return "failed";
	return "idle";
}

/** A check kind as a person reads it. */
const CHECK_LABEL: Record<string, string> = {
	Service: "Services",
	Ingress: "Ingresses",
	Secret: "Secrets",
	PodSecurity: "Pod Security",
};

/** The kinds a deployed namespace's report did not check: failed, or absent (an older runner). */
function uncheckedKinds(ns: ByoAdmissionNamespaceReport): string[] {
	if (ns.mode === "refused") return [];
	return Object.keys(CHECK_LABEL).filter(
		(kind) => !(ns.checks ?? []).some((c) => c.kind === kind && c.state !== "failed"),
	);
}

/** One namespace of the report: its mode, its charts, and what its rules refuse there. */
function NamespaceReport({ ns }: { ns: ByoAdmissionNamespaceReport }) {
	const findings = ns.findings ?? [];
	const unchecked = uncheckedKinds(ns);
	return (
		<div className="border-b border-border py-2.5 last:border-0">
			<div className="flex items-center justify-between gap-3">
				<span className="truncate font-mono text-ui-sm text-text-primary">{ns.namespace}</span>
				<StatusBadge status={ns.mode} tier={modeTier(ns.mode)} />
			</div>
			<div className="mt-0.5 font-mono text-ui-xs text-text-tertiary">{ns.charts.join(", ")}</div>
			{findings.length > 0 ? (
				<ul className="mt-1.5 space-y-1">
					{findings.map((f) => (
						<li key={f} className="font-mono text-ui-xs leading-snug text-text-secondary">
							{f}
						</li>
					))}
				</ul>
			) : unchecked.length === 0 || ns.mode === "refused" ? (
				<p className="mt-1.5 text-ui-xs text-text-tertiary">
					{ns.mode === "refused"
						? "Its charts were not deployed: the namespace is not this environment's."
						: "Nothing found that refusal would refuse."}
				</p>
			) : null}
			{unchecked.length > 0 && (
				<p className="mt-1.5 text-ui-xs text-text-secondary" data-state="unchecked">
					Could not be checked: {unchecked.map((k) => CHECK_LABEL[k]).join(", ")}.
				</p>
			)}
		</div>
	);
}

/** The drawer for environment `envId` of project `projectId`, whose stored setting is `enforce`. */
export function ByoAdmissionSheet({
	open,
	onOpenChange,
	projectId,
	envId,
	envName,
	enforce,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	envId: string;
	envName: string;
	enforce: boolean;
}) {
	const titleId = useId();
	const ackId = useId();
	// Read fresh on every open: the report is the reason a person turns this on.
	const report = useQuery({
		queryKey: ["byo-admission-report", projectId, envId],
		queryFn: () => getGitopsDeployStatus(projectId, envId),
		enabled: open,
		refetchOnMount: "always",
	});

	const namespaces = report.data?.byoAdmission ?? [];
	const complete = byoAdmissionReportComplete(namespaces);
	const findings = namespaces.reduce((n, ns) => n + (ns.findings?.length ?? 0), 0);
	const reportAt = report.data?.byoAdmissionReportAt ?? null;

	const { control, handleSubmit, reset, formState } = useForm<ByoAdmissionForm>({
		resolver: zodResolver(byoAdmissionFormSchema(enforce, complete)),
		defaultValues: { enforce, acknowledged: false },
	});
	useEffect(() => {
		if (open) reset({ enforce, acknowledged: false });
	}, [open, enforce, reset]);
	const wantEnforce = useWatch({ control, name: "enforce" });

	const save = useActionMutation(
		(values: ByoAdmissionForm) =>
			settleThrown(async () => {
				await setByoAdmissionEnforce(projectId, envId, values.enforce);
				return values.enforce;
			}),
		{
			invalidates: [orpc.environments.key()],
			successMessage: (on) =>
				`BYO admission ${on ? "set to refuse" : "set to report"} for ${envName} — it applies on the next deploy`,
			onSuccess: () => onOpenChange(false),
		},
	);
	const onSubmit = handleSubmit((values) => {
		if (!save.isPending) save.mutate(values);
	});

	// Turning refusal on is blocked while the report is incomplete; the off switch never is.
	const turningOnBlocked = wantEnforce && !enforce && report.data !== undefined && !complete;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" showCloseButton={false} className="w-[min(460px,92vw)] gap-0 p-0 sm:max-w-none">
				<form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-start justify-between gap-3 border-b px-[22px] py-5">
						<div>
							<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
								BYO admission
							</div>
							<div className="mt-1.5 font-mono text-ui-xl text-text-primary">{envName}</div>
							<p className="mt-2 max-w-[44ch] text-ui-sm text-text-tertiary">
								A bring-your-own namespace where a chart already ran only reports what its admission
								rules refuse. Turn refusal on to make every BYO namespace of this environment refuse it.
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

					<div className="flex flex-1 flex-col gap-4 overflow-y-auto px-[22px] py-[18px]">
						<div>
							<div className="vx-eyebrow pb-1 text-ui-3xs">
								What refusal would refuse · latest deploy
								{reportAt ? ` · ${formatRelative(reportAt)}` : ""}
							</div>
							{report.isError ? (
								<RegionError
									title="Couldn't load the admission report"
									description="The latest deploy's report for this environment failed to load."
									onRetry={() => void report.refetch()}
								/>
							) : report.data === undefined ? (
								<Skeleton className="h-[96px] w-full rounded-lg" data-state="pending" />
							) : namespaces.length === 0 ? (
								<EmptyState
									className="border border-dashed border-border-strong"
									title="No admission report yet"
									description="Deploy this environment with a runner that reports BYO admission; the report then lists each BYO namespace and what it runs that refusal would refuse."
								/>
							) : (
								<>
									{!complete && (
										<p className="mb-2 text-ui-sm text-text-secondary" data-state="incomplete">
											This report is incomplete: some namespaces could not be checked. Deploy again for a
											complete report before turning refusal on.
										</p>
									)}
									<div className="border border-border px-3" data-testid="byo-admission-report">
										{namespaces.map((ns) => (
											<NamespaceReport key={ns.namespace} ns={ns} />
										))}
									</div>
								</>
							)}
							<p className="mt-1.5 text-ui-xs text-text-tertiary">
								The report covers the pods that were running at that deploy. A CronJob between runs, a
								workload scaled to zero, and a chart attached after that deploy are not in it.
							</p>
						</div>

						<div className="flex items-start justify-between gap-3 rounded-lg border px-3.5 py-3">
							<div>
								<div id={titleId} className="text-ui-md text-text-primary">
									Refuse in every BYO namespace
								</div>
								<p className="mt-0.5 text-ui-xs text-text-tertiary">
									Applies on the next new deploy; a re-run, or a deploy of a plan made before the change,
									keeps the old value. Turning it off returns the namespaces it moved to reporting.
								</p>
							</div>
							<Controller
								control={control}
								name="enforce"
								render={({ field }) => (
									<Switch checked={field.value} onCheckedChange={field.onChange} aria-labelledby={titleId} />
								)}
							/>
						</div>
						{turningOnBlocked && (
							<p role="alert" className="text-ui-xs text-destructive">
								Refusal can be turned on only over a complete report from the latest deploy. Deploy this
								environment, then come back.
							</p>
						)}

						{wantEnforce && !enforce && !turningOnBlocked && (
							<Controller
								control={control}
								name="acknowledged"
								render={({ field, fieldState }) => (
									<div className="flex flex-col gap-1">
										<div className="flex items-start gap-2.5">
											<Checkbox
												checked={field.value}
												onCheckedChange={(v) => field.onChange(v === true)}
												aria-labelledby={ackId}
												aria-invalid={fieldState.error ? true : undefined}
											/>
											<span id={ackId} className="text-ui-sm text-text-secondary">
												{findings > 0
													? `I have read the ${findings} finding${findings === 1 ? "" : "s"} above. Each one is refused on its next change, and a pod that breaks Pod Security baseline is refused when it is next created.`
													: "I understand that from the next deploy, a change or a pod that breaks the rules is refused in every BYO namespace."}
											</span>
										</div>
										{fieldState.error?.message ? (
											<span role="alert" className="text-ui-xs text-destructive">
												{fieldState.error.message}
											</span>
										) : null}
									</div>
								)}
							/>
						)}

						<p className="text-ui-xs text-text-tertiary">
							A runner older than this setting deploys as before and does not apply it. The Deploy tab
							shows the mode each namespace actually got.
						</p>
					</div>

					<div className="flex justify-end gap-2 border-t px-[22px] py-4">
						<Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={save.isPending || !formState.isDirty || turningOnBlocked}>
							Save
						</Button>
					</div>
				</form>
			</SheetContent>
		</Sheet>
	);
}
