"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Add Runner — a right sheet that opens to a path chooser (Deploy into a cloud account vs
// Register your own), then the matching form. Managed runners are not added here; they are
// provisioned automatically by warm Pools, so we surface a hint instead.

import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
	useDeployableAccountsQuery,
	useDeployRunner,
	useRegisterRunner,
	useRunnersQuery,
} from "@/lib/query/use-runners-query";
import type { FieldErrors } from "@/lib/actions/result";
import type { DeployableAccount } from "@/lib/rpc/procedures/runners";
import { RUNNER_DEPLOY_PROVIDERS_LABEL } from "@/lib/runners/deploy-providers";
import { groupRegions } from "@/lib/cloud-providers";
import { CLOUD_ACCOUNT } from "@/lib/copy/vocabulary";
import { orpc } from "@/lib/rpc/client";
import { useCloudProviderResources as useCloudProvider } from "@/lib/stores/use-cloud-provider-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
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
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { RegionError } from "@repo/ui/region-error";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { CloudIdentitySelector } from "@/components/design-project/cloud-identity-selector";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import { CopyField } from "@/components/runners/copy-field";
import { FieldHelp, FieldLabel, RequiredMark } from "@/components/runners/field-help";
import {
	AlertTriangle,
	ArrowLeft,
	ChevronRight,
	Cloud,
	Layers,
	Rocket,
	Server,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

interface AddRunnerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type Path = "deploy" | "register";

const PATHS: {
	id: Path;
	icon: typeof Cloud;
	title: string;
	desc: string;
}[] = [
	{
		id: "deploy",
		icon: Cloud,
		title: "Deploy to a cloud",
		desc: `Provision a runner into your ${RUNNER_DEPLOY_PROVIDERS_LABEL} account through an existing runner — Alethia runs Terraform for you. Other clouds must register their own.`,
	},
	{
		id: "register",
		icon: Server,
		title: "Register your own",
		desc: "Bring your own runner — run `alethia runner start` (or your Terraform) and register it here.",
	},
];

/** The deploy path's read of the cloud accounts a runner can be deployed into. */
type DeployableAccountsRead =
	| { status: "pending" }
	| { status: "error" }
	| { status: "ready"; identities: DeployableAccount[] };

/**
 * The verified cloud accounts on the clouds we hold runner templates for — the
 * `runners.deployableAccounts` read, through the query cache — reduced to three states rendered as
 * three different things: while the first answer is in flight (or a retry after a failure is) the
 * deploy pane is a skeleton, a failure with nothing to show is an error with "Try again", and only
 * a successful empty answer says no account is connected. A cached answer renders at once and is
 * re-read each time the sheet opens.
 *
 * Only the clouds we hold runner templates for: the unfiltered list used to be offered here, so a
 * GCP-only user could pick an identity, submit, and read "no templates for provider gcp" in the job
 * log — and because CloudIdentitySelector auto-selects a lone identity, the unbuildable choice
 * arrived pre-filled. The procedure filters on the server.
 */
function useDeployableAccounts(open: boolean): {
	read: DeployableAccountsRead;
	retry: () => void;
} {
	const accounts = useDeployableAccountsQuery(open);
	const read: DeployableAccountsRead = accounts.data
		? { status: "ready", identities: accounts.data }
		: accounts.isError && !accounts.isFetching
			? { status: "error" }
			: { status: "pending" };
	return { read, retry: () => void accounts.refetch() };
}

/**
 * The Add-runner sheet. While a one-time runner token is on screen the sheet closes ONLY through
 * its "Done" button: Esc, an overlay click and the corner X are ignored there (the X is not drawn),
 * because the token cannot be shown again once the sheet forgets it.
 */
export function AddRunnerDialog({ open, onOpenChange }: AddRunnerDialogProps) {
	const [path, setPath] = useState<Path | null>(null);
	const [credentials, setCredentials] = useState<RegisterCredentials | null>(null);
	const accounts = useDeployableAccounts(open);

	/** Closes the sheet and resets it to the chooser for the next opening. */
	const finish = () => {
		setPath(null);
		setCredentials(null);
		onOpenChange(false);
	};

	/** The sheet's own open/close requests (Esc, overlay, X). Refused while the token is shown. */
	const handleOpenChange = (isOpen: boolean) => {
		if (isOpen) {
			onOpenChange(true);
			return;
		}
		if (credentials) return;
		finish();
	};

	const title = !path ? "Add a runner" : path === "deploy" ? "Deploy to a cloud" : "Register your own";
	const description = credentials
		? "Save these credentials — the token cannot be recovered."
		: !path
			? "Runners execute provisioning jobs. Choose how to add one."
			: PATHS.find((p) => p.id === path)?.desc;

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={!credentials}
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				<SheetHeader className="border-b border-border px-6 pb-4 pt-6">
					<SheetTitle className="flex items-center gap-2">
						{path && !credentials && (
							<button
								type="button"
								onClick={() => setPath(null)}
								className="-ml-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								aria-label="Back"
							>
								<ArrowLeft className="h-4 w-4" />
							</button>
						)}
						{title}
					</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-6 py-5">
					{!path ? (
						<div className="space-y-3">
							{PATHS.map((p) => (
								<button
									key={p.id}
									type="button"
									onClick={() => setPath(p.id)}
									className="flex w-full items-start gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-foreground/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<span className="grid size-9 shrink-0 place-items-center border border-border bg-muted text-foreground">
										<p.icon className="h-4 w-4" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
											{p.title}
										</span>
										<span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
											{p.desc}
										</span>
									</span>
									<ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
								</button>
							))}

							<div className="flex items-start gap-3 border border-dashed border-border p-4">
								<span className="grid size-9 shrink-0 place-items-center border border-border bg-muted text-muted-foreground">
									<Layers className="h-4 w-4" />
								</span>
								<p className="text-xs leading-relaxed text-muted-foreground">
									<span className="font-medium text-foreground">Managed runners</span> are provisioned
									automatically by warm Pools and billed by Alethia — add a pool from the Pools panel
									instead of here.
								</p>
							</div>
						</div>
					) : path === "deploy" ? (
						<DeployPane
							accounts={accounts.read}
							onRetryAccounts={accounts.retry}
							onRegisterInstead={() => setPath("register")}
							onClose={finish}
						/>
					) : (
						<RegisterForm credentials={credentials} setCredentials={setCredentials} onDone={finish} />
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

// ---------------------------------------------------------------------------
// Deploy path
// ---------------------------------------------------------------------------

const deployRunnerSchema = z.object({
	name: z.string().trim().min(1, "Runner name is required").max(60),
	cloud_identity_id: z.string().min(1, "Cloud account is required"),
	region: z.string().min(1, "Region is required"),
});

type DeployRunnerFormData = z.infer<typeof deployRunnerSchema>;

/** The deploy pane: the cloud-account read's pending, failed and empty states, then the form. */
function DeployPane({
	accounts,
	onRetryAccounts,
	onRegisterInstead,
	onClose,
}: {
	accounts: DeployableAccountsRead;
	onRetryAccounts: () => void;
	onRegisterInstead: () => void;
	onClose: () => void;
}) {
	const orgSlug = useActiveOrgSlug();

	if (accounts.status === "pending") return <DeployFormSkeleton />;
	if (accounts.status === "error") {
		return (
			<RegionError
				title={`Couldn't load your ${CLOUD_ACCOUNT.many}`}
				description={`We couldn't check which ${RUNNER_DEPLOY_PROVIDERS_LABEL} ${CLOUD_ACCOUNT.many} you have connected. Nothing was changed.`}
				onRetry={onRetryAccounts}
			/>
		);
	}

	// No deployable cloud connected → a deploy is impossible. This is also what a user with only a
	// GCP/Azure/Hetzner identity sees: an honest boundary rather than a form that enqueues a job the
	// runner cannot build. Register needs no cloud at all.
	if (accounts.identities.length === 0) {
		return (
			// `level={3}` keeps the outline rung the hand-rolled `<h3>` had: this heads the deploy
			// pane of the sheet, so `EmptyTitle`'s default `<div>` would take an entry out of the
			// document outline. `Empty` ships `border-dashed` with no WIDTH, so the bare `border`
			// is what paints the dashed outline this pane has always had.
			<EmptyState
				className="border border-border"
				level={3}
				icon={<Cloud />}
				title={`No ${RUNNER_DEPLOY_PROVIDERS_LABEL} account connected`}
				description={
					<>
						Deployed runners are {RUNNER_DEPLOY_PROVIDERS_LABEL} only. Connect an{" "}
						{RUNNER_DEPLOY_PROVIDERS_LABEL} account to deploy one, or register your own runner —
						that runs on any cloud, and needs none connected here.
					</>
				}
				action={
					<div className="flex flex-wrap justify-center gap-2">
						<Button size="sm" onClick={onClose} nativeButton={false} render={<Link href={globalHref(orgSlug, "connectors")} />}>
							Connect {RUNNER_DEPLOY_PROVIDERS_LABEL}
						</Button>
						<Button size="sm" variant="outline" onClick={onRegisterInstead}>
							Register your own
						</Button>
					</div>
				}
			/>
		);
	}

	return (
		<DeployForm identities={accounts.identities} onRegisterInstead={onRegisterInstead} onClose={onClose} />
	);
}

/** Why the deploy cannot be submitted for want of a runner to run it, or null when it can. */
function deployRunnerGateReason(read: { isError: boolean; runnerCount: number | null }): string | null {
	if (read.runnerCount === null) {
		return read.isError
			? "We couldn't check your runners, so a deploy can't be sent yet."
			: "Checking for a runner to run the deploy.";
	}
	if (read.runnerCount === 0) return "A deploy runs on an existing runner. Register one first.";
	return null;
}

/** The deploy form, shown once at least one deployable cloud account is connected. */
function DeployForm({
	identities,
	onRegisterInstead,
	onClose,
}: {
	identities: DeployableAccount[];
	onRegisterInstead: () => void;
	onClose: () => void;
}) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const runnersRead = useRunnersQuery();
	const runnerCount = runnersRead.data ? runnersRead.data.runners.length : null;
	const gateReason = deployRunnerGateReason({ isError: runnersRead.isError, runnerCount });
	const { provider, identityId, cachedResources, isLoading: regionsLoading, error: regionsError } =
		useCloudProvider();

	const form = useForm<DeployRunnerFormData>({
		resolver: zodResolver(deployRunnerSchema),
		defaultValues: { name: "", cloud_identity_id: "", region: "" },
		mode: "onChange",
	});
	const chosenAccount = useWatch({ control: form.control, name: "cloud_identity_id" });

	// Memoised itself: a `[]` fallback built inline was a new array every render, so the region
	// groups' memo below never held.
	const enabledRegions = useMemo(
		() => (cachedResources && "regions" in cachedResources ? cachedResources.regions : []),
		[cachedResources],
	);

	const regionGroups = useMemo(
		() => groupRegions(enabledRegions, provider),
		[enabledRegions, provider],
	);

	useEffect(() => {
		form.setValue("region", "");
	}, [provider, form]);

	// The Region field's state follows the chosen account's inventory read: nothing chosen, loading,
	// failed (with a retry), answered with no regions, or answered.
	const regionState: "no-account" | "loading" | "error" | "empty" | "ready" =
		chosenAccount === "" || identityId !== chosenAccount
			? "no-account"
			: regionsError
				? "error"
				: regionsLoading
					? "loading"
					: enabledRegions.length === 0
						? "empty"
						: "ready";
	const regionPlaceholder = {
		"no-account": `Select a ${CLOUD_ACCOUNT.one} first`,
		loading: "Loading regions…",
		error: "Regions unavailable",
		empty: "No regions available for this account",
		ready: "Select region",
	}[regionState];

	// A server-side validation refusal lands on the field it is about (the action's input names
	// `cloudIdentityId`; the form's field is `cloud_identity_id`).
	const deploy = useDeployRunner((fields: FieldErrors) => {
		const names = { name: "name", cloudIdentityId: "cloud_identity_id", region: "region" } as const;
		for (const [key, field] of Object.entries(names)) {
			const message = fields[key]?.[0];
			if (message) form.setError(field, { message });
		}
	});

	const handleDeploy = (assignedRunnerId: string | null) => {
		if (deploy.isPending) return;
		const data = form.getValues();
		deploy.mutate(
			{
				name: data.name,
				cloudIdentityId: data.cloud_identity_id,
				region: data.region,
				assignedRunnerId,
			},
			{
				onSuccess: ({ jobId }) => {
					toast.success("Runner deployment queued");
					onClose();
					router.push(globalHref(orgSlug, `jobs/${jobId}`));
				},
			},
		);
	};

	const submitDisabled = !form.formState.isValid;
	// Not a fragment: `<Button pending>` swaps its LEADING ICON for the [·] mark, and it can only
	// see that icon among its direct children.
	const submitIcon = <Rocket className="mr-2 h-3.5 w-3.5" />;
	const submitLabel = deploy.isPending ? "Deploying runner…" : "Deploy runner";

	return (
		<FormProvider {...form}>
			<form onSubmit={(e) => e.preventDefault()} className="space-y-5">
				{runnerCount === 0 && (
					<div
						role="note"
						className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted px-3 py-2 text-xs leading-relaxed text-foreground"
					>
						<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
						<div className="space-y-2">
							<p>
								A deploy is executed <em>by</em> an existing runner. You have none yet — register one
								first, or let a managed Pool provision runners for you.
							</p>
							<Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onRegisterInstead}>
								Register a runner
							</Button>
						</div>
					</div>
				)}
				{runnersRead.isError && runnerCount === null && (
					<div
						role="alert"
						className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs leading-relaxed text-foreground"
					>
						<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
						<div className="space-y-2">
							<p>We couldn&rsquo;t check which runners you have, and a deploy needs one to run it.</p>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-7 text-xs"
								onClick={() => void runnersRead.refetch()}
							>
								Try again
							</Button>
						</div>
					</div>
				)}

				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							{/* FieldLabel's row, with a FormLabel in it: the FormLabel is what points `htmlFor` at the
							    id FormControl gives the input, so "Name" is the field's accessible name. */}
							<div className="flex items-center gap-1.5">
								<FormLabel className="text-sm">
									Name
									<RequiredMark />
								</FormLabel>
								<FieldHelp
									title="Runner name"
									description="A label to identify this runner in the list and in logs."
								/>
							</div>
							<FormControl>
								<Input placeholder="e.g. prod-eu-west-1" className="h-9" autoFocus {...field} />
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="cloud_identity_id"
					render={({ field }) => (
						<FormItem>
							<FieldLabel required>Cloud account</FieldLabel>
							<FormControl>
								<CloudIdentitySelector
									identities={identities}
									value={field.value || null}
									onChange={(id) => field.onChange(id)}
								/>
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="region"
					render={({ field }) => (
						<FormItem>
							<FieldLabel
								required
								help={{
									title: "Region",
									description: "The cloud region the runner's container runs in. Pick one close to your workloads.",
								}}
							>
								Region
							</FieldLabel>
							<Select
								value={field.value || ""}
								onValueChange={field.onChange}
								disabled={regionState !== "ready"}
							>
								<FormControl>
									<SelectTrigger className="h-9 text-sm" aria-busy={regionState === "loading"}>
										<SelectValue placeholder={regionPlaceholder} />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{regionGroups.map((g) => (
										<SelectGroup key={g.group}>
											<SelectLabel>{g.group}</SelectLabel>
											{g.regions.map((r) => (
												<SelectItem key={r.value} value={r.value}>
													{r.label} ({r.value})
												</SelectItem>
											))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
							{regionState === "error" && <RegionReadError />}
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<p className="text-xs leading-relaxed text-muted-foreground">
					The runner deploys as a container with full cloud permissions. It polls Alethia for jobs
					and executes Terraform in your account.
				</p>

				{gateReason ? (
					// No runner to execute the deploy (or not known yet): the button is disabled and says
					// why, rather than opening a picker whose only choice is a job nothing can claim.
					<DisabledReason reason={gateReason} className="w-full">
						<Button type="button" className="w-full">
							{submitIcon}
							{submitLabel}
						</Button>
					</DisabledReason>
				) : (
					<RunnerSelectPopover
						trigger={
							<Button type="button" className="w-full" disabled={submitDisabled} pending={deploy.isPending}>
								{submitIcon}
								{submitLabel}
							</Button>
						}
						onConfirm={handleDeploy}
						disabled={submitDisabled || deploy.isPending}
					/>
				)}
			</form>
		</FormProvider>
	);
}

/** The Region field's failure: what happened, and a retry of the account's inventory read. */
function RegionReadError() {
	const queryClient = useQueryClient();
	return (
		<div role="alert" className="flex items-center justify-between gap-2 text-ui-xs text-destructive">
			<span>We couldn&rsquo;t load this account&rsquo;s regions.</span>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-7 text-xs"
				onClick={() => void queryClient.refetchQueries({ queryKey: orpc.canvas.cloudInventory.key() })}
			>
				Try again
			</Button>
		</div>
	);
}

/** The deploy form's shape while the cloud-account read is in flight. */
function DeployFormSkeleton() {
	return (
		<SkeletonRoot className="space-y-5">
			<span className="sr-only">Loading your {CLOUD_ACCOUNT.many}</span>
			{[1, 2, 3].map((i) => (
				<div key={i} className="space-y-2">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-9 w-full" />
				</div>
			))}
			<Skeleton className="h-9 w-full" />
		</SkeletonRoot>
	);
}

// ---------------------------------------------------------------------------
// Register path
// ---------------------------------------------------------------------------

const registerRunnerSchema = z.object({
	name: z.string().trim().min(1, "Runner name is required").max(60),
});

type RegisterRunnerFormData = z.infer<typeof registerRunnerSchema>;

interface RegisterCredentials {
	runnerId: string;
	runnerToken: string;
	runnerName: string;
}

/** The register form, replaced by the one-time credentials once the runner exists. */
function RegisterForm({
	credentials,
	setCredentials,
	onDone,
}: {
	credentials: RegisterCredentials | null;
	setCredentials: (c: RegisterCredentials | null) => void;
	onDone: () => void;
}) {
	const form = useForm<RegisterRunnerFormData>({
		resolver: zodResolver(registerRunnerSchema),
		defaultValues: { name: "" },
		mode: "onChange",
	});
	const register = useRegisterRunner((fields: FieldErrors) => {
		const message = fields.name?.[0];
		if (message) form.setError("name", { message });
	});

	// The credentials ARE the confirmation: they replace the form. The runner list is invalidated by
	// the mutation, so the new runner shows without a page refresh.
	const onSubmit = async ({ name }: RegisterRunnerFormData) => {
		try {
			const result = await register.mutateAsync({ name });
			setCredentials({
				runnerId: result.runner.id,
				runnerToken: result.runner_token,
				runnerName: result.runner.name,
			});
		} catch {
			// The refusal is already on screen: an inline field error or one toast (useActionMutation).
		}
	};

	if (credentials) {
		return (
			<div className="space-y-6">
				<div className="rounded-md border border-border bg-muted p-4">
					<div className="flex gap-3">
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
						<div className="space-y-1">
							<p className="text-sm font-medium">Save these credentials now</p>
							<p className="text-xs text-muted-foreground">
								The runner token is shown only once and cannot be recovered. If you lose it, register
								a new runner. This panel stays open until you choose Done.
							</p>
						</div>
					</div>
				</div>

				<CopyField label="Runner ID" value={credentials.runnerId} />
				<CopyField label="Runner Token" value={credentials.runnerToken} />

				<div className="space-y-2 pt-2">
					<Label className="text-xs text-muted-foreground">Start with environment variables</Label>
					<pre className="overflow-x-auto rounded-md border border-border/50 bg-muted p-3 font-mono text-xs leading-relaxed">
{`export ALETHIA_RUNNER_ID=${credentials.runnerId}
export ALETHIA_RUNNER_TOKEN=${credentials.runnerToken}
alethia runner start`}
					</pre>
				</div>

				<Button className="w-full" onClick={onDone}>
					Done
				</Button>
			</div>
		);
	}

	return (
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							{/* FieldLabel's row, with a FormLabel in it: the FormLabel is what points `htmlFor` at the
							    id FormControl gives the input, so "Name" is the field's accessible name. */}
							<div className="flex items-center gap-1.5">
								<FormLabel className="text-sm">
									Name
									<RequiredMark />
								</FormLabel>
								<FieldHelp
									title="Runner name"
									description="A human-readable label to identify this runner in the list and in logs."
								/>
							</div>
							<FormControl>
								<Input placeholder="e.g. fargate-eu-west-1" className="h-9" autoFocus {...field} />
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<p className="text-xs leading-relaxed text-muted-foreground">
					The runner runs in your own infrastructure with your cloud permissions. You&rsquo;ll get a
					one-time token to start it.
				</p>

				<Button
					type="submit"
					className="w-full"
					disabled={!form.formState.isValid}
					pending={form.formState.isSubmitting}
				>
					<Server className="mr-2 h-3.5 w-3.5" />
					{form.formState.isSubmitting ? "Registering runner…" : "Register runner"}
				</Button>
			</form>
		</FormProvider>
	);
}
