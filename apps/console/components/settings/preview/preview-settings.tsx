"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Controller, type FieldPath, useForm, useWatch } from "react-hook-form";
import { savePreviewConfig } from "@/app/server/actions/preview";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { useLeavePageGuard } from "@/components/confirm/use-unsaved-guard";
import { manageReason } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { FormRootError } from "@/components/forms/form-root-error";
import { GeneralRefusal } from "@/components/settings/general/general-states";
import { RepositorySelector } from "@/components/repository-selector";
import {
	SettingsCardFoot,
	SettingsField,
	SettingsInput,
	SettingsPanel,
	SettingsSection,
	settingsControl,
	settingsControlSize,
} from "@/components/settings/settings-ui";
import { ROOT_SERVER_ERROR } from "@/lib/actions/form-errors";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { FABRIC } from "@/lib/copy/vocabulary";
import { orpc } from "@/lib/rpc/client";
import type {
	PreviewConfigRow as StoredPreviewConfig,
	PreviewFabricOption,
	PreviewGitCredentialOption,
} from "@/lib/rpc/procedures/settings";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import {
	parsePreviewRepositoryUrl,
	previewRepositoryPartsFromRepository,
	type PreviewRepositoryParts,
} from "@/lib/git/preview-repository";
import {
	PREVIEW_PLACEMENT_MODES,
	type PreviewConfigInput,
	previewConfigSchema,
} from "@/lib/validations/preview";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { StatusBadge } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import type { GitProviderAvailability } from "@/lib/connectors/git-providers";
import type { GitProvider } from "@/lib/db/schema";
import {
	PREVIEW_ROWS,
	PREVIEW_SAVE_NOTE,
	PREVIEW_SECTION_TITLE,
	PREVIEW_UNSAVED_NOTE,
} from "./preview-copy";
import { PreviewSettingsSkeleton, linkedFromProviders } from "./preview-settings-skeleton";

type PreviewConfigRow = StoredPreviewConfig | null;
type FabricOption = PreviewFabricOption;
type GitCredentialOption = PreviewGitCredentialOption;

/** The form's fields — the keys a server field error may name (after its `config.` prefix). */
const PREVIEW_FIELDS: readonly FieldPath<PreviewConfigInput>[] = [
	"enabled",
	"git_provider",
	"repo_owner",
	"repo_name",
	"apps_path",
	"placement_mode",
	"namespace_prefix",
	"fabric_id",
	"git_credential_id",
];

/** Narrows a server field-error key (`config.repo_owner`) to one of the form's fields. */
function previewField(key: string): FieldPath<PreviewConfigInput> | null {
	const name = key.startsWith("config.") ? key.slice("config.".length) : key;
	return PREVIEW_FIELDS.find((field) => field === name) ?? null;
}

const PLACEMENT_MODE_LABELS: Record<
	(typeof PREVIEW_PLACEMENT_MODES)[number],
	{ label: string; hint: string }
> = {
	namespace: {
		label: "Namespace",
		hint: `One namespace per pull request, on the chosen ${FABRIC.label}.`,
	},
	vcluster: {
		label: "vCluster",
		hint: `A virtual control plane per pull request, on the chosen ${FABRIC.label}.`,
	},
};

const METHOD_LABELS: Record<GitCredentialOption["method"], string> = {
	oauth: "OAuth",
	pat: "PAT",
	deploy_key: "Deploy key",
};

/** The configured GitLab's host, with its port when it names one, or gitlab.com when the URL does not parse. */
function gitlabHost(gitlabBaseUrl: string): string {
	try {
		return new URL(gitlabBaseUrl).host;
	} catch {
		return "gitlab.com";
	}
}

function repositoryUrl(
	config: PreviewConfigInput,
	gitlabBaseUrl: string,
): string {
	if (!config.repo_owner || !config.repo_name) return "";
	if (config.git_provider === "github") {
		return `https://github.com/${config.repo_owner}/${config.repo_name}`;
	}
	if (config.git_provider === "bitbucket") {
		return `https://bitbucket.org/${config.repo_owner}/${config.repo_name}`;
	}
	return `https://${gitlabHost(gitlabBaseUrl)}/${config.repo_owner}/${config.repo_name}`;
}

function configDefaults(config: PreviewConfigRow): PreviewConfigInput {
	const placementMode =
		config?.placement_mode === "vcluster" ? "vcluster" : "namespace";
	return {
		enabled: config?.enabled ?? false,
		git_provider: config?.git_provider ?? "github",
		repo_owner: config?.repo_owner ?? "",
		repo_name: config?.repo_name ?? "",
		apps_path: config?.apps_path ?? ".",
		placement_mode: placementMode,
		namespace_prefix: config?.namespace_prefix ?? "preview",
		fabric_id: config?.fabric_id ?? null,
		git_credential_id: config?.git_credential_id ?? null,
	};
}

function applyRepositoryParts(
	form: ReturnType<typeof useForm<PreviewConfigInput>>,
	parts: PreviewRepositoryParts,
) {
	form.setValue("git_provider", parts.git_provider, { shouldDirty: true });
	form.setValue("repo_owner", parts.repo_owner, {
		shouldDirty: true,
		shouldValidate: true,
	});
	form.setValue("repo_name", parts.repo_name, {
		shouldDirty: true,
		shouldValidate: true,
	});
	form.clearErrors(["git_provider", "repo_owner", "repo_name"]);
}

/** The option that leaves the preview on the project's default Fabric (`fabric_id: null`). */
const DEFAULT_FABRIC_LABEL = "Project default";

/**
 * A row's inline error (R6 F-33): in the destructive ink, announced (`role="alert"` — a refusal
 * from the server changes nothing else on screen), and with an `id` the control it is about points
 * its `aria-describedby` at.
 */
function FieldError({ id, message }: { id?: string; message?: string }) {
	if (!message) return null;
	return (
		<span id={id} role="alert" className="text-ui-xs text-destructive">
			{message}
		</span>
	);
}

/** The `aria-invalid` / `aria-describedby` pair for a control whose error renders at `id`. */
function describedBy(id: string, message: string | undefined) {
	return message
		? { "aria-invalid": true, "aria-describedby": id }
		: { "aria-invalid": undefined, "aria-describedby": undefined };
}

export function PreviewSettings({
	projectId,
	initialConfig,
	fabrics,
	gitCredentials,
	gitlabBaseUrl,
	providerAvailability,
	linkedProviders,
	canManage,
}: {
	projectId: string;
	initialConfig: PreviewConfigRow;
	fabrics: FabricOption[];
	gitCredentials: GitCredentialOption[];
	gitlabBaseUrl: string;
	/** Which git providers this instance can link (server-computed) — passed to the repo picker. */
	providerAvailability: GitProviderAvailability;
	/**
	 * The viewer's linked git providers, as the route prefetched them (`projects.linkedGitProviders`).
	 * Handed to the repo picker, whose FIRST render is then the settled branch: the repository row,
	 * or the "No Git accounts linked" panel. Omitted, the picker reads the list itself after mount.
	 */
	linkedProviders?: GitProvider[];
	/**
	 * Whether the viewer may save these settings, from the read (`project:edit`, the question
	 * `savePreviewConfig` asks). Not yet answered (`undefined`) is treated as "not yet": the form is
	 * read-only and Save says it is checking, so it is never enabled and then refused (R6 F-11).
	 */
	canManage?: boolean;
}) {
	const writeReason = manageReason(canManage === undefined ? undefined : { canManage });
	const readOnly = writeReason !== null;
	const ids = { repo: useId(), appsPath: useId(), placement: useId(), credential: useId() };
	const defaults = useMemo(() => configDefaults(initialConfig), [initialConfig]);
	const [repoUrl, setRepoUrl] = useState(() =>
		repositoryUrl(defaults, gitlabBaseUrl),
	);
	const [repoError, setRepoError] = useState<string | null>(null);
	const form = useForm<PreviewConfigInput>({
		resolver: zodResolver(previewConfigSchema),
		defaultValues: defaults,
	});
	const argocdCredentials = gitCredentials.filter((c) => c.purpose === "argocd");

	function setRepoFromUrl(nextUrl: string) {
		setRepoUrl(nextUrl);
		if (!nextUrl.trim()) {
			setRepoError(null);
			form.setValue("repo_owner", "", { shouldDirty: true, shouldValidate: true });
			form.setValue("repo_name", "", { shouldDirty: true, shouldValidate: true });
			return;
		}
		const parts = parsePreviewRepositoryUrl(nextUrl, gitlabBaseUrl);
		if (!parts) {
			// Preview stores provider/owner/name only, so the URL must be https:// on a configured host.
			setRepoError(
				`Use an https:// URL on github.com, bitbucket.org or ${gitlabHost(gitlabBaseUrl)}, naming the owner and repo (owner/repo).`,
			);
			form.setValue("repo_owner", "", { shouldDirty: true, shouldValidate: true });
			form.setValue("repo_name", "", { shouldDirty: true, shouldValidate: true });
			return;
		}
		setRepoError(null);
		applyRepositoryParts(form, parts);
	}

	// The save in the mutation contract (#6128): pending and double-submit guarded, a field the
	// server refuses under its field, and the page's read invalidated so a return visit shows what
	// was saved (it replaced a `router.refresh()` of the whole route).
	const save = useActionMutation(savePreviewConfig, {
		invalidates: [orpc.settings.preview.key()],
		successMessage: "Preview settings saved.",
		// The server names fields under `config.`; each lands under its row, and a message about no
		// row on this form lands in the form's root error rather than nowhere.
		onValidationError: (fields) => {
			const unplaced: string[] = [];
			for (const [key, messages] of Object.entries(fields)) {
				const field = previewField(key);
				const message = messages?.[0];
				if (!message) continue;
				if (field) form.setError(field, { type: "server", message });
				else unplaced.push(message);
			}
			if (unplaced.length > 0) {
				form.setError(ROOT_SERVER_ERROR, { type: "server", message: unplaced.join(" ") });
			}
		},
		onSuccess: (saved) => {
			const next = configDefaults(saved.config);
			form.reset(next);
			setRepoUrl(repositoryUrl(next, gitlabBaseUrl));
			setRepoError(null);
		},
	});

	// `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true until the save settles; a failure
	// is routed by the mutation itself (field errors, or one toast), so it is not rethrown.
	const onSave = form.handleSubmit(async (values) => {
		if (save.isPending || readOnly) return;
		await save.mutateAsync({ projectId, config: values }).catch(() => undefined);
	});

	const busy = form.formState.isSubmitting || save.isPending;
	const dirty = form.formState.isDirty;
	const saveDisabled = busy || !dirty;

	// Nine fields of unsaved edits are not dropped silently (R6 F-16): a reload or a closed tab asks
	// first, the page-level form of the guard the console's sheets use (`useLeavePageGuard`), and the
	// card's foot says the changes are not saved yet. A save resets the form, which clears both.
	useLeavePageGuard(dirty && !readOnly);
	const errors = form.formState.errors;
	const repoMessage = repoError ?? errors.repo_owner?.message ?? errors.repo_name?.message;
	const placementMessage =
		errors.placement_mode?.message ?? errors.namespace_prefix?.message ?? errors.fabric_id?.message;
	const [selectedProvider, enabled, credentialId, repoOwner, repoName] = useWatch({
		control: form.control,
		name: [
			"git_provider",
			"enabled",
			"git_credential_id",
			"repo_owner",
			"repo_name",
		],
	});

	return (
		<SettingsSection title={PREVIEW_SECTION_TITLE} className="mb-0">
			<SettingsPanel>
				<form noValidate onSubmit={onSave} aria-label="Preview environment settings">
					{/* A viewer who may not save cannot edit either: every control is read-only, and
					    Save says why. The switch and the selects are not native controls, so each is
					    disabled by name as well. */}
					<fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
						<div className="py-1">
							<SettingsField label={PREVIEW_ROWS.enable.label} hint={PREVIEW_ROWS.enable.hint}>
								<Controller
									control={form.control}
									name="enabled"
									render={({ field }) => (
										<div className="flex items-center justify-between gap-4">
											<div className="flex min-w-0 items-center gap-2">
												<StatusBadge
													status={enabled ? "active" : "disabled"}
													label={enabled ? "Enabled" : "Disabled"}
												/>
												<span className="truncate text-ui-sm text-text-tertiary">
													{enabled
														? "Previews will be reconciled after deploy."
														: "No preview ApplicationSet is rendered."}
												</span>
											</div>
											<Switch
												checked={field.value ?? false}
												onCheckedChange={field.onChange}
												disabled={readOnly}
												aria-label="Enable preview environments"
											/>
										</div>
									)}
								/>
							</SettingsField>

							<SettingsField label={PREVIEW_ROWS.source.label} hint={PREVIEW_ROWS.source.hint}>
								<RepositorySelector
									label=""
									value={repoUrl}
									onChange={setRepoFromUrl}
									onRepositorySelect={(repo) => {
										const parts = previewRepositoryPartsFromRepository(repo);
										if (parts) {
											setRepoError(null);
											applyRepositoryParts(form, parts);
										} else {
											setRepoError("Nested repository namespaces are not supported here.");
										}
									}}
									placeholder="Select repository..."
									variant="settings"
									providerAvailability={providerAvailability}
									linkedProviders={linkedProviders}
									gitlabBaseUrl={gitlabBaseUrl}
								/>
								<div className="flex items-center gap-2 text-ui-xs text-text-tertiary">
									<GitProviderIcon provider={selectedProvider} size={14} mono={false} />
									<span className="font-mono">
										{repoOwner || "owner"}/{repoName || "repo"}
									</span>
								</div>
								<FieldError id={ids.repo} message={repoMessage} />
								<div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px]">
									<SettingsInput
										aria-label="Apps path"
										className={cn(settingsControl, settingsControlSize, "font-mono text-ui-sm")}
										autoComplete="off"
										placeholder="."
										{...describedBy(ids.appsPath, errors.apps_path?.message)}
										{...form.register("apps_path")}
									/>
									<div className="flex h-[38px] items-center rounded-sm border border-border-strong bg-surface-sunken px-3 font-mono text-ui-sm text-text-tertiary">
										apps path
									</div>
								</div>
								<FieldError id={ids.appsPath} message={errors.apps_path?.message} />
							</SettingsField>

							<SettingsField
								label={PREVIEW_ROWS.placement.label}
								hint={PREVIEW_ROWS.placement.hint}
							>
								<Controller
									control={form.control}
									name="placement_mode"
									render={({ field }) => (
										<Select
											value={field.value ?? "namespace"}
											onValueChange={field.onChange}
											disabled={readOnly}
										>
											{/* Three selects share two `SettingsField` rows here, so the row label
											    cannot name them — "Placement" would be the accessible name of two
											    different controls. Each carries its own, and each keeps the visible
											    row label inside it (WCAG 2.5.3): a user who says "placement mode"
											    must reach a control a user who reads "Placement" can find. */}
											<SelectTrigger
												aria-label="Placement mode"
												className="w-full"
												{...describedBy(ids.placement, errors.placement_mode?.message)}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{PREVIEW_PLACEMENT_MODES.map((mode) => (
													<SelectItem key={mode} value={mode}>
														<div className="flex flex-col gap-0.5">
															<span>{PLACEMENT_MODE_LABELS[mode].label}</span>
															<span className="text-ui-xs text-text-tertiary">
																{PLACEMENT_MODE_LABELS[mode].hint}
															</span>
														</div>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								/>
								<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
									<SettingsInput
										aria-label="Namespace prefix"
										className={cn(settingsControl, settingsControlSize, "font-mono text-ui-sm")}
										autoComplete="off"
										placeholder="preview"
										{...describedBy(ids.placement, errors.namespace_prefix?.message)}
										{...form.register("namespace_prefix")}
									/>
									<Controller
										control={form.control}
										name="fabric_id"
										render={({ field }) => (
											<Select
												value={field.value ?? "default"}
												onValueChange={(value) =>
													field.onChange(value === "default" ? null : value)
												}
												disabled={readOnly}
											>
												<SelectTrigger
													aria-label={`Placement ${FABRIC.label}`}
													className="w-full"
													{...describedBy(ids.placement, errors.fabric_id?.message)}
												>
													<SelectValue placeholder={DEFAULT_FABRIC_LABEL} />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="default">{DEFAULT_FABRIC_LABEL}</SelectItem>
													{fabrics.map((fabric) => (
														<SelectItem key={fabric.id} value={fabric.id}>
															<div className="flex min-w-0 items-center gap-2">
																<span className="truncate">{fabric.name}</span>
																<span className="font-mono text-ui-xs text-text-tertiary">
																	{fabric.region ?? "inherit"}
																</span>
																<StatusBadge
																	status={fabric.status}
																	showLabel={false}
																	className="shrink-0"
																/>
															</div>
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										)}
									/>
								</div>
								{/* Always rendered, with a line for each case, as the Credentials row's note is: the
								    row keeps one height whatever the project's fabrics, so the route skeleton can
								    reserve it exactly (RUBRIC B2, #6335). */}
								<div className="rounded-sm border border-dashed border-border-strong bg-surface-sunken px-3 py-2 text-ui-sm text-text-tertiary">
									{fabrics.length === 0
										? `This project has no ${FABRIC.label} yet. Previews use its default once it has one.`
										: `Pick a ${FABRIC.label}, or keep ${DEFAULT_FABRIC_LABEL} to use the project's default.`}
								</div>
								<FieldError id={ids.placement} message={placementMessage} />
							</SettingsField>

							<SettingsField
								label={PREVIEW_ROWS.credentials.label}
								hint={PREVIEW_ROWS.credentials.hint}
							>
								<Controller
									control={form.control}
									name="git_credential_id"
									render={({ field }) => (
										<Select
											value={field.value ?? "none"}
											onValueChange={(value) =>
												field.onChange(value === "none" ? null : value)
											}
											disabled={readOnly}
										>
											<SelectTrigger
												aria-label="Credentials"
												className="w-full"
												{...describedBy(ids.credential, errors.git_credential_id?.message)}
											>
												<SelectValue placeholder="None · public repos only" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="none">None · public repos only</SelectItem>
												{argocdCredentials.map((credential) => (
													<SelectItem key={credential.id} value={credential.id}>
														ArgoCD · {METHOD_LABELS[credential.method]}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								/>
								<div className="rounded-sm border border-dashed border-border-strong bg-surface-sunken px-3 py-2 text-ui-sm text-text-tertiary">
									{credentialId
										? "Only ArgoCD-purpose credentials are listed here."
										: "Without a credential, the generator can poll public repositories only."}
								</div>
								<FieldError id={ids.credential} message={errors.git_credential_id?.message} />
							</SettingsField>
						</div>
					</fieldset>
					<FormRootError form={form} className="mx-[22px] mb-3" />
					<SettingsCardFoot
						note={dirty && !readOnly ? PREVIEW_UNSAVED_NOTE : PREVIEW_SAVE_NOTE}
					>
						<DisabledReason reason={writeReason}>
							<Button type="submit" size="sm" disabled={saveDisabled}>
								{busy ? "Saving…" : "Save changes"}
							</Button>
						</DisabledReason>
					</SettingsCardFoot>
				</form>
			</SettingsPanel>
		</SettingsSection>
	);
}

/**
 * The Preview environments page body (#6128): the read the route prefetched (`settings.preview`),
 * in its four renders — the form, a refusal, an error with a retry, and "gone" (a project deleted
 * while the page was open). The skeleton shows only if the server's prefetch did not land.
 *
 * The viewer's linked git providers (`projects.linkedGitProviders`) are prefetched with it and
 * handed to the repo picker (#6335). That decides the Source row's layout: the "No Git accounts
 * linked" panel or the repository row. It was read by the picker after mount, so the first paint
 * showed a loading row that the answer then replaced.
 */
export function PreviewSettingsPage({
	project,
	gitlabBaseUrl,
	providerAvailability,
}: {
	/** The project's slug, as the URL carries it. */
	project: string;
	gitlabBaseUrl: string;
	providerAvailability: GitProviderAvailability;
}) {
	const query = useQuery(
		orpc.settings.preview.queryOptions({ input: { project }, retry: retryUnlessRefused }),
	);
	const linked = useQuery(orpc.projects.linkedGitProviders.queryOptions());

	if (query.data === undefined) {
		if (query.isError) {
			const refusal = readRefusalOf(query.error);
			if (refusal) return <GeneralRefusal refusal={refusal} />;
			return (
				<RegionError
					title="Couldn't load preview settings"
					onRetry={() => void query.refetch()}
				/>
			);
		}
		return <PreviewSettingsSkeleton linked={linkedFromProviders(linked.data)} />;
	}

	if (query.data === null) {
		return (
			<GeneralRefusal
				refusal="not-found"
				title="This project is gone"
				description="It was deleted, or its address changed, while this page was open."
			/>
		);
	}

	return (
		<PreviewSettings
			projectId={query.data.projectId}
			initialConfig={query.data.config}
			fabrics={query.data.fabrics}
			gitCredentials={query.data.gitCredentials}
			gitlabBaseUrl={gitlabBaseUrl}
			providerAvailability={providerAvailability}
			linkedProviders={linked.data}
			canManage={query.data.canManage}
		/>
	);
}
