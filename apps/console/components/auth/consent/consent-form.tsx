"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent decision itself (AGT-L2, SPEC §5b): the approved column — the signed-in account, the
// app's identity, the organization, "{App} asked to", the projects, the sentence about name and
// email — then Deny / Allow, with every edge case the spec designs drawn from the read.
//
// WHAT IS OFFERED IS WHAT CAN BE GRANTED. A permission the person's role cannot use is shown, unticked
// and disabled, with the reason: a scope only narrows the role, so offering it would grant nothing. A
// permission Alethia has no such thing for is named and never sent. An org that refuses the app locks
// every control and Allow. Ask to destroy is never ticked for the person. Only the ticks offered in
// the chosen org are submitted, and the server checks every one of them again.

import { zodResolver } from "@hookform/resolvers/zod";
import { Info, Lock, Power, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useId, useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { formatDate } from "@repo/format";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { AgentIcon } from "@/components/agents/agent-icon";
import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/scopes";
import { COPY, EYEBROW, SCOPE_VERB_WORD, SCOPE_WORDS } from "./consent-copy";
import { ConsentHeading } from "./consent-heading";
import {
	allowBlockers,
	allowLabel,
	type ConsentOrgView,
	consentChanges,
	defaultOrgId,
	defaultProjects,
	defaultScopes,
	existingProjectsPhrase,
	isAllowBlocked,
	isOffered,
	joinWithAnd,
	MANY_ORGS,
	MANY_PROJECTS,
	offeredChoice,
	type ProjectChoice,
	type ReadyConsent,
	reconsentMark,
	requestedRows,
} from "./consent-model";

/** The signed-in person, shown in the account card. */
export interface ConsentAccount {
	name: string;
	email: string;
	image: string | null;
}

/** What the person chose, as submitted. */
export interface ConsentChoice {
	orgId: string;
	scopes: AgentScope[];
	/** null means every project, present and future. */
	projectIds: string[] | null;
}

const consentFormSchema = z.object({
	orgId: z.string(),
	scopes: z.array(z.enum(AGENT_SCOPES)),
	projectMode: z.enum(["all", "some"]),
	projectIds: z.array(z.string()),
	orgQuery: z.string().max(200),
	projectQuery: z.string().max(200),
});

type ConsentFormValues = z.infer<typeof consentFormSchema>;

interface ConsentFormProps {
	consent: ReadyConsent;
	account: ConsentAccount;
	/** An answer is in flight: both buttons are disabled. */
	submitting: boolean;
	/** The answer in flight is Allow: Allow says "Allowing…" with a spinner. */
	allowing: boolean;
	/** The last submit never reached Alethia. */
	networkError: boolean;
	/** The server refused the last submit; its sentence, shown above the buttons. */
	refusal: string | null;
	onAllow: (choice: ConsentChoice) => void;
	onDeny: () => void;
	onSwitchAccount: () => void;
}

/** The initial values for `org`. */
function valuesFor(org: ConsentOrgView | undefined, orgQuery = ""): ConsentFormValues {
	const projects = defaultProjects(org);
	return {
		orgId: org?.id ?? "",
		scopes: defaultScopes(org),
		projectMode: projects.mode,
		projectIds: projects.ids,
		orgQuery,
		projectQuery: "",
	};
}

/** The consent form. */
export function ConsentForm({ consent, account, submitting, allowing, networkError, refusal, onAllow, onDeny, onSwitchAccount }: ConsentFormProps) {
	const ids = { scopes: useId(), projects: useId(), orgHint: useId() };
	const appName = consent.identity.name;
	const initial = useMemo(() => valuesFor(consent.orgs.find((o) => o.id === defaultOrgId(consent.orgs))), [consent.orgs]);
	const form = useForm<ConsentFormValues>({ resolver: zodResolver(consentFormSchema), defaultValues: initial });
	const [orgId, scopes, projectMode, projectIds, orgQuery, projectQuery] = useWatch({
		control: form.control,
		name: ["orgId", "scopes", "projectMode", "projectIds", "orgQuery", "projectQuery"],
	});

	const org = consent.orgs.find((o) => o.id === orgId);
	const projects: ProjectChoice = { mode: projectMode, ids: projectIds };
	const blockers = allowBlockers(org, scopes, projects);
	const locked = !org || org.refusal !== null || submitting;
	const reconsent = !!org?.existing;
	const rows = requestedRows(consent.requested.agent);
	const changes = org ? consentChanges(org, scopes, projects) : null;

	/** Moves to another org: its own default ticks and projects, the search kept. */
	const chooseOrg = (next: string) => {
		form.reset(valuesFor(consent.orgs.find((o) => o.id === next), form.getValues("orgQuery")));
	};

	const submit = form.handleSubmit((values) => {
		const chosen = consent.orgs.find((o) => o.id === values.orgId);
		const b = allowBlockers(chosen, values.scopes, { mode: values.projectMode, ids: values.projectIds });
		if (!chosen || isAllowBlocked(b)) return;
		onAllow({
			orgId: chosen.id,
			scopes: offeredChoice(chosen, values.scopes),
			projectIds: values.projectMode === "all" || chosen.projects.length === 0 ? null : values.projectIds,
		});
	});

	return (
		<form noValidate onSubmit={(e) => void submit(e)} className="space-y-5" aria-labelledby={`${ids.scopes}-title`}>
			<ConsentHeading eyebrow={EYEBROW} title={COPY.title(appName)} id={`${ids.scopes}-title`}>
				{COPY.lede}
			</ConsentHeading>

			<AccountCard account={account} onSwitch={onSwitchAccount} disabled={submitting} />
			<AppIdentity consent={consent} />
			<OrgField
				consent={consent}
				orgId={orgId}
				orgQuery={orgQuery}
				onQuery={(q) => form.setValue("orgQuery", q)}
				onChoose={chooseOrg}
				disabled={submitting}
				hintId={ids.orgHint}
			/>

			{org ? <OrgAlerts org={org} consent={consent} /> : null}
			{!consent.verified ? (
				<Alert role="alert" className="border-foreground">
					<TriangleAlert aria-hidden />
					<AlertTitle>{COPY.unverifiedAlertTitle}</AlertTitle>
					<AlertDescription>{COPY.unverifiedAlertBody}</AlertDescription>
				</Alert>
			) : null}

			<fieldset className="space-y-2" disabled={locked}>
				<legend className="mb-1.5 text-ui-sm font-medium text-text-primary">{COPY.scopesLegend(appName)}</legend>
				<ul className="overflow-hidden rounded-lg border border-border">
					{rows.map((scope) => {
						const offered = !!org && isOffered(org, scope);
						const roleCant = !!org && !org.roleAllows.includes(scope);
						const ticked = offered && scopes.includes(scope);
						const mark = reconsentMark(org?.existing ?? null, ticked, scope);
						const labelId = `${ids.scopes}-${scope}`;
						return (
							<li key={scope} className="border-b border-border last:border-b-0">
								<label
									className={cn(
										"flex items-start gap-2.5 px-3 py-2.5",
										offered && !locked ? "cursor-pointer" : "cursor-not-allowed",
									)}
								>
									<Checkbox
										className="mt-0.5"
										checked={ticked}
										disabled={locked || !offered}
										aria-labelledby={labelId}
										aria-describedby={`${labelId}-why`}
										onCheckedChange={(next) => {
											const rest = scopes.filter((s) => s !== scope);
											form.setValue("scopes", next === true ? [...rest, scope] : rest);
										}}
									/>
									<span className="min-w-0 flex-1">
										<span id={labelId} className="block text-ui-md font-medium text-text-primary">
											{SCOPE_WORDS[scope].label}
										</span>
										<span id={`${labelId}-why`} className="block text-ui-sm text-text-tertiary">
											{roleCant && org
												? COPY.roleCant(org.name, org.roleLabel, SCOPE_VERB_WORD[scope])
												: SCOPE_WORDS[scope].detail}
										</span>
									</span>
									{mark === "new" ? <StatusBadge status="new" tier="active" label={COPY.markNew} /> : null}
									{mark === "removing" ? <StatusBadge status="removing" tier="disabled" label={COPY.markRemoving} /> : null}
								</label>
							</li>
						);
					})}
				</ul>
				{blockers.noneTicked ? (
					<p role="alert" className="text-ui-sm text-text-primary">
						{COPY.noneTicked}
					</p>
				) : blockers.refused ? null : (
					<p className="text-ui-sm text-text-tertiary">{COPY.untickHint}</p>
				)}
			</fieldset>

			{consent.requested.unknown.length > 0 ? (
				<Alert role="status">
					<Info aria-hidden />
					<AlertTitle>{COPY.unknownTitle}</AlertTitle>
					<AlertDescription>
						<p>
							{COPY.unknownBody(appName)}{" "}
							{consent.requested.unknown.map((s, i) => (
								<span key={s}>
									{i > 0 ? (i === consent.requested.unknown.length - 1 ? " and " : ", ") : null}
									<code className="font-mono text-text-primary">{s}</code>
								</span>
							))}
							{COPY.unknownSuffix(consent.requested.unknown.length > 1)}
						</p>
					</AlertDescription>
				</Alert>
			) : null}

			{org ? (
				<ProjectsField
					org={org}
					appName={appName}
					projects={projects}
					projectQuery={projectQuery}
					disabled={locked}
					fieldId={ids.projects}
					onMode={(mode) => form.setValue("projectMode", mode)}
					onToggle={(id, on) =>
						form.setValue("projectIds", on ? [...projectIds.filter((p) => p !== id), id] : projectIds.filter((p) => p !== id))
					}
					onQuery={(q) => form.setValue("projectQuery", q)}
				/>
			) : null}
			{blockers.noProject ? (
				<p role="alert" className="text-ui-sm text-text-primary">
					{COPY.noProject}
				</p>
			) : null}

			{changes ? (
				<div className="overflow-hidden rounded-lg border border-border">
					<p className="border-b border-border px-3 py-2 text-ui-sm font-medium text-text-primary">{COPY.changesLabel}</p>
					<ul className="space-y-1 px-3 py-2.5 text-ui-sm text-text-secondary">
						{changes.adds.length > 0 ? (
							<li>
								<b className="font-medium text-text-primary">{COPY.adds}</b>{" "}
								{joinWithAnd(changes.adds.map((s) => SCOPE_WORDS[s].label))}
							</li>
						) : null}
						{changes.removes.length > 0 ? (
							<li>
								<b className="font-medium text-text-primary">{COPY.removes}</b>{" "}
								{joinWithAnd(changes.removes.map((s) => SCOPE_WORDS[s].label))}
							</li>
						) : null}
						<li>{changes.projects.same ? COPY.projectsStay(changes.projects.label) : COPY.projectsChange(changes.projects.label)}</li>
					</ul>
				</div>
			) : null}

			<p className="text-ui-sm text-text-tertiary">
				{COPY.nameAndEmail(appName)} <b className="font-medium text-text-primary">{COPY.nameAndEmailWhere}</b>.
			</p>

			{networkError ? (
				<Alert role="alert" className="border-foreground">
					<TriangleAlert aria-hidden />
					<AlertTitle>{COPY.networkTitle}</AlertTitle>
					<AlertDescription>{COPY.networkBody}</AlertDescription>
				</Alert>
			) : refusal ? (
				<Alert role="alert" className="border-foreground">
					<TriangleAlert aria-hidden />
					<AlertDescription>{refusal}</AlertDescription>
				</Alert>
			) : null}

			<div className="flex gap-2">
				<Button type="button" variant="outline" size="lg" className="h-12 flex-1" disabled={submitting} onClick={onDeny}>
					{COPY.deny}
				</Button>
				<Button
					type="submit"
					size="lg"
					className="h-12 flex-1"
					disabled={isAllowBlocked(blockers) || submitting}
					pending={allowing}
				>
					{allowLabel({ verified: consent.verified, reconsent, submitting: allowing })}
				</Button>
			</div>
		</form>
	);
}

/** The signed-in account, first: "wrong account" must be seen before deciding (SPEC §5b, case 14). */
function AccountCard({ account, onSwitch, disabled }: { account: ConsentAccount; onSwitch: () => void; disabled: boolean }) {
	const initials = account.name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5" data-ph-mask>
			<Avatar className="size-8">
				{account.image ? <AvatarImage src={account.image} alt="" /> : null}
				<AvatarFallback className="text-ui-xs">{initials || account.email[0]?.toUpperCase()}</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<p className="truncate text-ui-md font-medium text-text-primary">{account.name}</p>
				<p className="truncate text-ui-sm text-text-tertiary">{account.email}</p>
			</div>
			<Button type="button" variant="link" size="sm" className="shrink-0 px-0" onClick={onSwitch} disabled={disabled}>
				{COPY.switchAccount}
			</Button>
		</div>
	);
}

/** Who is asking: a verified app's mark and publisher, or an unverified app's self-given name. */
function AppIdentity({ consent }: { consent: ReadyConsent }) {
	const { identity, verified, redirectHost } = consent;
	// A brand mark or an icon is shown only for an app whose identity Alethia fetched from its own
	// metadata document. An unverified app's name and icon are whatever it says, so it gets the
	// neutral glyph: a borrowed logo must not vouch for it.
	const mark = verified ? (identity.app?.mark ?? null) : null;
	const icon = verified ? identity.icon : null;
	return (
		<div className={cn("flex items-start gap-3 rounded-lg border px-3 py-3", verified ? "border-border" : "border-foreground")}>
			<span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
				<AgentIcon mark={mark} icon={icon} name={identity.name} size={28} />
			</span>
			<div className="min-w-0">
				{verified ? (
					<>
						<p className="text-ui-md font-medium text-text-primary">{identity.name}</p>
						<p className="text-ui-sm text-text-tertiary">
							{COPY.verifiedBy} <span className="font-mono">{identity.host}</span>
							{COPY.verifiedBySuffix}
						</p>
					</>
				) : (
					<>
						<p className="text-ui-md font-medium text-text-primary">
							“{identity.name}” <span className="font-normal text-text-tertiary">· {COPY.nameGivenByApp}</span>
						</p>
						<p className="text-ui-sm text-text-tertiary">
							{COPY.unverified}
							{redirectHost ? (
								<>
									{" "}
									{COPY.unverifiedRedirect} <span className="font-mono text-text-primary">{redirectHost}</span>.
								</>
							) : null}
						</p>
					</>
				)}
			</div>
		</div>
	);
}

interface OrgFieldProps {
	consent: ReadyConsent;
	orgId: string;
	orgQuery: string;
	onQuery: (q: string) => void;
	onChoose: (orgId: string) => void;
	disabled: boolean;
	hintId: string;
}

/** Where the app works: the person's workspace, a radio list, or a searchable one past five orgs. */
function OrgField({ consent, orgId, orgQuery, onQuery, onChoose, disabled, hintId }: OrgFieldProps) {
	const appName = consent.identity.name;
	const only = consent.orgs.length === 1 ? consent.orgs[0] : undefined;
	if (only?.personal) {
		return (
			<div className="space-y-1.5">
				<p className="text-ui-sm font-medium text-text-primary">{COPY.personalLabel}</p>
				<div className="rounded-lg border border-border px-3 py-2.5">
					<p className="text-ui-md font-medium text-text-primary">{COPY.personalTitle}</p>
					<p className="text-ui-sm text-text-tertiary">{COPY.personalBody(appName)}</p>
				</div>
			</div>
		);
	}
	const many = consent.orgs.length > MANY_ORGS;
	const q = orgQuery.trim().toLowerCase();
	const shown = many && q ? consent.orgs.filter((o) => o.name.toLowerCase().includes(q)) : consent.orgs;
	return (
		<fieldset className="space-y-1.5" disabled={disabled} aria-describedby={hintId}>
			<legend className="mb-1.5 text-ui-sm font-medium text-text-primary">{COPY.orgLegend}</legend>
			{many ? (
				<SearchBox
					label={COPY.orgSearchLabel}
					placeholder={COPY.orgSearchPlaceholder(consent.orgs.length)}
					value={orgQuery}
					onChange={onQuery}
				/>
			) : null}
			<div
				role="radiogroup"
				aria-label={COPY.orgLegend}
				className={cn("overflow-hidden rounded-lg border border-border", many && "max-h-[220px] overflow-y-auto")}
			>
				{shown.length === 0 ? (
					<p className="px-3 py-2.5 text-ui-sm text-text-tertiary">{COPY.orgNoMatch}</p>
				) : (
					shown.map((o) => (
						<label
							key={o.id}
							className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0"
						>
							<input
								type="radio"
								name="consent-org"
								value={o.id}
								checked={o.id === orgId}
								onChange={() => onChoose(o.id)}
								className="size-3.5 accent-[var(--ink)]"
							/>
							<span className="min-w-0 flex-1">
								<span className="flex min-w-0 items-baseline gap-1.5">
									<span className="truncate text-ui-md font-medium text-text-primary">{o.name}</span>
									{o.slug ? <span className="shrink-0 font-mono text-ui-sm text-text-tertiary">{o.slug}</span> : null}
								</span>
								<span className="block text-ui-sm text-text-tertiary">{many ? o.roleLabel : COPY.yourRole(o.roleLabel)}</span>
							</span>
							{o.refusal === "client_not_allowed" ? (
								<StatusBadge status="not-allowed" tier="failed" label={COPY.notAllowed} />
							) : null}
						</label>
					))
				)}
			</div>
			<p id={hintId} className="text-ui-sm text-text-tertiary">
				{COPY.orgHint(appName)}
			</p>
		</fieldset>
	);
}

/** The chosen org's alerts: refusals that block Allow, and the notices that do not. */
function OrgAlerts({ org, consent }: { org: ConsentOrgView; consent: ReadyConsent }) {
	const appName = consent.identity.name;
	return (
		<>
			{org.refusal === "agent_access_disabled" ? (
				<Alert role="alert" className="border-foreground">
					<Power aria-hidden />
					<AlertTitle>{COPY.offTitle(org.name)}</AlertTitle>
					<AlertDescription>{COPY.offBody(org.name)}</AlertDescription>
				</Alert>
			) : null}
			{org.refusal === "client_not_allowed" ? (
				<Alert role="alert" className="border-foreground">
					<Lock aria-hidden />
					<AlertTitle>{COPY.notAllowedTitle(org.name, appName)}</AlertTitle>
					<AlertDescription>{COPY.notAllowedBody(org.name, appName)}</AlertDescription>
				</Alert>
			) : null}
			{org.refusal === null && org.agentsKeptOffProduction ? (
				<Alert role="status">
					<Info aria-hidden />
					<AlertTitle>{COPY.noProdTitle(org.name)}</AlertTitle>
					<AlertDescription>{COPY.noProdBody(appName)}</AlertDescription>
				</Alert>
			) : null}
			{org.existing ? (
				<Alert role="status">
					<RefreshCw aria-hidden />
					<AlertTitle>{COPY.reconsentTitle(appName, org.name, formatDate(org.existing.createdAt))}</AlertTitle>
					<AlertDescription>{COPY.reconsentBody}</AlertDescription>
				</Alert>
			) : null}
		</>
	);
}

interface ProjectsFieldProps {
	org: ConsentOrgView;
	appName: string;
	projects: ProjectChoice;
	projectQuery: string;
	disabled: boolean;
	fieldId: string;
	onMode: (mode: "all" | "some") => void;
	onToggle: (id: string, on: boolean) => void;
	onQuery: (q: string) => void;
}

/** Which projects: all (present and future), or only the chosen ones; searchable past six. */
function ProjectsField({ org, appName, projects, projectQuery, disabled, fieldId, onMode, onToggle, onQuery }: ProjectsFieldProps) {
	if (org.projects.length === 0) {
		return (
			<div className="space-y-1.5">
				<p className="text-ui-sm font-medium text-text-primary">{COPY.projectsLegend}</p>
				<div className="rounded-lg border border-border px-3 py-2.5">
					<p className="text-ui-md font-medium text-text-primary">{COPY.allProjects}</p>
					<p className="text-ui-sm text-text-tertiary">
						{COPY.noProjects(org.personal ? COPY.noProjectsPersonal : org.name, appName)}
					</p>
				</div>
			</div>
		);
	}
	const many = org.projects.length > MANY_PROJECTS;
	const q = projectQuery.trim().toLowerCase();
	const shown = many && q ? org.projects.filter((p) => p.name.toLowerCase().includes(q)) : org.projects;
	const names = new Map(org.projects.map((p) => [p.id, p.name]));
	const chosen = projects.ids.map((id) => names.get(id) ?? id);
	return (
		<fieldset className="space-y-1.5" disabled={disabled}>
			<legend className="mb-1.5 text-ui-sm font-medium text-text-primary">{COPY.projectsLegend}</legend>
			<div className="overflow-hidden rounded-lg border border-border">
				<label className="flex cursor-pointer items-start gap-2.5 border-b border-border px-3 py-2.5">
					<input
						type="radio"
						name={`${fieldId}-mode`}
						checked={projects.mode === "all"}
						onChange={() => onMode("all")}
						className="mt-1 size-3.5 accent-[var(--ink)]"
					/>
					<span>
						<span className="block text-ui-md font-medium text-text-primary">{COPY.allProjects}</span>
						<span className="block text-ui-sm text-text-tertiary">{COPY.allProjectsWhy}</span>
					</span>
				</label>
				<div className="px-3 py-2.5">
					<label className="flex cursor-pointer items-start gap-2.5">
						<input
							type="radio"
							name={`${fieldId}-mode`}
							checked={projects.mode === "some"}
							onChange={() => onMode("some")}
							className="mt-1 size-3.5 accent-[var(--ink)]"
						/>
						<span className="text-ui-md font-medium text-text-primary">{COPY.someProjects}</span>
					</label>
					{projects.mode === "some" ? (
						<div className="mt-2 space-y-1.5 pl-6">
							{many ? (
								<SearchBox
									label={COPY.projectSearchLabel}
									placeholder={COPY.projectSearchPlaceholder(org.projects.length)}
									value={projectQuery}
									onChange={onQuery}
								/>
							) : null}
							<ul
								aria-label={COPY.someProjects}
								className={cn(
									many
										? "max-h-[220px] overflow-y-auto rounded-lg border border-border"
										: "flex flex-wrap gap-1.5",
								)}
							>
								{shown.map((p) => (
									<li key={p.id} className={cn(many && "border-b border-border last:border-b-0")}>
										<label
											className={cn(
												"flex cursor-pointer items-center gap-2 font-mono text-ui-sm text-text-primary",
												many ? "px-2.5 py-1.5" : "rounded-sm border border-border px-2 py-1",
											)}
										>
											<Checkbox
												checked={projects.ids.includes(p.id)}
												disabled={disabled}
												onCheckedChange={(next) => onToggle(p.id, next === true)}
												aria-label={p.name}
											/>
											{p.name}
										</label>
									</li>
								))}
							</ul>
							{many ? (
								<p className="text-ui-sm text-text-tertiary">
									{chosen.length ? COPY.projectsChosen(chosen.length, chosen.join(", ")) : COPY.noneChosenYet}
								</p>
							) : null}
						</div>
					) : null}
				</div>
			</div>
			{org.existing ? (
				<p className="text-ui-sm text-text-tertiary">
					{COPY.currently(existingProjectsPhrase(org))}
					{consentChanges(org, [], projects)?.projects.same ? ` ${COPY.noChange}` : null}
				</p>
			) : null}
		</fieldset>
	);
}

/** A labelled search field over a list. */
function SearchBox({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
	return (
		<label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5">
			<Search aria-hidden className="size-3.5 text-text-tertiary" />
			<span className="sr-only">{label}</span>
			<input
				type="search"
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.target.value)}
				className="min-w-0 flex-1 bg-transparent text-ui-md text-text-primary outline-none placeholder:text-text-tertiary"
			/>
		</label>
	);
}
