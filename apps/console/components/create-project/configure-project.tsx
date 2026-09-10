"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, ChevronLeft, Info, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	type CreateProjectInput,
	createProject,
} from "@/app/server/actions/projects";
import { getScanProposal } from "@/app/server/actions/scanner";
import {
	type CloudConnectResult,
	useCloudConnect,
} from "@/components/cloud-connect/use-cloud-connect";
import {
	DEFAULT_ENVIRONMENT_MATRIX,
} from "@/components/design-project/placement-selector";
import { DEFAULT_REGION, type CloudProviderSlug } from "@/lib/cloud-providers";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import { globalHref, projectHref } from "@/lib/routing";
import { canSlugify, slugify } from "@/lib/utils/slugify";
import type { ScanProposal } from "@/lib/scanner/schema";
import { SectionHeading } from "@repo/ui/section-heading";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";

import { CloudPicker } from "./cloud-picker";
import { EnvironmentPlacement } from "./environment-placement";
import { RegionSelect } from "./region-select";
import { SourceSummary } from "./source-summary";
import type { ScratchKind } from "./start-from-scratch-cards";
import { buildCreateInput, buildEmptyCreateInput } from "./templates";

/** The scan lifecycle union (mirrors `getScanProposal`). */
type ScanResult =
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal }
	| { status: "NOT_FOUND" };

/** What brought the user to Configure. */
type Source =
	| { kind: "import"; scanJobId: string; initial: ScanResult }
	| { kind: "scratch"; scratch: ScratchKind };

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
	template: { label: "Standard template", desc: "start from a template" },
	blank: { label: "Blank project", desc: "an empty canvas" },
	"byo-helm": { label: "BYO Helm chart", desc: "deploy via ArgoCD" },
	"byo-iac": { label: "BYO IaC module", desc: "plan · verify · apply" },
};

/**
 * `PROJECT_NAME_MAX_LENGTH`, as a LITERAL — the same 100 that
 * `lib/validations/project-form.schema.ts` states and that `updateProjectName` enforces.
 *
 * It is not imported, and the reason is mechanical: that constant lives in a module whose top
 * level calls `createInsertSchema(projects)`, so a VALUE import of it drags drizzle-zod and the
 * whole DB schema into this client bundle. What that argues for is a leaf module both sides read
 * — not for dropping the rule, which is what happened: this screen applied two of the schema's
 * three `project_name` rules, and the missing one is enforced NOWHERE on the create path
 * (`createProject` never parses its input and `projects.project_name` is unbounded `text()`).
 * A 500-character name was creatable, and then un-saveable under its own name, because
 * `updateProjectName` refuses over 100 — the create/rename asymmetry the schema comment above
 * those lines records as deliberately closed, re-opened in the other direction with no bound.
 *
 * The leaf-module extraction is the real fix and it touches `lib/validations/`, outside this
 * unit's scope. Until then this is a copy, and it is a copy of a value the schema's own unit test
 * pins (`tests/validations/project-form.schema.test.ts` asserts exactly this bound).
 */
const PROJECT_NAME_MAX = 100;

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

	// Initial name/region/cloud: from a READY proposal, else the first connected cloud (see below).
	const init = deriveInitial(source, integrations);
	const [scan, setScan] = useState<ScanResult | null>(
		source.kind === "import" ? source.initial : null,
	);
	const [name, setName] = useState(init.name);
	const [region, setRegion] = useState(init.region);
	const [identityId, setIdentityId] = useState<string | null>(init.identityId);
	const [provider, setProvider] = useState<CloudProviderSlug>(init.provider);
	const [environments, setEnvironments] = useState<EnvironmentSpec[]>(
		DEFAULT_ENVIRONMENT_MATRIX,
	);
	const [creating, setCreating] = useState(false);
	const prefilled = useRef(
		source.kind === "import" && source.initial.status === "READY",
	);

	// Import: poll the scan until it resolves, streaming the proposal into the rail and prefilling
	// name/region/cloud from it once (setState lives in the poll callback, not the effect body).
	useEffect(() => {
		if (source.kind !== "import") return;
		if (scan?.status !== "PENDING") return;
		let active = true;
		const t = setInterval(async () => {
			const r = await getScanProposal(source.scanJobId);
			if (!active) return;
			setScan(r);
			if (r.status === "READY" && !prefilled.current) {
				prefilled.current = true;
				const p = r.proposal;
				setName((n) => n || p.proposedProject.project.project_name || "");
				setRegion(p.proposedProject.project.region || DEFAULT_REGION[p.provider]);
				setIdentityId((id) => id ?? p.identityId);
				setProvider(p.provider);
			}
			if (r.status !== "PENDING") clearInterval(t);
		}, 2500);
		return () => {
			active = false;
			clearInterval(t);
		};
	}, [scan?.status, source]);

	const onCloud = (id: string, prov: CloudProviderSlug) => {
		setIdentityId(id);
		setProvider(prov);
		setRegion(DEFAULT_REGION[prov]);
	};

	// A cloud is required only when the create needs a provider — an import (its inferred stack targets
	// one) or a Template (its cluster preset is per-provider). Blank / BYO create an empty project with
	// no cloud (picked later on the canvas), exactly like the old "Create empty project" path.
	const requiresCloud =
		source.kind === "import" ||
		(source.kind === "scratch" && source.scratch === "template");
	const needsCloud = requiresCloud && !identityId;
	const slug = slugify(name, "project");

	/** Create the project (DRAFT) from the chosen source + settings, then open its canvas. */
	const onCreate = async () => {
		// ALL THREE rules `lib/validations/project-form.schema.ts` states for `project_name`, in the
		// wording that schema (or, for the bound, `updateProjectName`) states them in —
		// `.min(1, "Project name is required")`, `.max(PROJECT_NAME_MAX_LENGTH)` and
		// `.refine(canSlugify, "Enter at least one letter or number")`.
		//
		// This screen is the console's ONLY create path since `~/new` was rebuilt, and it applied
		// NONE of them. "Name your project." covered the first case in different words; the second
		// was unchecked, so `!!! @@@ ###` created a project whose slug came from `slugify`'s
		// FALLBACK — `/{org}/project` — with the user's symbols kept as the display name they then
		// have to address from the CLI. `canSlugify` is the same predicate the schema's refinement
		// calls, so that one cannot drift; the other two messages are hand-copied literals and can,
		// which is why each names the rule it mirrors.
		//
		// The bound's wording is `updateProjectName`'s, not the schema's: the schema passes no
		// message to `.max()`, so its text is zod's default ("String must contain at most 100
		// character(s)"), and the console already tells a user this in one sentence on the rename
		// path. One sentence for one rule, on both paths.
		if (!name.trim()) {
			toast.error("Project name is required");
			return;
		}
		if (name.length > PROJECT_NAME_MAX) {
			toast.error(`Project name must be ${PROJECT_NAME_MAX} characters or fewer`);
			return;
		}
		if (!canSlugify(name)) {
			toast.error("Enter at least one letter or number");
			return;
		}
		if (requiresCloud && !identityId) {
			toast.error("Connect and select a cloud account first.");
			return;
		}
		setCreating(true);
		const defaultEnvironment = {
			name: "production",
			stage: "production" as const,
			region,
		};
		try {
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
				if (!identityId) throw new Error("A cloud account is required.");
				input = buildCreateInput({
					projectName: name,
					template: "standard",
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
			const { project } = await createProject(input);
			router.push(`${projectHref(orgSlug, project.slug ?? "")}${attach}`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to create the project.",
			);
			setCreating(false);
		}
	};

	// ---- source-summary props ----
	const importRepo =
		source.kind === "import" && scan?.status === "READY"
			? repoLabel(scan.proposal)
			: source.kind === "import"
				? "your repository"
				: undefined;
	const scratchMeta =
		source.kind === "scratch" ? SCRATCH_META[source.scratch] : undefined;

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
					scanning={source.kind === "import" && scan?.status === "PENDING"}
					proposal={
						source.kind === "import" && scan?.status === "READY"
							? scan.proposal
							: null
					}
					scratchLabel={scratchMeta?.label}
					scratchDesc={scratchMeta?.desc}
				/>

				{/* right form */}
				<div className="flex flex-col gap-7">
					{source.kind === "import" && scan?.status === "NOT_FOUND" && (
						<Notice>
							We couldn’t find that scan. Go back and import the repository
							again.
						</Notice>
					)}

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
							onChange={(e) => setName(e.target.value)}
						/>
						<p className="mt-2 font-mono text-ui-xs text-muted-foreground">
							{orgSlug}/<span className="text-foreground">{slug}</span>
						</p>
					</Section>

					<Section n="02" title="Cloud & region" hint="one per project">
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

					<Section n="03" title="Environments" hint="placed on Fabrics">
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
							disabled={creating || needsCloud}
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
	source: Source,
	integrations: ConnectorWithConnection[],
): {
	name: string;
	region: string;
	identityId: string | null;
	provider: CloudProviderSlug;
} {
	if (source.kind === "import" && source.initial.status === "READY") {
		const p = source.initial.proposal;
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
