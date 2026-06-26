"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { z } from "zod";
import { useRunnersStore } from "@/lib/stores/use-runners-store";
import { registerRunner } from "@/app/server/actions/runners";
import {
	getVerifiedCloudIdentities,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import {
	useCloudProvider,
	groupRegions,
} from "@/lib/cloud-providers";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	FormControl,
	FormField,
	FormItem,
	FormMessage,
} from "@repo/ui/form";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { CloudIdentitySelector } from "@/components/design-spec/cloud-identity-selector";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import {
	AlertTriangle,
	Check,
	Cloud,
	Copy,
	Loader2,
	Plus,
	Rocket,
	Server,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

interface AddRunnerSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const TABS = { deploy: "deploy", register: "register" } as const;
type Tab = (typeof TABS)[keyof typeof TABS];

const DESCRIPTIONS: Record<Tab, string> = {
	deploy:
		"Provision a runner into your cloud account through an existing runner. Alethia runs Terraform for you.",
	register:
		"Bring your own runner — run `alethia runner start` (or your own Terraform) and register it here.",
};

export function AddRunnerSheet({ open, onOpenChange }: AddRunnerSheetProps) {
	const [tab, setTab] = useState<Tab>(TABS.deploy);
	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [credentials, setCredentials] = useState<RegisterCredentials | null>(
		null,
	);

	useEffect(() => {
		if (open) {
			getVerifiedCloudIdentities().then(setIdentities).catch(() => {});
		}
	}, [open]);

	const handleClose = (isOpen: boolean) => {
		if (!isOpen) {
			setCredentials(null);
		}
		onOpenChange(isOpen);
	};

	const description = credentials
		? "Save these credentials — the token cannot be recovered."
		: DESCRIPTIONS[tab];

	return (
		<Sheet open={open} onOpenChange={handleClose}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-lg overflow-y-auto p-0"
			>
				<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
					<SheetTitle className="flex items-center gap-2">
						<Plus className="h-4 w-4" />
						Add Runner
					</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</SheetHeader>

				<div className="px-6 pt-4">
					<Tabs
						value={tab}
						onValueChange={(v) => setTab(v as Tab)}
					>
						<TabsList className="w-full">
							<TabsTrigger
								value={TABS.deploy}
								disabled={credentials !== null}
							>
								<Cloud className="h-3.5 w-3.5" />
								Deploy
							</TabsTrigger>
							<TabsTrigger
								value={TABS.register}
								disabled={credentials !== null}
							>
								<Server className="h-3.5 w-3.5" />
								Register
							</TabsTrigger>
						</TabsList>

						<TabsContent value={TABS.deploy} className="pt-4">
							<DeployForm
								identities={identities}
								onOpenChange={handleClose}
							/>
						</TabsContent>

						<TabsContent value={TABS.register} className="pt-4">
							<RegisterForm
								credentials={credentials}
								setCredentials={setCredentials}
								onOpenChange={handleClose}
							/>
						</TabsContent>
					</Tabs>
				</div>
			</SheetContent>
		</Sheet>
	);
}

// ---------------------------------------------------------------------------
// Deploy tab
// ---------------------------------------------------------------------------

const deployRunnerSchema = z.object({
	name: z.string().min(1, "Runner name is required"),
	cloud_identity_id: z.string().min(1, "Cloud account is required"),
	region: z.string().min(1, "Region is required"),
});

type DeployRunnerFormData = z.infer<typeof deployRunnerSchema>;

function DeployForm({
	identities,
	onOpenChange,
}: {
	identities: CloudIdentityOption[];
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const { deployRunner } = useRunnersStore();
	const { provider, cachedResources } = useCloudProvider();

	const form = useForm<DeployRunnerFormData>({
		resolver: zodResolver(deployRunnerSchema),
		defaultValues: {
			name: "",
			cloud_identity_id: "",
			region: "",
		},
		mode: "onChange",
	});

	const enabledRegions =
		cachedResources && "regions" in cachedResources
			? cachedResources.regions
			: [];

	const regionGroups = useMemo(
		() => groupRegions(enabledRegions, provider),
		[enabledRegions, provider],
	);

	useEffect(() => {
		form.setValue("region", "");
	}, [provider, form]);

	const handleDeploy = async (assignedRunnerId: string | null) => {
		const data = form.getValues();
		try {
			const { jobId } = await deployRunner({
				name: data.name,
				cloudIdentityId: data.cloud_identity_id,
				region: data.region,
				assignedRunnerId: assignedRunnerId,
			});
			toast.success("Runner deployment queued");
			onOpenChange(false);
			router.push(`/dashboard/jobs/${jobId}`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to deploy runner",
			);
		}
	};

	return (
		<FormProvider {...form}>
			<form onSubmit={(e) => e.preventDefault()} className="space-y-5">
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<Label className="text-sm">Name</Label>
							<FormControl>
								<Input
									placeholder="e.g. prod-eu-west-1"
									className="h-9"
									autoFocus
									{...field}
								/>
							</FormControl>
							<FormMessage className="text-[11px]" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="cloud_identity_id"
					render={({ field }) => (
						<FormItem>
							<Label className="text-sm">Cloud Account</Label>
							<FormControl>
								<CloudIdentitySelector
									identities={identities}
									value={field.value || null}
									onChange={(id, _provider) => {
										field.onChange(id);
									}}
								/>
							</FormControl>
							<FormMessage className="text-[11px]" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="region"
					render={({ field }) => (
						<FormItem>
							<Label className="text-sm">Region</Label>
							<Select
								value={field.value || ""}
								onValueChange={field.onChange}
								disabled={enabledRegions.length === 0}
							>
								<FormControl>
									<SelectTrigger className="h-9 text-sm">
										<SelectValue
											placeholder={
												enabledRegions.length === 0
													? "Select a cloud account first"
													: "Select region"
											}
										/>
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{regionGroups.map((g) => (
										<SelectGroup key={g.group}>
											<SelectLabel>
												{g.group}
											</SelectLabel>
											{g.regions.map((r) => (
												<SelectItem
													key={r.value}
													value={r.value}
												>
													{r.label} ({r.value})
												</SelectItem>
											))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
							<FormMessage className="text-[11px]" />
						</FormItem>
					)}
				/>

				<p className="text-xs text-muted-foreground">
					The runner will be deployed as a container with full cloud
					permissions. It will poll Alethia for jobs and execute
					Terraform in your account.
				</p>

				<RunnerSelectPopover
					trigger={
						<Button
							type="button"
							className="w-full"
							disabled={!form.formState.isValid || form.formState.isSubmitting}
						>
							{form.formState.isSubmitting ? (
								<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
							) : (
								<Rocket className="mr-2 h-3.5 w-3.5" />
							)}
							Deploy Runner
						</Button>
					}
					onConfirm={handleDeploy}
					disabled={!form.formState.isValid || form.formState.isSubmitting}
				/>
			</form>
		</FormProvider>
	);
}

// ---------------------------------------------------------------------------
// Register tab
// ---------------------------------------------------------------------------

interface RegisterCredentials {
	runnerId: string;
	runnerToken: string;
	runnerName: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<div className="flex items-center gap-2">
				<code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all border border-border/50">
					{value}
				</code>
				<Button
					variant="outline"
					size="icon"
					className="shrink-0 h-9 w-9"
					onClick={copy}
				>
					{copied ? (
						<Check className="h-3.5 w-3.5 text-foreground" />
					) : (
						<Copy className="h-3.5 w-3.5" />
					)}
				</Button>
			</div>
		</div>
	);
}

function RegisterForm({
	credentials,
	setCredentials,
	onOpenChange,
}: {
	credentials: RegisterCredentials | null;
	setCredentials: (c: RegisterCredentials | null) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsSubmitting(true);
		try {
			const result = await registerRunner(name.trim());
			setCredentials({
				runnerId: result.runner.id,
				runnerToken: result.runner_token,
				runnerName: result.runner.name,
			});
			router.refresh();
		} catch (error: unknown) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to register runner",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	if (credentials) {
		return (
			<div className="space-y-6">
				<div className="rounded-md border border-border bg-muted p-4">
					<div className="flex gap-3">
						<AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
						<div className="space-y-1">
							<p className="text-sm font-medium">
								Save these credentials now
							</p>
							<p className="text-xs text-muted-foreground">
								The runner token is shown only once and cannot be
								recovered. If you lose it, you&apos;ll need to
								register a new runner.
							</p>
						</div>
					</div>
				</div>

				<CopyField label="Runner ID" value={credentials.runnerId} />
				<CopyField
					label="Runner Token"
					value={credentials.runnerToken}
				/>

				<div className="space-y-2 pt-2">
					<Label className="text-xs text-muted-foreground">
						Start with environment variables
					</Label>
					<pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto border border-border/50 leading-relaxed">
{`export ALETHIA_RUNNER_ID=${credentials.runnerId}
export ALETHIA_RUNNER_TOKEN=${credentials.runnerToken}
alethia runner start`}
					</pre>
				</div>

				<div className="space-y-2">
					<Label className="text-xs text-muted-foreground">
						Or with flags
					</Label>
					<pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto border border-border/50 leading-relaxed">
{`alethia runner start \\
  --runner-id=${credentials.runnerId} \\
  --runner-token=${credentials.runnerToken}`}
					</pre>
				</div>

				<Button
					className="w-full"
					onClick={() => onOpenChange(false)}
				>
					Done
				</Button>
			</div>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-5">
			<div className="space-y-2">
				<Label htmlFor="runner-name" className="text-sm">
					Name
				</Label>
				<Input
					id="runner-name"
					placeholder="e.g. fargate-eu-west-1"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="h-9"
					autoFocus
				/>
				<p className="text-xs text-muted-foreground">
					A human-readable name to identify this runner.
				</p>
			</div>

			<p className="text-xs text-muted-foreground">
				The runner will run in your infrastructure with your cloud
				permissions.
			</p>

			<Button
				type="submit"
				className="w-full"
				disabled={!name.trim() || isSubmitting}
			>
				{isSubmitting ? (
					<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
				) : (
					<Server className="mr-2 h-3.5 w-3.5" />
				)}
				Register Runner
			</Button>
		</form>
	);
}
