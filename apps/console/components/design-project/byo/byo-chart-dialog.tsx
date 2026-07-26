"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own Helm chart — the attach flow opened from the canvas ⌘K "Sources" group. On confirm
// it calls the attachByoChart server action, which persists a source='byo' project_addons row the
// next DEPLOY renders as a hardened ArgoCD Application.
//
// A chart arrives one of two ways, and they are genuinely different shapes rather than one shape
// with an odd URL:
//   - a GIT repo, where the chart is a directory (repo + chart path + git ref). Step 0 reuses the
//     production RepositorySelector (git-provider auth, repo fetch, token refresh, no-provider state).
//   - an OCI REGISTRY, where the chart is an artifact addressed by one `oci://host/ns/chart` URL and
//     versioned by a chart version. There is no path to give and no branch to track.
// So the source choice comes first and the wizard adapts: the chart-path step disappears for OCI and
// "Git ref" becomes "Chart version". `attachByoChart` and `resolveByoChartInstall` (PR #1246) already
// speak both; this is the surface that could only ever produce the git one.

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	GitBranch,
	Loader2,
	Package,
	TriangleAlert,
} from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";
import { RepositorySelector } from "@/components/repository-selector";
import { RadioCardGroup } from "@/components/design-project/canvas/inspector/radio-card-group";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import { attachByoChart } from "@/app/server/actions/byo-charts";
import {
	deriveHelmRegistries,
	isSelectableHelmRegistry,
	ociHostOf,
} from "@/lib/connectors/helm-registry-derive";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";

interface ByoChartDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a chart is attached, with the resolved chart id (slug). */
	onAttached?: (chartId: string) => void;
}

type ChartSource = "git" | "oci";

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

/** Wizard steps per source — OCI has no chart path to collect. */
const STEPS: Record<ChartSource, readonly string[]> = {
	git: ["Source", "Repository", "Chart path", "Ref", "Review"],
	oci: ["Source", "Registry", "Version", "Review"],
};

/** Derives a default chart name from the repo URL's last path segment (`acme/payments-helm` →
 * `payments-helm`; `oci://ghcr.io/acme/payments` → `payments`), so the user rarely types one. */
function defaultNameFromRepo(repoUrl: string): string {
	const tail = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
	return tail || "chart";
}

/** Mirrors the server's isPlausibleRepoUrl OCI branch — the whole `oci://host/ns/chart` path. */
function isPlausibleOciChart(url: string): boolean {
	const trimmed = url.trim();
	if (!/^oci:\/\/\S+$/.test(trimmed)) return false;
	// Needs a host AND at least one more segment, or resolveByoChartInstall can't name the chart.
	return trimmed.slice("oci://".length).replace(/\/+$/, "").split("/").filter(Boolean).length >= 2;
}

/** The "attach a Helm chart" dialog. Self-contained: it owns the wizard state and resets on close. */
export function ByoChartDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoChartDialogProps) {
	const [step, setStep] = useState(0);
	const [source, setSource] = useState<ChartSource>("git");
	const [repoUrl, setRepoUrl] = useState<string>("");
	const [ociUrl, setOciUrl] = useState("");
	const [chartPath, setChartPath] = useState("");
	const [ref, setRef] = useState("");
	const [name, setName] = useState("");
	const [namespace, setNamespace] = useState("");
	const [valuesYaml, setValuesYaml] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const isOci = source === "oci";
	const steps = STEPS[source];
	const lastStep = steps.length - 1;

	const reset = useCallback(() => {
		setStep(0);
		setSource("git");
		setRepoUrl("");
		setOciUrl("");
		setChartPath("");
		setRef("");
		setName("");
		setNamespace("");
		setValuesYaml("");
		setSubmitting(false);
	}, []);

	const close = useCallback(
		(next: boolean) => {
			if (!next) reset();
			onOpenChange(next);
		},
		[onOpenChange, reset],
	);

	const effectiveUrl = (isOci ? ociUrl : repoUrl).trim();
	const effectiveName = name.trim() || defaultNameFromRepo(effectiveUrl);
	const effectiveNs = namespace.trim() || "default";
	// A git ref defaults to HEAD; an OCI chart version defaults to `*` (ArgoCD for "latest").
	const effectiveRef = ref.trim() || (isOci ? "*" : "HEAD");

	// Per-step gating for the Next/Confirm button. Indices differ per source, so gate on the step's
	// NAME rather than its number.
	const canAdvance = useMemo(() => {
		switch (steps[step]) {
			case "Source":
				return true;
			case "Repository":
				return repoUrl.trim().length > 0;
			case "Registry":
				return isPlausibleOciChart(ociUrl);
			case "Chart path":
				return chartPath.trim().length > 0;
			default:
				return true; // ref/version + review always advance (defaults fill in)
		}
	}, [steps, step, repoUrl, ociUrl, chartPath]);

	const submit = useCallback(async () => {
		setSubmitting(true);
		try {
			const res = await attachByoChart({
				projectId,
				environmentId,
				id: effectiveName,
				repoUrl: effectiveUrl,
				// An OCI chart has no path — the chart name is the URL's last segment.
				...(isOci ? {} : { chartPath: chartPath.trim() }),
				ref: effectiveRef,
				namespace: effectiveNs,
				valuesYaml: valuesYaml.trim() ? valuesYaml : null,
			});
			toast.success(`Chart "${res.id}" attached — deploys on the next sync.`);
			onAttached?.(res.id);
			close(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not attach the chart.");
			setSubmitting(false);
		}
	}, [
		projectId,
		environmentId,
		effectiveName,
		effectiveUrl,
		isOci,
		chartPath,
		effectiveRef,
		effectiveNs,
		valuesYaml,
		onAttached,
		close,
	]);

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{isOci ? (
							<Package className="h-4 w-4 text-muted-foreground" />
						) : (
							<GitBranch className="h-4 w-4 text-muted-foreground" />
						)}
						Bring your own Helm chart
					</DialogTitle>
					<DialogDescription>
						Point a project at a Helm chart — in a git repo or an OCI registry — and Alethia
						deploys and governs it on the cluster through ArgoCD.
					</DialogDescription>
				</DialogHeader>

				{/* Step rail */}
				<div className="flex items-center gap-2">
					{steps.map((label, i) => (
						<div key={label} className="flex flex-1 flex-col gap-1.5">
							<div
								className={cn(
									"h-0.5 rounded-full transition-colors",
									i <= step ? "bg-foreground" : "bg-border",
								)}
							/>
							<span
								className={cn(
									"font-mono text-[10px] uppercase tracking-wide",
									i === step ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{label}
							</span>
						</div>
					))}
				</div>

				<div className="min-h-[220px] py-2">
					{steps[step] === "Source" && (
						<div className="flex flex-col gap-3">
							<RadioCardGroup
								value={source}
								onChange={(v) => setSource(v === "oci" ? "oci" : "git")}
								options={SOURCE_OPTIONS}
								ariaLabel="Chart source"
							/>
						</div>
					)}

					{steps[step] === "Repository" && (
						<div className="flex flex-col gap-3">
							<RepositorySelector
								value={repoUrl}
								onChange={setRepoUrl}
								label="Chart repository"
								placeholder="https://github.com/acme/payments-helm"
								required
							/>
							<p className="text-xs text-muted-foreground">
								From the git providers you&apos;ve linked. No provider yet? The selector offers a
								connect step — identity comes from your existing connectors, no new login.
							</p>
						</div>
					)}

					{steps[step] === "Registry" && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-oci">Chart reference</Label>
							<Input
								id="byo-chart-oci"
								value={ociUrl}
								onChange={(e) => setOciUrl(e.target.value)}
								placeholder="oci://ghcr.io/acme/payments"
								className="font-mono"
								autoFocus
							/>
							<p className="text-xs text-muted-foreground">
								The whole path including the chart name — host, namespace, chart.
							</p>
							<OciCredentialNote url={ociUrl} />
						</div>
					)}

					{steps[step] === "Chart path" && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-path">Chart path</Label>
							<Input
								id="byo-chart-path"
								value={chartPath}
								onChange={(e) => setChartPath(e.target.value)}
								placeholder="charts/payments"
								className="font-mono"
								autoFocus
							/>
							<p className="text-xs text-muted-foreground">
								The directory inside the repo that contains <code>Chart.yaml</code>.
							</p>
						</div>
					)}

					{(steps[step] === "Ref" || steps[step] === "Version") && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-ref">{isOci ? "Chart version" : "Git ref"}</Label>
							<Input
								id="byo-chart-ref"
								value={ref}
								onChange={(e) => setRef(e.target.value)}
								placeholder={isOci ? "1.4.2 (default: * = latest)" : "main (default: HEAD)"}
								className="font-mono"
								autoFocus
							/>
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
						</div>
					)}

					{steps[step] === "Review" && (
						<div className="flex flex-col gap-3">
							<div className="grid grid-cols-2 gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-name">Name</Label>
									<Input
										id="byo-chart-name"
										value={name}
										onChange={(e) => setName(e.target.value)}
										placeholder={defaultNameFromRepo(effectiveUrl)}
										className="font-mono"
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-ns">Namespace</Label>
									<Input
										id="byo-chart-ns"
										value={namespace}
										onChange={(e) => setNamespace(e.target.value)}
										placeholder="default"
										className="font-mono"
									/>
								</div>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="byo-chart-values">Helm values (optional)</Label>
								<Textarea
									id="byo-chart-values"
									value={valuesYaml}
									onChange={(e) => setValuesYaml(e.target.value)}
									placeholder={"replicaCount: 2\nimage:\n  tag: v1.2.3"}
									className="h-24 font-mono text-xs"
								/>
							</div>
							<div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground">
								<div className="text-foreground">{effectiveName}</div>
								<div>
									{effectiveUrl}
									{isOci ? "" : ` · ${chartPath}`} · {effectiveRef}
								</div>
								<div>namespace {effectiveNs} · manual sync</div>
							</div>
							{isOci ? (
								<p className="text-xs text-muted-foreground">
									Chart-safety scanning isn&apos;t available for OCI charts yet — the scanner
									clones a git repo. The chart still deploys and is governed like any other.
								</p>
							) : null}
						</div>
					)}
				</div>

				<div className="flex items-center justify-between">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => (step === 0 ? close(false) : setStep((s) => s - 1))}
						disabled={submitting}
					>
						{step === 0 ? (
							"Cancel"
						) : (
							<>
								<ArrowLeft className="h-3.5 w-3.5" /> Back
							</>
						)}
					</Button>
					{step < lastStep ? (
						<Button size="sm" onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
							Next <ArrowRight className="h-3.5 w-3.5" />
						</Button>
					) : (
						<Button size="sm" onClick={submit} disabled={submitting}>
							{submitting ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Check className="h-3.5 w-3.5" />
							)}
							Attach chart
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Which connected chart-repo connector will authenticate this pull — the same derivation the Chart
 * Repos sheet runs, shown at the moment the host is typed. A private chart whose host matches
 * nothing fails at deploy with an ArgoCD pull error; saying so here is far cheaper.
 */
function OciCredentialNote({ url }: { url: string }) {
	const connected = useConnectedProviders("helm_registry");
	const host = ociHostOf(url.trim());

	const outcome = useMemo(() => {
		if (!host) return null;
		return deriveHelmRegistries({
			chartRepos: [url.trim()],
			connectedSlugs: connected.filter((p) => isSelectableHelmRegistry(p.slug)).map((p) => p.slug),
			existing: [],
		});
	}, [url, host, connected]);

	if (!host || !outcome) return null;

	const match = outcome.additions[0];
	if (match) {
		const provider = getProvidersForCategory("helm_registry").find(
			(p) => p.slug === match.provider,
		);
		return (
			<p className="text-xs text-muted-foreground">
				Authenticates through your <span className="text-foreground">{provider?.name}</span>{" "}
				connector — the chart repo is added automatically.
			</p>
		);
	}

	const unresolved = outcome.unresolved[0];
	return (
		<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
			<TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
			<span>
				{unresolved?.reason === "ambiguous" ? (
					<>
						More than one connected connector could serve{" "}
						<span className="font-mono">{host}</span> — pick one in Chart repos after attaching.
					</>
				) : (
					<>
						No connected chart-repo connector serves{" "}
						<span className="font-mono">{host}</span>. If the registry is private, connect one
						first or the chart won&apos;t pull.
					</>
				)}
			</span>
		</p>
	);
}
