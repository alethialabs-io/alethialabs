"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, ChevronLeft, Info, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	type CreateProjectInput,
	type CreateProjectResult,
	tryCreateProject,
} from "@/app/server/actions/projects";
import {
	type CloudConnectResult,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
import {
	DEFAULT_ENVIRONMENT_MATRIX,
} from "@/components/design-project/placement-selector";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { DEFAULT_REGION, type CloudProviderSlug } from "@/lib/cloud-providers";
import { errorDigest } from "@/lib/errors";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import { globalHref, projectHref } from "@/lib/routing";
import { canSlugify, slugify } from "@/lib/utils/slugify";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/validations/project-form.schema";
import { orpc } from "@/lib/rpc/client";
import type { ScanProposal } from "@/lib/scanner/schema";
import { SectionHeading } from "@repo/ui/section-heading";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";

import { CloudPicker } from "./cloud-picker";
import { EnvironmentPlacement } from "./environment-placement";
import { RegionSelect } from "./region-select";
import { SourceSummary } from "./source-summary";
import type { ScratchKind } from "./start-from-scratch-cards";
import { TemplatePicker } from "./template-picker";
import {
	DEFAULT_TEMPLATE,
	type TemplateId,
	buildCreateInput,
	buildEmptyCreateInput,
	templateOption,
} from "./templates";
import { type ScanResult, useNameAvailability, useScanResult } from "./use-create-project-reads";

/** What brought the user to Configure. The import's scan is READ here (`useScanResult`), from the
 * cache the route hydrated — never handed over as a prop that could not follow it. */
type Source =
	| { kind: "import"; scanJobId: string }
	| { kind: "scratch"; scratch: ScratchKind };

/** The project a successful create returns. */
type CreatedProject = Extract<CreateProjectResult, { ok: true }>["project"];

/** What the create mutation is handed: the input, and where the canvas opens (`?attachChart=1` …). */
interface CreateVariables {
	input: CreateProjectInput;
	attach: string;
}

/**
 * `tryCreateProject` in the mutation contract's shape (ADR 0005 D4). Its refusals — a name the org
 * holds or no schema accepts, a stored credential, an unusable cloud account — are sentences written
 * for the user and all are rendered beside the name field, so they travel as a `validation` error on
 * `project_name`: `useActionMutation` routes that to the field and NOT to a toast, which is what
 * stops a duplicate name being reported twice (F035). An unexpected failure is thrown out of a
 * `"use server"` export as a digest; it becomes the contract's `unexpected`, toasted once with that
 * digest as its reference.
 */
async function createProjectAction({ input }: CreateVariables): Promise<ActionResult<CreatedProject>> {
	try {
		const res = await tryCreateProject(input);
		if (res.ok) return { ok: true, data: res.project };
		return {
			ok: false,
			error: { kind: "validation", message: res.error, fields: { project_name: [res.error] } },
		};
	} catch (err) {
		return { ok: false, error: { kind: "unexpected", ref: errorDigest(err) ?? "unavailable" } };
	}
}

/**
 * Every read a new project changes: the shell's list (switcher, breadcrumbs, palette — F036: the new
 * project was missing from the switcher until a reload), the setup guide, the usage counts, and the
 * two reads that answer against the org's project names.
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

interface ConfigureProjectProps {
	orgSlug: string;
	source: Source;
	canManage: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	platformConfigured: Record<string, boolean>;
	byoHelmEnabled?: boolean;
	byoIacEnabled?: boolean;
}

const SCRATCH_META: Record<ScratchKind, { label: string; desc: string }> = {
	// The template's LABEL is the picked template's title (see `scratchMeta` below); this is the
	// fallback before anything renders.
	template: { label: "Template", desc: "start from a template" },
	blank: { label: "Blank project", desc: "an empty canvas" },
	"byo-helm": { label: "BYO Helm chart", desc: "deploy via ArgoCD" },
	"byo-iac": { label: "BYO IaC module", desc: "plan · verify · apply" },
};

/** Narrow a verified identity's provider string to a slug (defaults to aws). */
function toProvider(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" || p === "alibaba" || p === "hetzner"
		? p
		: "aws";
}

/**
 * **Step 2 — Configure your project.** The split source-rail + config form reached after a source is
 * chosen (`?scan=` import or `?scratch=` on-ramp). It names the project, picks the cloud + region
 * (reusing the real connector cards) and the environment placement (#844), then **creates the project
 * immediately** (a DRAFT — nothing provisioned) and lands on its Architecture canvas to refine +
 * deploy. Assembles a `CreateProjectInput` and calls the same `createProject` the canvas Save uses —
 * no new backend. For an import it streams the scan proposal into the rail while the scan runs.
 */
export function ConfigureProject({
	orgSlug,
	source,
	canManage,
	integrations,
	awsSetup,
	gcpSetup,
	azureSetup,
	extraSetup,
	platformConfigured,
	byoHelmEnabled,
	byoIacEnabled,
}: ConfigureProjectProps) {
	const router = useRouter();
	const cloudConnect: CloudConnectResult = useCloudConnect({
		integrations,
		awsSetup,
		gcpSetup,
		azureSetup,
		extraSetup,
	});

	// The import's scan, live over the `jobs` topic — no poll (#6131). Null for a scratch on-ramp.
	const { result: scan, retry: retryScan } = useScanResult(
		source.kind === "import" ? source.scanJobId : null,
	);
	// Initial name/region/cloud: from a READY proposal, else the first connected cloud (see below).
	// The route hydrated the scan, so a scan that was already READY is READY on this first render.
	const [init] = useState(() => deriveInitial(scan, integrations));
	const [name, setName] = useState(init.name);
	const [region, setRegion] = useState(init.region);
	const [identityId, setIdentityId] = useState<string | null>(init.identityId);
	const [provider, setProvider] = useState<CloudProviderSlug>(init.provider);
	const [environments, setEnvironments] = useState<EnvironmentSpec[]>(
		DEFAULT_ENVIRONMENT_MATRIX,
	);
	// Only read on the `?scratch=template` path; it picks the starter repository and the webhook-CA
	// marker (#4990: the AI template declares KServe), not the cluster.
	const [template, setTemplate] = useState<TemplateId>(DEFAULT_TEMPLATE);
	// The server's reason for refusing this create, rendered beside the field it is about. NOT form
	// state — it is what came back, so it is cleared when the name changes or on the next attempt.
	const [refusal, setRefusal] = useState<string | null>(null);
	// Whether the proposal has filled name/region/cloud yet — once, the first time it is READY.
	const [prefilled, setPrefilled] = useState(scan?.status === "READY");

	// The scan finishing while the screen is open: prefill name/region/cloud from the proposal ONCE.
	// Adjusted during render, not in an effect, so no committed frame shows a READY rail beside an
	// empty form (React's "storing information from previous renders").
	if (!prefilled && scan?.status === "READY") {
		setPrefilled(true);
		const p = scan.proposal;
		setName((n) => n || p.proposedProject.project.project_name || "");
		setRegion(p.proposedProject.project.region || DEFAULT_REGION[p.provider]);
		setIdentityId((id) => id ?? p.identityId);
		setProvider(p.provider);
	}

	const create = useActionMutation(createProjectAction, {
		invalidates: projectsChangedKeys(),
		onValidationError: (fields) => setRefusal(fields.project_name?.[0] ?? null),
		onSuccess: (project, { attach }) =>
			router.push(`${projectHref(orgSlug, project.slug ?? "")}${attach}`),
	});
	// A successful create stays "busy" until the canvas replaces this screen, so the button cannot
	// be pressed a second time during the navigation (the double-submit guard covers both halves).
	const creating = create.isPending || create.isSuccess;

	const onCloud = (id: string, prov: CloudProviderSlug) => {
		setIdentityId(id);
		setProvider(prov);
		setRegion(DEFAULT_REGION[prov]);
	};

	// A cloud is required only when the create needs a provider — an import (its inferred stack targets
	// one) or a Template (its cluster preset is per-provider). Blank / BYO create an empty project with
	// no cloud (picked later on the canvas), exactly like the old "Create empty project" path.
	const isTemplate = source.kind === "scratch" && source.scratch === "template";
	const requiresCloud = source.kind === "import" || isTemplate;
	const needsCloud = requiresCloud && !identityId;

	// The name the field holds passes the three client rules (below) — only such a name is checked
	// against the org, and only its slug is previewed from the server.
	const nameIsWellFormed =
		name.trim().length > 0 && name.length <= PROJECT_NAME_MAX_LENGTH && canSlugify(name);
	const { availability, checking } = useNameAvailability(name, nameIsWellFormed);
	// The slug the project will REALLY get — de-duplicated against the org's, as the create does —
	// once the server has answered for this name; the local derivation until then (F035).
	const slug = availability?.slug ?? slugify(name, "project");
	// A name the org already holds, said while typing rather than after Create (F035). The server's
	// own refusal, when there is one, takes the slot.
	const taken =
		refusal === null && availability?.available === false
			? `A project named "${name.trim()}" already exists in this organization.`
			: null;
	const fieldError = refusal ?? taken;

	/**
	 * Show `msg` as this screen's refusal — inline beside the name, and ONLY there. It used to be a
	 * toast as well, so one refusal was reported twice (F035); the field is where it can be fixed.
	 */
	const refuse = (msg: string) => {
		setRefusal(msg);
	};

	/** Create the project (DRAFT) from the chosen source + settings, then open its canvas. */
	const onCreate = () => {
		if (creating) return;
		setRefusal(null);
		// ALL THREE rules `lib/validations/project-form.schema.ts` states for `project_name` —
		// `.min(1, "Project name is required")`, `.max(PROJECT_NAME_MAX_LENGTH)` and
		// `.refine(canSlugify, "Enter at least one letter or number")`.
		//
		// This screen is the console's ONLY create path since `~/new` was rebuilt, and it applied
		// NONE of them. "Name your project." covered the first case in different words; the second
		// was unchecked, so `!!! @@@ ###` created a project whose slug came from `slugify`'s
		// FALLBACK — `/{org}/project` — with the user's symbols kept as the display name they then
		// have to address from the CLI.
		//
		// WHY THE BOUND IS HERE AT ALL, since a maximum length reads like a formality: it is the
		// half of the create/rename asymmetry the create side owes. `updateProjectName` refuses a
		// name over `PROJECT_NAME_MAX_LENGTH`, so a longer name created here is a project that
		// cannot be re-saved under its own name — and the schema's comment beside that `.max()`
		// records the previous round of exactly this bug, when the two paths disagreed at 50 vs
		// 100. The predicate and the constant are both READ FROM the schema for that reason: they
		// are the same rule, not two copies of it.
		//
		// The bound's wording is `updateProjectName`'s, not the schema's — the schema passes no
		// message to `.max()`, so its text is zod's default phrasing rather than a sentence
		// written for a user, and the console already says this one on the rename path. The
		// NUMBER in it is interpolated, never typed, for the same reason as the check above it.
		//
		// SINCE #4644 these are no longer the only place they are applied: `createProject` parses
		// the name server-side too, so a request that never went through this screen gets the same
		// three rules. These stay because they answer without a round trip, and because they are
		// now the SAME rules rather than a second opinion.
		if (!name.trim()) {
			refuse("A project name is required");
			return;
		}
		if (name.length > PROJECT_NAME_MAX_LENGTH) {
			refuse(
				`Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer`,
			);
			return;
		}
		if (!canSlugify(name)) {
			refuse("Enter at least one letter or number");
			return;
		}
		if (requiresCloud && !identityId) {
			refuse("Connect and select a cloud account first.");
			return;
		}
		const defaultEnvironment = {
			name: "production",
			stage: "production" as const,
			region,
		};
		let input: CreateProjectInput;
		let attach = "";
		if (source.kind === "import" && scan?.status === "READY") {
			const base = scan.proposal.proposedProject;
			input = {
				...base,
				project: {
					...base.project,
					project_name: name,
					region,
					cloud_identity_id: identityId,
					environments,
				},
			};
		} else if (source.kind === "scratch" && source.scratch === "template") {
			// requiresCloud guarantees a cloud for the template path; narrow for buildCreateInput.
			if (!identityId) {
				refuse("Connect and select a cloud account first.");
				return;
			}
			input = buildCreateInput({
				projectName: name,
				template,
				provider,
				cloudIdentityId: identityId,
				defaultEnvironment,
				environments,
			});
		} else {
			input = buildEmptyCreateInput({
				projectName: name,
				defaultEnvironment,
				environments,
			});
			if (source.kind === "scratch" && source.scratch === "byo-helm")
				attach = "?attachChart=1";
			if (source.kind === "scratch" && source.scratch === "byo-iac")
				attach = "?attachIac=1";
		}
		// `tryCreateProject`, not `createProject`: a refusal thrown out of a `"use server"` export is
		// redacted to a digest in a production build, so the sentence the action wrote — "a project
		// named … already exists" — never reached this screen and the create simply looked broken
		// (#4644). `createProjectAction` returns it as a value; the mutation renders it beside the
		// name, and toasts only what remains — an unexpected failure the user cannot act on.
		create.mutate({ input, attach });
	};

	// ---- source-summary props ----
	const importRepo =
		scan?.status === "READY"
			? repoLabel(scan.proposal)
			: source.kind === "import"
				? "your repository"
				: undefined;
	const scratchMeta =
		source.kind === "scratch"
			? isTemplate
				? { ...SCRATCH_META.template, label: `${templateOption(template).title} template` }
				: SCRATCH_META[source.scratch]
			: undefined;
	// Section numbers follow what is on screen: the Template section exists only for a template.
	const sectionNo = (i: number) => String(i + (isTemplate ? 1 : 0)).padStart(2, "0");

	return (
		<div className="w-full">
			<div className="mb-[22px] flex items-center gap-3">
				<button
					type="button"
					onClick={() => router.push(globalHref(orgSlug, "new"))}
					className="grid size-8 shrink-0 place-items-center rounded-none border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
					aria-label="Back to source"
				>
					<ChevronLeft className="size-4" />
				</button>
				{/* A section heading: this names the STEP, not the route. The breadcrumb says
				    "New project" for all three steps, so nothing above the page says which one you
				    are on except the stepper on the right. */}
				<SectionHeading
					className="flex-1"
					title="Configure your project"
					description="Set the essentials — you’ll review and deploy the full design on the canvas."
				/>
				<span className="hidden font-mono text-ui-2xs uppercase tracking-[0.14em] text-muted-foreground sm:block">
					source · <span className="text-foreground">configure</span> · canvas
				</span>
			</div>

			<div className="grid gap-6 lg:grid-cols-[336px_1fr]">
				{/* left rail */}
				<SourceSummary
					mode={source.kind}
					repo={importRepo}
					scanning={scan?.status === "PENDING"}
					proposal={scan?.status === "READY" ? scan.proposal : null}
					scratchLabel={scratchMeta?.label}
					scratchDesc={scratchMeta?.desc}
				/>

				{/* right form */}
				<div className="flex flex-col gap-7">
					{scan && <ScanNotice scan={scan} onRetry={retryScan} />}

					<Section n="01" title="Project">
						{/* The section heading above says "Project", not "Project name", and it labels
						    the SECTION rather than this control — so without a name of its own the
						    only handle on the console's one project-name field was `#project_name`,
						    a CSS id. Two e2e files reach for it that way today. `aria-label` gives
						    the control the name the field has everywhere else in the console
						    (`settings/general`'s rename field is labelled "Project name"), which is
						    also what axe's `label` rule wants of a text input. The id is unchanged:
						    the existing `#project_name` locators keep working. */}
						<Input
							id="project_name"
							aria-label="Project name"
							value={name}
							autoComplete="off"
							placeholder="my-project"
							aria-invalid={fieldError !== null}
							aria-describedby={fieldError ? "project_name_error" : undefined}
							onChange={(e) => {
								setName(e.target.value);
								// The refusal was about the name that was there; this is a new one.
								setRefusal(null);
							}}
						/>
						{/* The refusal, BESIDE THE FIELD IT IS ABOUT and not only in a toast: a toast is
						    gone in four seconds and the name that caused it is still in the box. This is the
						    half of #4644 a `digest` made pointless — the sentence exists, so show it.
						    `role="alert"` because nothing else on this screen changes when a create is
						    refused, and `aria-describedby` so the field itself carries the reason. */}
						{/* A taken name found while typing is a STATUS (announced politely, it is not
						    the answer to anything the user pressed); a refusal the Create button got
						    back is an ALERT. One slot, so the field is described by whichever applies. */}
						{fieldError && (
							<p
								id="project_name_error"
								role={refusal ? "alert" : "status"}
								className="mt-2 text-ui-xs text-destructive"
							>
								{fieldError}
							</p>
						)}
						<p
							className="mt-2 font-mono text-ui-xs text-muted-foreground"
							aria-busy={checking || undefined}
						>
							{orgSlug}/<span className="text-foreground">{slug}</span>
						</p>
					</Section>

					{isTemplate && (
						<Section n="02" title="Template" hint="picks a starter repository">
							<TemplatePicker value={template} onChange={setTemplate} />
						</Section>
					)}

					<Section n={sectionNo(2)} title="Cloud & region" hint="one per project">
						{needsCloud && (
							<Notice className="mb-3">
								{source.kind === "import"
									? "The scan needs a verified cloud account to place your infrastructure. Connect one below to continue."
									: "Connect a cloud account to provision this project into."}
							</Notice>
						)}
						<CloudPicker
							integrations={integrations}
							canManage={canManage}
							platformConfigured={platformConfigured}
							cloudConnect={cloudConnect}
							selectedIdentityId={identityId}
							onSelect={onCloud}
						/>
						<div className="mt-3 flex items-center gap-3">
							<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-muted-foreground">
								Region
							</span>
							<RegionSelect
								provider={provider}
								value={region}
								onChange={setRegion}
								disabled={needsCloud}
							/>
						</div>
					</Section>

					<Section n={sectionNo(3)} title="Environments" hint="placed on Fabrics">
						<EnvironmentPlacement
							value={environments}
							onChange={setEnvironments}
						/>
					</Section>

					<div className="flex items-center justify-between gap-4 border-t border-border pt-5">
						<span className="text-ui-xs text-muted-foreground">
							Creates a draft — nothing provisioned yet.
						</span>
						<Button
							type="button"
							className="min-w-44"
							onClick={onCreate}
							disabled={creating || needsCloud || taken !== null}
						>
							{creating ? (
								<Loader2 className="size-4 animate-spin" />
							) : needsCloud ? (
								"Connect a cloud to continue"
							) : (
								<>
									Create project
									<ArrowRight className="size-4" />
								</>
							)}
						</Button>
					</div>
				</div>
			</div>

			{cloudConnect.sheets}
		</div>
	);
}

/** Initial form values: from a READY scan proposal, else the first connected cloud identity. */
function deriveInitial(
	scan: ScanResult | null,
	integrations: ConnectorWithConnection[],
): {
	name: string;
	region: string;
	identityId: string | null;
	provider: CloudProviderSlug;
} {
	if (scan?.status === "READY") {
		const p = scan.proposal;
		return {
			name: p.proposedProject.project.project_name || "",
			region: p.proposedProject.project.region || DEFAULT_REGION[p.provider],
			identityId: p.identityId,
			provider: p.provider,
		};
	}
	const first = integrations
		.filter((i) => i.category === "cloud" && i.connected)
		.flatMap((i) =>
			(i.accounts ?? []).map((a) => ({ id: a.identityId, prov: i.slug })),
		)[0];
	if (first) {
		const prov = toProvider(first.prov);
		return {
			name: "",
			region: DEFAULT_REGION[prov],
			identityId: first.id,
			provider: prov,
		};
	}
	return { name: "", region: DEFAULT_REGION.aws, identityId: null, provider: "aws" };
}

/** `owner/repo` from a proposal's primary repo, else a friendly fallback. */
function repoLabel(proposal: ScanProposal): string {
	const url = proposal.proposedProject.source_repos?.[0]?.repo_url;
	if (!url) return "your repository";
	try {
		return new URL(url).pathname.replace(/^\/+|\.git$/g, "");
	} catch {
		return url;
	}
}

/** A numbered configure section. */
function Section({
	n,
	title,
	hint,
	children,
}: {
	n: string;
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<section>
			{/* The number, the rule and the right-hand hint are this wizard's own chrome and stay
			    local; the HEADING is the shared one, so a configure step is typeset at the same
			    rung as every other section heading in the console rather than at this file's. */}
			<div className="mb-3 flex items-baseline gap-3">
				<span className="font-mono text-ui-xs text-muted-foreground">{n}</span>
				<SectionHeading title={title} />
				<span className="h-px flex-1 self-center bg-border" />
				{hint && (
					<span className="text-ui-xs text-muted-foreground">{hint}</span>
				)}
			</div>
			{children}
		</section>
	);
}

/**
 * What the form says about an import's scan when it is not simply running or ready: gone, failed,
 * or unreadable — three different things, so three different sentences (RUBRIC B4). Running and
 * ready are the rail's to show.
 */
function ScanNotice({ scan, onRetry }: { scan: ScanResult; onRetry: () => void }) {
	if (scan.status === "NOT_FOUND") {
		return <Notice>We couldn’t find that scan. Go back and import the repository again.</Notice>;
	}
	if (scan.status === "FAILED") {
		return (
			<Notice>
				The scan didn’t finish ({scan.jobStatus.toLowerCase()}). Go back and import the
				repository again, or start from scratch.
			</Notice>
		);
	}
	if (scan.status === "ERROR") {
		return (
			<Notice>
				We couldn’t check on the scan.{" "}
				<button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground">
					Try again
				</button>
			</Notice>
		);
	}
	return null;
}

/** A muted inline notice (needs-cloud / errors). */
function Notice({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={`flex items-start gap-2.5 border border-border border-l-2 border-l-muted-foreground bg-muted/40 px-3 py-2.5 text-ui-sm text-muted-foreground ${className ?? ""}`}
		>
			<Info className="mt-0.5 size-4 shrink-0" />
			<span>{children}</span>
		</div>
	);
}
