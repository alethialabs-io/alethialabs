"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own Helm chart — the attach flow opened from the canvas ⌘K "Sources" group. On confirm
// it calls the attachByoChart server action, which persists a source='byo' project_addons row the
// next DEPLOY renders as a hardened ArgoCD Application.
//
// A chart arrives one of two ways, and they are genuinely different shapes rather than one shape
// with an odd URL:
//   - a GIT repo, where the chart is a directory (repo + chart path + git ref). The repository step
//     reuses the production RepositorySelector (git-provider auth, repo fetch, token refresh).
//   - an OCI REGISTRY, where the chart is an artifact addressed by one `oci://host/ns/chart` URL and
//     versioned by a chart version. There is no path to give and no branch to track.
// So the source choice comes first and the wizard adapts: the chart-path step is skipped for OCI and
// "Git ref" becomes "Chart version".
//
// It runs on the shared wizard engine (`lib/wizard/`), as an overlay:
//   - the dialog is open exactly while the URL says `?wizard=byo-chart`, and the step is
//     `&step=<id>`. Linking a git provider leaves for the provider and comes back to the same URL,
//     so the dialog reopens on the step it left, with what was typed restored from the tab's draft;
//   - every rule is the attach form's own (`byoChartFormSchema`), run per step, so Next refuses what
//     Attach would, and a server field refusal takes the person to the step that shows the field;
//   - Next and Attach are different buttons whose clicks are cancelled (the footer's guarantee), so
//     the press that reaches Review cannot also attach.

import { type FormEvent, useEffect, useMemo, useRef } from "react";
import { Controller, FormProvider, useWatch } from "react-hook-form";
import { GitBranch, Package, TriangleAlert } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Skeleton } from "@repo/ui/skeleton";
import { Textarea } from "@repo/ui/textarea";
import {
	type StepperItem,
	Stepper,
	WizardFooter,
	WizardFormError,
	WizardRestoredNotice,
	WizardStepHeading,
} from "@repo/ui/wizard";
import { RepositorySelector } from "@/components/repository-selector";
import { RadioCardGroup } from "@/components/design-project/canvas/inspector/radio-card-group";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import { nodeOfKind } from "@/components/design-project/canvas/graph/types";
import { attachByoChartAction } from "@/app/server/actions/byo-charts";
import type { FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { useDesignNodes } from "@/lib/canvas/store/use-board";
import {
	helmRegistryServesHost,
	isSelectableHelmRegistry,
	ociHostOf,
} from "@/lib/connectors/helm-registry-hosts";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";
import { WIZARD_PARAM } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { byoChartNamespace, type ChartSource } from "@/lib/validations/byo-charts";
import { chartSlug } from "@/lib/validations/names";
import { useWizardEnvironment, wizardOpener } from "@/lib/wizard/location";
import { useOpenRequest } from "@/lib/wizard/use-open-request";
import { useWizardEngine } from "@/lib/wizard/use-wizard";
import {
	BYO_CHART_WIZARD_ID,
	type ByoChartWizardValues,
	byoChartWizard,
	wizardFieldOf,
} from "@/components/design-project/byo/byo-chart.wizard";

interface ByoChartDialogProps {
	/** The canvas asks for the dialog. The URL (`?wizard=byo-chart`) is what keeps it open. */
	open: boolean;
	/** Told when the dialog opens or closes for a reason the canvas did not start (Back, a link). */
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a chart is attached, with the resolved chart id (slug). */
	onAttached?: (chartId: string) => void;
}

// ── THE WORKED EXAMPLE ───────────────────────────────────────────────────────────────────────────
//
// Every example string this dialog shows names something that EXISTS and can be fetched. It used to
// name `acme/payments-helm` and `oci://ghcr.io/acme/payments` (#4114): a user's first meeting with
// the BYO contract handed them a repository that 404s, so the one thing they could do with the
// example — paste it and watch it converge — was the one thing it could not do.
//
// These are not shaped placeholders. Change one and you must change it to something that still
// resolves; `tests/components/design-project/byo/byo-chart-dialog.test.tsx` pins each value, refuses
// a re-invented `acme/`-style example anywhere in this file, and — under
// ALETHIA_CHECK_LIVE_EXAMPLES=1 — fetches all three for real.

/** The public starter chart a user with no chart of their own can paste. A GitHub *template*
 * repository, so "Use this template" gives them their own copy. */
export const STARTER_CHART_REPO_URL =
	"https://github.com/alethialabs-io/alethia-starter-chart";

/** Where `Chart.yaml` lives in that repository. `chart`, NOT the conventional `charts/<name>` — the
 * starter repo holds exactly one chart, so nesting it under a plural directory would be a path the
 * user copies and which then resolves to nothing. */
export const STARTER_CHART_PATH = "chart";

/** The OCI example. It is NOT the starter chart: that repository publishes no OCI artifact today, so
 * naming `oci://ghcr.io/alethialabs-io/…` would re-commit #4114's defect under our own org. podinfo
 * is the reference public OCI Helm chart, pullable anonymously, and — checked, not assumed — renders
 * a Deployment, a Service and test-hook Pods by default, all on the BYO AppProject's closed list of
 * workload kinds (byoWorkloadKinds in packages/core/argocd/byo.go), so it satisfies the project a user
 * would be pasting it into. Swap it for ours the day the starter chart ships an OCI release. */
export const EXAMPLE_OCI_CHART_REF = "oci://ghcr.io/stefanprodan/charts/podinfo";

const SOURCE_OPTIONS = [
	{
		value: "git",
		label: "Git repository",
		description: "The chart is a directory in a repo you've linked.",
	},
	{
		value: "oci",
		label: "OCI registry",
		description: "The chart is a packaged artifact in a registry (ghcr.io, Harbor, …).",
	},
];

// ── THE WIZARD ───────────────────────────────────────────────────────────────────────────────────
//
// The definition — steps, rules and draft — is `byo-chart.wizard.ts`. What is below is how this
// dialog shows it.

/** A fresh chart: from git, nothing typed. */
const DEFAULT_VALUES: ByoChartWizardValues = {
	source: "git",
	gitUrl: "",
	ociRef: "",
	chartPath: "",
	ref: "",
	name: "",
	namespace: "",
	valuesYaml: "",
};

/** The step rail's accessible name. */
const STEPPER_LABEL = "Attach a Helm chart";

/** The heading and one line of copy each step opens with. */
interface StepCopy {
	readonly title: string;
	readonly description: string;
}

/** Each step's heading, by step id. */
const STEP_COPY: Readonly<Record<string, StepCopy>> = {
	source: { title: "Where is the chart?", description: "A directory in a git repository, or a packaged chart in a registry." },
	repository: { title: "Chart repository", description: "The git repository that holds the chart." },
	registry: { title: "Chart reference", description: "The OCI address of the packaged chart." },
	"chart-path": { title: "Chart path", description: "Where Chart.yaml is inside the repository." },
	ref: { title: "Version", description: "What ArgoCD tracks." },
	review: { title: "Review", description: "Name the chart, choose its namespace, and attach it." },
};

/** What a step without its own copy would show; never reached while every step id is above. */
const FALLBACK_COPY: StepCopy = { title: "Attach a Helm chart", description: "" };

/** The rail before the draft is read: the first step current, the rest not started. */
const FIRST_STEP_ITEMS: readonly StepperItem[] = byoChartWizard.steps
	.filter((step) => step.when === undefined || step.when(DEFAULT_VALUES))
	.map((step, index) => ({ id: step.id, label: step.label, state: index === 0 ? "current" : "todo" }));

/** What the Review step says about the Helm values: they are the one thing a reload drops. */
export const HELM_VALUES_NOT_KEPT =
	"Not kept if the page reloads — values often hold credentials, so they are never stored.";

/** Where a refusal that names no field is filed: no step owns it, so the engine says it above the buttons. */
const FORM_LEVEL_KEY = "_form";

/** Derives a default chart name from the repo URL's last path segment
 * (`alethialabs-io/alethia-starter-chart` → `alethia-starter-chart`;
 * `oci://ghcr.io/stefanprodan/charts/podinfo` → `podinfo`), so the user rarely types one. */
function defaultNameFromRepo(repoUrl: string): string {
	const tail = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
	return tail || "chart";
}

/** A server's field refusals, keyed by the wizard field that shows each one. */
function toWizardFieldErrors(fields: FieldErrors, source: ChartSource): FieldErrors {
	const mapped: FieldErrors = {};
	for (const [key, messages] of Object.entries(fields)) {
		const field = wizardFieldOf(key, source);
		mapped[field] = [...(mapped[field] ?? []), ...(messages ?? [])];
	}
	return mapped;
}

/** The "attach a Helm chart" dialog: open while the URL names it, its wizard mounted only while open. */
export function ByoChartDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoChartDialogProps) {
	const env = useWizardEnvironment();
	const opener = wizardOpener(env.location, BYO_CHART_WIZARD_ID);
	// Opening drops the canvas's one-shot `?attachChart=1`, which would otherwise be read again and
	// strip the URL the dialog just opened.
	useOpenRequest(open, onOpenChange, opener, () =>
		env.location.push({ [WIZARD_PARAM]: BYO_CHART_WIZARD_ID, attachChart: null }),
	);

	return (
		<Dialog open={opener.open} onOpenChange={opener.setOpen}>
			<DialogContent className="sm:max-w-[560px]">
				{opener.open ? (
					<ByoChartWizard
						projectId={projectId}
						environmentId={environmentId}
						onAttached={onAttached}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** The dialog's header. The icon follows the source. */
function ByoChartHeader({ source }: { source: ChartSource }) {
	return (
		<DialogHeader>
			<DialogTitle className="flex items-center gap-2">
				{source === "oci" ? (
					<Package className="h-4 w-4 text-muted-foreground" />
				) : (
					<GitBranch className="h-4 w-4 text-muted-foreground" />
				)}
				Bring your own Helm chart
			</DialogTitle>
			<DialogDescription>
				Point a project at a Helm chart — in a git repo or an OCI registry — and Alethia deploys
				and governs it on the cluster through ArgoCD.
			</DialogDescription>
		</DialogHeader>
	);
}

/** The steps' frame. A fixed minimum height, so the footer does not move between steps. */
const STEP_BODY = "flex min-h-[260px] flex-col gap-3 py-2";

/** The wizard inside the dialog, while it is open. */
function ByoChartWizard({
	projectId,
	environmentId,
	onAttached,
}: Omit<ByoChartDialogProps, "open" | "onOpenChange">) {
	const env = useWizardEnvironment();
	// The wizard calls this when every step passes; it is pointed at the mutation after each render.
	const attachChart = useRef<(values: ByoChartWizardValues) => void>(() => undefined);

	const wizard = useWizardEngine<ByoChartWizardValues, ByoChartWizardValues>(
		byoChartWizard,
		{
			defaultValues: DEFAULT_VALUES,
			scope: `${projectId}:${environmentId ?? "default"}`,
			onSubmit: (values) => attachChart.current(values),
		},
		env,
	);
	const { control, register, formState } = wizard.form;
	const { errors } = formState;

	// The attach, on the mutation contract: pending while in flight (the double-submit guard), a
	// field refusal routed to its step, a refusal said above the buttons, and the board's chart nodes
	// and their described workloads re-read when it settles.
	const attach = useActionMutation(attachByoChartAction, {
		invalidates: [orpc.canvas.byoCharts.key(), orpc.canvas.chartWorkloads.key()],
		onValidationError: (fields) =>
			wizard.applyFieldErrors(toWizardFieldErrors(fields, wizard.form.getValues("source"))),
		onRefusal: (error) => wizard.applyFieldErrors({ [FORM_LEVEL_KEY]: [error.message] }),
		successMessage: (data) => `Chart "${data.id}" attached — deploys on the next sync.`,
		onSuccess: (data) => {
			wizard.complete();
			onAttached?.(data.id);
		},
	});

	const [source, gitUrl, ociRef, chartPath, name, namespace, ref] = useWatch({
		control,
		name: ["source", "gitUrl", "ociRef", "chartPath", "name", "namespace", "ref"],
	});
	const isOci = source === "oci";
	const effectiveUrl = (isOci ? ociRef : gitUrl).trim();
	const effectiveName = name.trim() || defaultNameFromRepo(effectiveUrl);
	// Its own namespace by default (#6446) — the same `byo-<id>` the attach action would choose, from
	// the same id the action derives (`chartSlug` of the name).
	const defaultNs = byoChartNamespace(chartSlug(effectiveName));
	const effectiveNs = namespace.trim() || defaultNs;
	// A git ref defaults to HEAD; an OCI chart version defaults to `*` (ArgoCD for "latest").
	const effectiveRef = ref.trim() || (isOci ? "*" : "HEAD");

	useEffect(() => {
		attachChart.current = (values) =>
			attach.submit({
				projectId,
				environmentId,
				id: effectiveName,
				repoUrl: (values.source === "oci" ? values.ociRef : values.gitUrl).trim(),
				// An OCI chart has no path — the chart name is the URL's last segment.
				...(values.source === "oci" ? {} : { chartPath: values.chartPath }),
				ref: effectiveRef,
				namespace: effectiveNs,
				valuesYaml: values.valuesYaml.trim() ? values.valuesYaml : null,
			});
	});

	if (!wizard.ready) return <ByoChartWizardSkeleton />;

	const step = wizard.current.id;
	const copy = STEP_COPY[step] ?? FALLBACK_COPY;
	const pending = attach.isPending;

	/** Enter in a field means "go on": Next before Review, Attach on it. */
	function onEnter(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		void (wizard.isLast ? wizard.submit() : wizard.next());
	}

	return (
		<FormProvider {...wizard.form}>
			<ByoChartHeader source={source} />
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

					{step === "source" ? (
						<Controller
							control={control}
							name="source"
							render={({ field }) => (
								<RadioCardGroup
									value={field.value}
									onChange={(value) => field.onChange(value === "oci" ? "oci" : "git")}
									options={SOURCE_OPTIONS}
									ariaLabel="Chart source"
								/>
							)}
						/>
					) : null}

					{step === "repository" ? (
						<>
							<Controller
								control={control}
								name="gitUrl"
								render={({ field }) => (
									<RepositorySelector
										value={field.value}
										onChange={field.onChange}
										label="Chart repository"
										placeholder={STARTER_CHART_REPO_URL}
										required
									/>
								)}
							/>
							{errors.gitUrl ? (
								<p role="alert" className="text-xs text-destructive">
									{errors.gitUrl.message}
								</p>
							) : (
								<>
									<p className="text-xs text-muted-foreground">
										From the git providers you&apos;ve linked. No provider yet? The selector offers
										a connect step and brings you back here with what you typed.
									</p>
									<p className="text-xs text-muted-foreground">
										No chart of your own yet? Switch the selector to manual entry and paste{" "}
										<code>{STARTER_CHART_REPO_URL}</code> — a public starter chart that honours the
										BYO contract, with its chart at <code>{STARTER_CHART_PATH}</code>.
									</p>
								</>
							)}
						</>
					) : null}

					{step === "registry" ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-oci">Chart reference</Label>
							<Input
								id="byo-chart-oci"
								{...register("ociRef")}
								placeholder={EXAMPLE_OCI_CHART_REF}
								className="font-mono"
								aria-invalid={errors.ociRef ? true : undefined}
								autoFocus
							/>
							{errors.ociRef ? (
								<p role="alert" className="text-xs text-destructive">
									{errors.ociRef.message}
								</p>
							) : (
								<p className="text-xs text-muted-foreground">
									The whole path including the chart name — host, namespace, chart.
								</p>
							)}
							<OciCredentialNote url={ociRef} />
						</div>
					) : null}

					{step === "chart-path" ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-path">Chart path</Label>
							<Input
								id="byo-chart-path"
								{...register("chartPath")}
								placeholder={STARTER_CHART_PATH}
								className="font-mono"
								aria-invalid={errors.chartPath ? true : undefined}
								autoFocus
							/>
							{errors.chartPath ? (
								<p role="alert" className="text-xs text-destructive">
									{errors.chartPath.message}
								</p>
							) : (
								<p className="text-xs text-muted-foreground">
									The directory inside the repo that contains <code>Chart.yaml</code> —{" "}
									<code>{STARTER_CHART_PATH}</code> in the starter chart, often{" "}
									<code>charts/&lt;name&gt;</code> in a repo that holds several.
								</p>
							)}
						</div>
					) : null}

					{step === "ref" ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-ref">{isOci ? "Chart version" : "Git ref"}</Label>
							<Input
								id="byo-chart-ref"
								{...register("ref")}
								placeholder={isOci ? "1.4.2 (default: * = latest)" : "main (default: HEAD)"}
								className="font-mono"
								aria-invalid={errors.ref ? true : undefined}
								autoFocus
							/>
							{errors.ref ? (
								<p role="alert" className="text-xs text-destructive">
									{errors.ref.message}
								</p>
							) : (
								<p className="text-xs text-muted-foreground">
									{isOci ? (
										<>
											The chart version ArgoCD pulls. Leave blank for <code>*</code> — the latest
											published version.
										</>
									) : (
										<>
											Branch, tag, or commit ArgoCD tracks. Leave blank for <code>HEAD</code>.
										</>
									)}
								</p>
							)}
						</div>
					) : null}

					{step === "review" ? (
						<>
							<div className="grid grid-cols-2 gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-name">Name</Label>
									<Input
										id="byo-chart-name"
										{...register("name")}
										placeholder={defaultNameFromRepo(effectiveUrl)}
										className="font-mono"
										aria-invalid={errors.name ? true : undefined}
									/>
									{errors.name ? (
										<p role="alert" className="text-xs text-destructive">
											{errors.name.message}
										</p>
									) : null}
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-ns">Namespace</Label>
									<Input
										id="byo-chart-ns"
										{...register("namespace")}
										placeholder={defaultNs}
										className="font-mono"
										aria-invalid={errors.namespace ? true : undefined}
									/>
									{errors.namespace ? (
										<p role="alert" className="text-xs text-destructive">
											{errors.namespace.message}
										</p>
									) : null}
								</div>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="byo-chart-values">Helm values (optional)</Label>
								<Textarea
									id="byo-chart-values"
									{...register("valuesYaml")}
									placeholder={"replicaCount: 2\nimage:\n  tag: v1.2.3"}
									className="h-24 font-mono text-xs"
									aria-invalid={errors.valuesYaml ? true : undefined}
								/>
								{errors.valuesYaml ? (
									<p role="alert" className="text-xs text-destructive">
										{errors.valuesYaml.message}
									</p>
								) : (
									<p className="text-xs text-muted-foreground">{HELM_VALUES_NOT_KEPT}</p>
								)}
							</div>
							<div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-ui-xs text-muted-foreground">
								<div className="text-foreground">{effectiveName}</div>
								<div>
									{effectiveUrl}
									{isOci ? "" : ` · ${chartPath}`} · {effectiveRef}
								</div>
								<div>namespace {effectiveNs} · manual sync</div>
							</div>
						</>
					) : null}

					<WizardFormError message={wizard.formError} />
				</div>

				<WizardFooter
					back={wizard.stepNumber > 1 ? wizard.back : null}
					primary={
						wizard.isLast
							? { kind: "submit", label: "Attach chart", onPress: () => void wizard.submit() }
							: { kind: "next", label: "Next", onPress: () => void wizard.next() }
					}
					pending={pending}
				/>
			</form>
		</FormProvider>
	);
}

/** The dialog while the wizard reads its draft: the header, the rail and the step's frame. */
function ByoChartWizardSkeleton() {
	return (
		<div aria-busy="true" className="flex flex-col gap-4">
			<ByoChartHeader source="git" />
			<Stepper label={STEPPER_LABEL} items={FIRST_STEP_ITEMS} />
			<div className={STEP_BODY}>
				<Skeleton className="h-5 w-40" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
			<div className="flex items-center justify-end">
				<Skeleton className="h-9 w-20" />
			</div>
		</div>
	);
}

/**
 * Whether any chart repo configured on this environment will authenticate this pull, answered at the
 * moment the host is typed. A private chart whose host no chart repo covers fails at deploy with an
 * ArgoCD pull error naming neither the chart nor the missing credential — saying it here is far
 * cheaper. Silent for a public registry, which needs no credential at all.
 */
function OciCredentialNote({ url }: { url: string }) {
	const nodes = useDesignNodes();
	const connected = useConnectedProviders("helm_registry");
	const host = ociHostOf(url.trim());

	const match = useMemo(() => {
		if (!host) return undefined;
		return nodes
			.map((n) => nodeOfKind(n, "helm_registry"))
			.find((n) => n && helmRegistryServesHost(n.data.config, host))?.data.config;
	}, [nodes, host]);

	if (!host) return null;

	if (match) {
		const provider = getProvidersForCategory("helm_registry").find(
			(p) => p.slug === match.provider,
		);
		return (
			<p className="text-xs text-muted-foreground">
				Authenticates through the{" "}
				<span className="font-mono text-foreground">{match.name}</span> chart repo
				{provider ? ` (${provider.name})` : ""}.
			</p>
		);
	}

	// Distinguish "you have nothing connected" from "you connected it but this project doesn't use
	// it" — they need different fixes, and only the second is a one-step one.
	const selectable = connected.filter((p) => isSelectableHelmRegistry(p.slug));
	return (
		<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
			<TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
			<span>
				No chart repo on this environment serves{" "}
				<span className="font-mono">{host}</span>.{" "}
				{selectable.length > 0
					? "Add one from the Add menu (Chart repository) so the pull can authenticate — unless the registry is public."
					: "If the registry is private, connect a chart-repo connector first or the chart won't pull."}
			</span>
		</p>
	);
}
