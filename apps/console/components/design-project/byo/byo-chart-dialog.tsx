"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own Helm chart — the four-step attach flow (repo → chart path → ref → confirm) opened
// from the canvas ⌘K "Sources" group. Step 0 reuses the production RepositorySelector (git-provider
// auth, repo fetch, token refresh, no-provider state all handled); the remaining steps collect the
// chart path, git ref, target namespace, and optional Helm values. On confirm it calls the
// attachByoChart server action, which persists a source='byo' project_addons row the next DEPLOY
// renders as a hardened ArgoCD Application. Design reference: the "BYO Helm Chart" spec (cmdk flow).

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, GitBranch, Loader2 } from "lucide-react";
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
import { attachByoChart } from "@/app/server/actions/byo-charts";

interface ByoChartDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a chart is attached, with the resolved chart id (slug). */
	onAttached?: (chartId: string) => void;
}

const STEPS = ["Repository", "Chart path", "Ref", "Review"] as const;

/** Derives a default chart name from the repo URL's last path segment (`acme/payments-helm` →
 * `payments-helm`), so the user rarely has to type one. */
function defaultNameFromRepo(repoUrl: string): string {
	const tail = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
	return tail || "chart";
}

/** The four-step "attach a Helm chart" dialog. Self-contained: it owns the wizard state and resets
 * on close. */
export function ByoChartDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoChartDialogProps) {
	const [step, setStep] = useState(0);
	const [repoUrl, setRepoUrl] = useState<string>("");
	const [chartPath, setChartPath] = useState("");
	const [ref, setRef] = useState("");
	const [name, setName] = useState("");
	const [namespace, setNamespace] = useState("");
	const [valuesYaml, setValuesYaml] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const reset = useCallback(() => {
		setStep(0);
		setRepoUrl("");
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

	const effectiveName = name.trim() || defaultNameFromRepo(repoUrl);
	const effectiveNs = namespace.trim() || "default";
	const effectiveRef = ref.trim() || "HEAD";

	// Per-step gating for the Next/Confirm button.
	const canAdvance = useMemo(() => {
		if (step === 0) return repoUrl.trim().length > 0;
		if (step === 1) return chartPath.trim().length > 0;
		return true; // ref + review are always advanceable (defaults fill in)
	}, [step, repoUrl, chartPath]);

	const submit = useCallback(async () => {
		setSubmitting(true);
		try {
			const res = await attachByoChart({
				projectId,
				environmentId,
				id: effectiveName,
				repoUrl: repoUrl.trim(),
				chartPath: chartPath.trim(),
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
		repoUrl,
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
						<GitBranch className="h-4 w-4 text-muted-foreground" />
						Bring your own Helm chart
					</DialogTitle>
					<DialogDescription>
						Point a project at a git repo that holds a Helm chart — Alethia deploys and governs it on
						the cluster through ArgoCD.
					</DialogDescription>
				</DialogHeader>

				{/* Step rail */}
				<div className="flex items-center gap-2">
					{STEPS.map((label, i) => (
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
					{step === 0 && (
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

					{step === 1 && (
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

					{step === 2 && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-ref">Git ref</Label>
							<Input
								id="byo-chart-ref"
								value={ref}
								onChange={(e) => setRef(e.target.value)}
								placeholder="main (default: HEAD)"
								className="font-mono"
								autoFocus
							/>
							<p className="text-xs text-muted-foreground">
								Branch, tag, or commit ArgoCD tracks. Leave blank for <code>HEAD</code>.
							</p>
						</div>
					)}

					{step === 3 && (
						<div className="flex flex-col gap-3">
							<div className="grid grid-cols-2 gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-name">Name</Label>
									<Input
										id="byo-chart-name"
										value={name}
										onChange={(e) => setName(e.target.value)}
										placeholder={defaultNameFromRepo(repoUrl)}
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
									{repoUrl} · {chartPath} · {effectiveRef}
								</div>
								<div>namespace {effectiveNs} · manual sync</div>
							</div>
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
					{step < 3 ? (
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
