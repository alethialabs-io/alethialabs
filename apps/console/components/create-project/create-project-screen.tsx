"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FormProvider } from "react-hook-form";

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { type CreateProjectResult, tryCreateProject } from "@/app/server/actions/projects";
import { useCloudConnect } from "@/components/cloud-connect/use-cloud-connect";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { type CloudProviderSlug, PROVIDERS, REGION_LABELS } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import type { GitProviderAvailability } from "@/lib/connectors/git-providers";
import { errorDigest } from "@/lib/errors";
import { canvasHandoffHref, type CanvasSeed } from "@/lib/projects/canvas-handoff";
import type { ConnectedAccount } from "@/lib/projects/connected-account";
import { hrefWithParamPatch } from "@/lib/query/view-url-params";
import { projectHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import { slugify } from "@/lib/utils/slugify";
import { projectSchema } from "@/lib/validations/project-form.schema";
import { useWizard } from "@/lib/wizard/use-wizard";
import { Input } from "@repo/ui/input";
import { WizardFooter, WizardFormError, WizardRestoredNotice } from "@repo/ui/wizard";

import { buildCreate, type CreatePlan, refusalFields } from "./build-create";
import { CloudField } from "./cloud-field";
import {
	type CreateProjectOutput,
	type CreateProjectValues,
	type CreateSource,
	IMPORT_NEEDS_ACCOUNT,
	SCAN_PARAM,
	createProjectWizard,
	sourceNeedsCloud,
} from "./create-project.wizard";
import { FieldRow } from "./create-project-skeletons";
import {
	type AccountOption,
	type ExistingProject,
	type RegionReason,
	cloudAccounts,
	deduceName,
	deduceProvider,
	deduceRegion,
	pickAccount,
} from "./deduce";
import { RegionSelect } from "./region-select";
import { RepoImportPanel } from "./repo-import-panel";
import { ScanStatus } from "./scan-status";
import { SourceField } from "./source-field";
import { sourceOptions } from "./source-options";
import { type ScanResult, useNameAvailability, useScanResult } from "./use-create-project-reads";

/** The project a successful create returns. */
type CreatedProject = Extract<CreateProjectResult, { ok: true }>["project"];

/** What the create mutation is handed. */
interface CreateVariables {
	readonly plan: CreatePlan;
	readonly name: string;
}

/**
 * Every read a new project changes: the shell's list (switcher, breadcrumbs, palette), the setup
 * guide, the usage counts, and the two reads that answer against the org's project names.
 */
function projectsChangedKeys() {
	return [
		orpc.workspace.projects.key(),
		orpc.workspace.setupGuide.key(),
		orpc.usage.resources.key(),
		orpc.projects.nameAvailability.key(),
		orpc.projects.duplicateTargets.key(),
	];
}

/** What the region hint says about where a region came from. */
const REGION_REASON_TEXT: Record<RegionReason, (cloud: string) => string> = {
	scan: () => "From the scan",
	projects: (cloud) => `Where your other ${cloud} projects run`,
	location: () => "Nearest to you",
	default: (cloud) => `${cloud} default`,
};

/** The browser's IANA time zone, or `""` when it does not say. */
function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
	} catch {
		return "";
	}
}

/** The time zone never changes under a page; there is nothing to subscribe to. */
function noTimeZoneChanges(): () => void {
	return () => undefined;
}

/**
 * The browser's time zone, hydration-safe: `""` on the server and while hydrating (the server cannot
 * know it, and a value only the browser renders would not match the server's HTML), the browser's
 * own from the first render after that.
 */
function useBrowserTimeZone(): string {
	return useSyncExternalStore(noTimeZoneChanges, browserTimeZone, () => "");
}

/** The accounts, with an account connected on this screen added until the route re-reads the list. */
function withConnected(
	accounts: readonly AccountOption[],
	connected: ConnectedAccount | null,
): AccountOption[] {
	if (connected === null || accounts.some((a) => a.identityId === connected.identityId)) return [...accounts];
	if (!isCloudProviderSlug(connected.provider)) return [...accounts];
	return [
		...accounts,
		{
			identityId: connected.identityId,
			provider: connected.provider,
			name: `${PROVIDERS[connected.provider].shortName} account`,
			label: null,
			usable: true,
		},
	];
}

/** Why Create cannot be pressed for an import, or `null` when it can. */
function importBlocker(scanJobId: string | null, scan: ScanResult | null): string | null {
	if (scanJobId === null || scan === null) return "Pick a repository and scan it first.";
	switch (scan.status) {
		case "PENDING":
			return "The scan is still running. Create is available when it finishes.";
		case "NEEDS_SETUP":
			return IMPORT_NEEDS_ACCOUNT;
		case "FAILED":
		case "NOT_FOUND":
		case "ERROR":
			return "The scan did not finish. Scan again, or create without the scan.";
		case "READY":
			return null;
	}
}

export interface CreateProjectScreenProps {
	orgSlug: string;
	/** The clouds a new project can be created on: the server's offered list. */
	offered: readonly CloudProviderSlug[];
	integrations: ConnectorWithConnection[];
	/** Whether the viewer may connect a cloud account. */
	canManage: boolean;
	awsSetup: { identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
	/** Which git providers this instance can link (server-computed). */
	providerAvailability: GitProviderAvailability;
	/** The starting point a link asked for (`?scratch=`), or `null`. */
	initialSource: CreateSource | null;
}

/**
 * **New project, one screen.** Start from, cloud, region and name — each filled in before the
 * person arrives wherever it can be worked out (`deduce.ts`): the name from the repository or the
 * org's names, the cloud from the connected account, the region from the org's other projects or the
 * person's time zone. Every one stays an editable field. The only things asked are the ones that
 * cannot be worked out, inline: a repository to import, or a cloud account to connect.
 *
 * Built on the wizard engine (`create-project.wizard.ts`): one form, the schema's name rule, a tab
 * draft that survives a reload or a git-link round trip, server refusals placed on their field, and
 * no silent submit. Create makes a DRAFT project — nothing is provisioned — and lands on its canvas
 * with a seed (`canvasHandoffHref`) the canvas turns into the design.
 */
export function CreateProjectScreen({
	orgSlug,
	offered,
	integrations,
	canManage,
	awsSetup,
	gcpSetup,
	azureSetup,
	extraSetup,
	byoHelmEnabled,
	byoIacEnabled,
	providerAvailability,
	initialSource,
}: CreateProjectScreenProps) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const scanJobId = searchParams.get(SCAN_PARAM);
	const { result: scan, retry: retryScan, reread: rereadScan } = useScanResult(scanJobId);
	const proposal = scan?.status === "READY" ? scan.proposal : null;
	const projectsRead = useQuery(orpc.workspace.projects.queryOptions());
	const existing: ExistingProject[] = (projectsRead.data ?? []).map((p) => ({
		project_name: p.project_name,
		region: p.region,
		cloud_provider: p.cloud_provider,
	}));
	const existingNames = existing.map((p) => p.project_name);
	const [connected, setConnected] = useState<ConnectedAccount | null>(null);
	const listed = cloudAccounts(integrations, offered);
	const accounts = withConnected(listed.accounts, connected);
	const timeZone = useBrowserTimeZone();

	// The defaults, worked out once for the form's first values; a restored draft replaces them.
	const [defaults] = useState((): CreateProjectValues => {
		const { provider } = deduceProvider({
			offered,
			scanProvider: proposal?.provider ?? null,
			accounts,
			projects: existing,
		});
		const { region } = deduceRegion({
			provider,
			scanRegion: proposal?.proposedProject.project.region ?? null,
			projects: existing,
			timeZone,
		});
		return {
			source: scanJobId !== null ? "import" : (initialSource ?? "standard"),
			name: deduceName({
				scanName: proposal?.proposedProject.project.project_name ?? null,
				repoUrl: proposal?.proposedProject.source_repos?.[0]?.repo_url ?? null,
				existingNames,
			}),
			provider,
			identityId: proposal?.identityId ?? pickAccount(provider, accounts),
			region,
			repoUrl: "",
			ref: "",
		};
	});

	// The wizard hands parsed values here; pointed at the current render's create after each render.
	const onValid = useRef<(values: CreateProjectOutput) => void>(() => undefined);
	const wizard = useWizard<CreateProjectValues, CreateProjectOutput>(createProjectWizard, {
		defaultValues: defaults,
		scope: orgSlug,
		onSubmit: (values) => onValid.current(values),
	});
	const { form } = wizard;
	const values = form.getValues();
	const { errors } = form.formState;

	/** The create, with a refusal placed on the field it is about (`refusalFields`). */
	const createAction = async ({ plan, name }: CreateVariables): Promise<ActionResult<CreatedProject>> => {
		try {
			const res = await tryCreateProject(plan.input);
			if (res.ok) return { ok: true, data: res.project };
			const fields = await refusalFields({
				message: res.error,
				name,
				identitySent: Boolean(plan.input.project.cloud_identity_id),
				isNameTaken: () =>
					queryClient
						.fetchQuery({
							...orpc.projects.nameAvailability.queryOptions({ input: { name: name.trim() } }),
							staleTime: 0,
						})
						.then((answer) => !answer.available)
						.catch(() => null),
			});
			return { ok: false, error: { kind: "validation", message: res.error, fields } };
		} catch (err) {
			return { ok: false, error: { kind: "unexpected", ref: errorDigest(err) ?? "unavailable" } };
		}
	};

	const create = useActionMutation(createAction, {
		invalidates: projectsChangedKeys(),
		onValidationError: wizard.applyFieldErrors,
		onSuccess: (project, { plan }) => {
			wizard.complete();
			router.push(handoffHref(orgSlug, project.slug ?? "", plan.seed, offered));
		},
	});
	// A successful create stays busy until the canvas replaces this screen: no second press.
	const pending = create.isPending || create.isSuccess;

	useEffect(() => {
		onValid.current = (parsed) => {
			if (pending) return;
			create.mutate({
				plan: buildCreate(parsed, { jobId: scanJobId, design: proposal?.proposedProject ?? null }),
				name: parsed.name,
			});
		};
	});

	const cloudConnect = useCloudConnect({
		integrations,
		awsSetup,
		gcpSetup,
		azureSetup,
		extraSetup,
		onConnected: (account) => {
			setConnected(account);
			if (!isCloudProviderSlug(account.provider)) return;
			const provider = account.provider;
			if (provider !== form.getValues("provider")) {
				form.setValue("provider", provider, { shouldDirty: true });
				form.setValue("region", deduceRegion({ provider, scanRegion: null, projects: existing, timeZone }).region);
			}
			form.setValue("identityId", account.identityId, { shouldDirty: true });
			form.clearErrors("identityId");
			// A scan that could not be placed without an account can be now.
			if (scan?.status === "NEEDS_SETUP") rereadScan();
		},
	});

	// After a restore (or a connect), the account must belong to the chosen cloud and the region
	// must be one of its regions: re-pick both from the cloud when they do not.
	const accountsKey = accounts.map((a) => `${a.identityId}:${a.usable}`).join(",");
	useEffect(() => {
		if (!wizard.ready) return;
		const provider = form.getValues("provider");
		const identityId = form.getValues("identityId");
		const owner = accounts.find((a) => a.identityId === identityId);
		if (identityId === "" ? pickAccount(provider, accounts) !== "" : owner?.provider !== provider) {
			form.setValue("identityId", pickAccount(provider, accounts));
		}
		if (!Object.hasOwn(REGION_LABELS[provider] ?? {}, form.getValues("region"))) {
			form.setValue("region", deduceRegion({ provider, scanRegion: null, projects: existing, timeZone }).region);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the cloud and the account list
	}, [wizard.ready, values.provider, accountsKey]);

	// A scan that finishes while the screen is open fills in what the person has not touched — once
	// per scan. A scan already ready on arrival filled the defaults instead.
	const appliedScan = useRef<string | null>(proposal !== null ? scanJobId : null);
	useEffect(() => {
		if (!wizard.ready || proposal === null || scanJobId === null || appliedScan.current === scanJobId) return;
		appliedScan.current = scanJobId;
		if (!form.getFieldState("name").isDirty) {
			form.setValue(
				"name",
				deduceName({
					scanName: proposal.proposedProject.project.project_name ?? null,
					repoUrl: proposal.proposedProject.source_repos?.[0]?.repo_url ?? null,
					existingNames,
				}),
			);
		}
		if (!form.getFieldState("provider").isDirty && offered.includes(proposal.provider)) {
			form.setValue("provider", proposal.provider);
			form.setValue("identityId", proposal.identityId);
			form.setValue(
				"region",
				deduceRegion({
					provider: proposal.provider,
					scanRegion: proposal.proposedProject.project.region ?? null,
					projects: existing,
					timeZone,
				}).region,
			);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per scan, when it is ready
	}, [wizard.ready, proposal, scanJobId]);

	// The defaults were worked out before the browser's time zone was known (the server renders this
	// form, and it cannot know it). Once the wizard has booted, a region nobody chose — no restored
	// draft, untouched — moves to the one nearest the browser, when that is where deduction now lands.
	useEffect(() => {
		if (!wizard.ready || wizard.restored || timeZone === "" || form.getFieldState("region").isDirty) return;
		const deduced = deduceRegion({
			provider: form.getValues("provider"),
			scanRegion: proposal?.proposedProject.project.region ?? null,
			projects: existing,
			timeZone,
		});
		if (deduced.reason === "location" && deduced.region !== form.getValues("region")) {
			form.setValue("region", deduced.region);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the wizard boots knowing the time zone
	}, [wizard.ready, timeZone]);

	const nameRuleOk = projectSchema.shape.project_name.safeParse(values.name.trim()).success;
	const { availability, checking, failed: checkFailed } = useNameAvailability(values.name, nameRuleOk);

	// Until the engine has read the draft (`ready`), the form is drawn at its defaults and held INERT,
	// never swapped for the skeleton: the server render is then the form itself, so a first paint
	// whose hydration is slow (or stalled behind a held read) still shows every starting point and
	// field (B1). A restored draft replaces the values once read; nothing can be pressed before then.
	const booting = !wizard.ready;

	const source = values.source;
	const needsCloud = sourceNeedsCloud(source);
	const provider = values.provider;
	const cloudName = PROVIDERS[provider].shortName;
	const regionDeduced = deduceRegion({
		provider,
		scanRegion: proposal?.proposedProject.project.region ?? null,
		projects: existing,
		timeZone,
	});
	const slug = availability?.slug ?? slugify(values.name, "project");
	const taken =
		errors.name === undefined && availability?.available === false
			? `A project named "${values.name.trim()}" already exists in this organization.`
			: null;
	const nameError = errors.name?.message ?? taken;
	// The taken name is said once, under the field; the button's reason points there rather than
	// repeating the sentence.
	const blocker =
		(source === "import" ? importBlocker(scanJobId, scan) : null) ??
		(taken === null ? null : "Choose another project name.");

	/** Moves the URL's scan param: a new scan, or none (`null`). */
	const setScan = (jobId: string | null) => {
		router.push(hrefWithParamPatch(pathname, searchParams.toString(), { [SCAN_PARAM]: jobId }), { scroll: false });
	};

	/** The person picked a cloud: its first usable account, and its region. */
	const onProvider = (next: CloudProviderSlug) => {
		form.setValue("provider", next, { shouldDirty: true });
		form.setValue("identityId", pickAccount(next, accounts));
		form.setValue("region", deduceRegion({ provider: next, scanRegion: null, projects: existing, timeZone }).region);
		form.clearErrors(["identityId", "region"]);
	};

	/** A repository was picked: remember it, and name the project after it unless the name was typed. */
	const onRepository = (repoUrl: string, ref: string) => {
		form.setValue("repoUrl", repoUrl);
		form.setValue("ref", ref);
		if (repoUrl && !form.getFieldState("name").isDirty) {
			form.setValue("name", deduceName({ scanName: null, repoUrl, existingNames }));
		}
	};

	/** Creates an empty project from a scan that did not finish. Asked for explicitly. */
	const onCreateWithoutScan = () => {
		if (pending) return;
		const name = form.getValues("name");
		const parsed = projectSchema.shape.project_name.safeParse(name.trim());
		if (!parsed.success) {
			form.setError("name", { type: "validate", message: parsed.error.issues[0]?.message ?? "Enter a name" }, { shouldFocus: true });
			return;
		}
		const current = form.getValues();
		create.mutate({
			plan: buildCreate(
				{ ...current, source: "blank", name: parsed.data },
				{ jobId: null, design: null },
			),
			name: parsed.data,
		});
	};

	/** The connect sheet for a cloud, when the cloud has a connector to open. */
	const connectFor = (cloud: CloudProviderSlug) => {
		const integration = integrations.find((i) => i.slug === cloud);
		return integration ? () => void cloudConnect.openConnect(integration) : null;
	};

	return (
		<FormProvider {...form}>
			<form
				noValidate
				className="space-y-6"
				inert={booting}
				aria-busy={booting || undefined}
				onSubmit={(event) => {
					event.preventDefault();
					if (!pending && blocker === null) void wizard.submit();
				}}
			>
				{wizard.restored ? <WizardRestoredNotice onStartOver={wizard.discard} /> : null}

				<FieldRow label="Start from">
					<div className="space-y-3">
						<SourceField options={sourceOptions({ byoHelmEnabled, byoIacEnabled })} />
						{source === "import" ? (
							scanJobId !== null && scan !== null ? (
								<ScanStatus
									scan={scan}
									repoUrl={values.repoUrl}
									onRetry={retryScan}
									onChangeRepository={() => setScan(null)}
									onCreateWithoutScan={onCreateWithoutScan}
									pending={pending}
								/>
							) : (
								<RepoImportPanel
									repoUrl={values.repoUrl}
									gitRef={values.ref}
									onRepository={onRepository}
									onScanned={(jobId) => setScan(jobId)}
									providerAvailability={providerAvailability}
								/>
							)
						) : null}
					</div>
				</FieldRow>

				{needsCloud ? (
					<FieldRow label="Cloud">
						<CloudField
							offered={offered}
							accounts={accounts}
							unoffered={listed.unoffered}
							provider={provider}
							identityId={values.identityId}
							onProvider={onProvider}
							onAccount={(id) => form.setValue("identityId", id, { shouldDirty: true })}
							connectFor={connectFor}
							canManage={canManage}
							accountRequired={source === "import"}
							error={errors.identityId?.message ?? null}
						/>
					</FieldRow>
				) : null}

				{needsCloud ? (
					<FieldRow label="Region">
						<div className="flex flex-wrap items-center gap-3">
							<RegionSelect
								provider={provider}
								value={values.region}
								onChange={(region) => form.setValue("region", region, { shouldDirty: true })}
							/>
							{values.region === regionDeduced.region ? (
								<span className="text-ui-xs text-muted-foreground">
									{REGION_REASON_TEXT[regionDeduced.reason](cloudName)}
								</span>
							) : null}
						</div>
						{errors.region?.message ? (
							<p role="alert" className="mt-2 text-ui-sm text-destructive">
								{errors.region.message}
							</p>
						) : null}
					</FieldRow>
				) : null}

				<FieldRow label="Project name" htmlFor="project_name">
					<Input
						id="project_name"
						aria-label="Project name"
						autoComplete="off"
						placeholder="my-project"
						aria-invalid={nameError !== null}
						aria-describedby={nameError ? "project_name_error" : undefined}
						className="max-w-md"
						{...form.register("name")}
					/>
					{nameError ? (
						<p
							id="project_name_error"
							role={errors.name ? "alert" : "status"}
							className="mt-2 text-ui-sm text-destructive"
						>
							{nameError}
						</p>
					) : null}
					<p className="mt-2 font-mono text-ui-xs text-muted-foreground" aria-busy={checking || undefined}>
						{orgSlug}/<span className="text-foreground">{slug}</span>
						{checkFailed ? (
							<span className="ml-2 font-sans text-muted-foreground">
								· could not check whether this name is free
							</span>
						) : null}
					</p>
				</FieldRow>

				<WizardFormError message={wizard.formError} />

				<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
					<span className="text-ui-xs text-muted-foreground">
						Creates a draft. Nothing is provisioned until you deploy from the canvas.
					</span>
					<WizardFooter
						back={null}
						primary={{ kind: "submit", label: "Create project", onPress: () => void wizard.submit() }}
						pending={pending}
						disabledReason={blocker ?? undefined}
					/>
				</div>
			</form>
			{cloudConnect.sheets}
		</FormProvider>
	);
}

/** The canvas link for a new project; the project's own page when the seed is refused. */
function handoffHref(
	orgSlug: string,
	projectSlug: string,
	seed: CanvasSeed,
	offered: readonly CloudProviderSlug[],
): string {
	try {
		return canvasHandoffHref(orgSlug, projectSlug, seed, offered);
	} catch {
		return projectHref(orgSlug, projectSlug);
	}
}
