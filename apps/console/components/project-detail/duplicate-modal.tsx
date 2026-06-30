"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Button } from "@repo/ui/button";

import {
	getVerifiedCloudIdentities,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import { duplicateProjectForProvider } from "@/app/server/actions/projects";
import {
	getProvider,
	type CloudProviderSlug,
} from "@/lib/cloud-providers/registry";
import { REGION_LABELS, groupRegions } from "@/lib/cloud-providers";
import { getProjectSlug } from "@/app/server/actions/resolve";
import { useRefreshProjects } from "@/lib/query/use-projects-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref, projectHref } from "@/lib/routing";

interface DuplicateModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sourceProjectId: string;
	sourceProjectName: string;
	sourceProvider: CloudProviderSlug;
}

/** The duplicate result, derived from the server action so it tracks its return shape. */
type DuplicateResult = Awaited<ReturnType<typeof duplicateProjectForProvider>>;

/** Modal for duplicating a project configuration to a different cloud provider. */
export function DuplicateModal({
	open,
	onOpenChange,
	sourceProjectId,
	sourceProjectName,
	sourceProvider,
}: DuplicateModalProps) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const refreshProjects = useRefreshProjects();

	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [selectedIdentityId, setSelectedIdentityId] = useState<string>("");
	const [targetRegion, setTargetRegion] = useState<string>("");
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<DuplicateResult | null>(null);

	/** Loads verified cloud identities when the dialog opens. */
	useEffect(() => {
		if (!open) return;

		setSelectedIdentityId("");
		setTargetRegion("");
		setResult(null);

		let cancelled = false;

		async function fetchIdentities() {
			setLoading(true);
			try {
				const all = await getVerifiedCloudIdentities();
				if (cancelled) return;
				setIdentities(all.filter((i) => i.provider !== sourceProvider));
			} catch {
				if (!cancelled) toast.error("Failed to load cloud identities");
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		fetchIdentities();
		return () => { cancelled = true; };
	}, [open, sourceProvider]);

	/** Submits the duplication request. */
	async function handleDuplicate() {
		if (!selectedIdentityId || !targetRegion) return;

		setLoading(true);
		try {
			const res = await duplicateProjectForProvider(
				sourceProjectId,
				selectedIdentityId,
				targetRegion,
			);
			setResult(res);
			refreshProjects();
			toast.success("Project duplicated");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to duplicate project");
		} finally {
			setLoading(false);
		}
	}

	/** Navigates to the newly created project (project), falling back to the org overview. */
	async function goToNewProject() {
		if (!result) return;
		onOpenChange(false);
		const slug = await getProjectSlug(result.newProjectId);
		router.push(slug ? projectHref(orgSlug, slug) : orgHref(orgSlug));
	}

	const selectedProvider = identities.find((i) => i.id === selectedIdentityId)?.provider as CloudProviderSlug | undefined;
	const sourceMeta = getProvider(sourceProvider);

	if (result) {
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<CheckCircle2 className="h-5 w-5 text-foreground" />
							Project Duplicated
						</DialogTitle>
						<DialogDescription>
							<span className="font-medium text-foreground">{sourceProjectName}</span> has been
							duplicated to {selectedProvider ? getProvider(selectedProvider).shortName : "the target provider"}.
						</DialogDescription>
					</DialogHeader>

					{result.warnings.length > 0 && (
						<div className="space-y-2 rounded-md border border-border bg-muted p-3">
							<p className="text-sm font-medium">Conversion notes</p>
							<ul className="space-y-1.5">
								{result.warnings.map((w, idx) => (
									<li key={`${w.component}-${idx}`} className="flex items-start gap-2 text-xs">
										{w.severity === "info"
											? <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
											: <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />}
										<span>
											<span className="font-medium">{w.component}:</span> {w.message}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}

					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button onClick={goToNewProject}>
							View Project
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Duplicate for Provider</DialogTitle>
					<DialogDescription>
						Duplicate <span className="font-medium text-foreground">{sourceProjectName}</span>{" "}
						from {sourceMeta.shortName} to another cloud provider.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<label className="text-sm font-medium">Target Cloud Account</label>
						{loading && identities.length === 0 ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="h-4 w-4 animate-spin" />
								Loading identities...
							</div>
						) : identities.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No other cloud accounts available. Connect one in Connectors.
							</p>
						) : (
							<Select value={selectedIdentityId} onValueChange={(id) => {
								setSelectedIdentityId(id);
								setTargetRegion("");
							}}>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue placeholder="Select cloud account" />
								</SelectTrigger>
								<SelectContent>
									{identities.map((identity) => {
										const meta = getProvider(identity.provider);
										return (
											<SelectItem key={identity.id} value={identity.id}>
												<div className="flex items-center gap-2">
													<Image src={meta.icon} alt={meta.shortName} width={16} height={16} className="shrink-0" />
													<span>{identity.name}</span>
													<span className="text-xs text-muted-foreground font-mono">
														{identity.displayId.length > 12 ? identity.displayId.slice(0, 12) + "…" : identity.displayId}
													</span>
												</div>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						)}
					</div>

					<div className="space-y-2">
						<label className="text-sm font-medium">Target Region</label>
						<Select value={targetRegion} onValueChange={setTargetRegion} disabled={!selectedProvider}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue placeholder={selectedProvider ? "Select region" : "Select an account first"} />
							</SelectTrigger>
							<SelectContent>
								{selectedProvider &&
									groupRegions(Object.keys(REGION_LABELS[selectedProvider] ?? {}), selectedProvider).map((group) => (
										<SelectGroup key={group.group}>
											<SelectLabel>{group.group}</SelectLabel>
											{group.regions.map((r) => (
												<SelectItem key={r.value} value={r.value}>
													{r.label} ({r.value})
												</SelectItem>
											))}
										</SelectGroup>
									))}
							</SelectContent>
						</Select>
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button onClick={handleDuplicate} disabled={loading || !selectedIdentityId || !targetRegion}>
							{loading ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Duplicating...
								</>
							) : (
								"Duplicate"
							)}
						</Button>
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
