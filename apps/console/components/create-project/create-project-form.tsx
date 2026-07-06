"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Check, Loader2, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { createThread } from "@/app/server/actions/agent";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { addEnvironment, createProject } from "@/app/server/actions/projects";
import { track } from "@/lib/analytics/track";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ContainerPlatformSelector } from "@/components/design-project/container-platform-selector";
import {
	useCloudConnect,
	type CloudConnectResult,
} from "@/components/cloud-connect/use-cloud-connect";
import {
	DEFAULT_REGION,
	PROVIDERS,
	type CloudProviderSlug,
	type ConnectableCloudSlug,
} from "@/lib/cloud-providers";
import { globalHref, projectHref, slugify } from "@/lib/routing";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

import {
	buildCreateInput,
	buildEmptyCreateInput,
	type TemplateId,
} from "./templates";

/** Clouds with full provisioning templates today — the only ones a project can target. */
const PROVISIONABLE: CloudProviderSlug[] = ["aws", "gcp", "azure"];

/** Maps the platform-selector id to the template preset id used by buildCreateInput. */
const TEMPLATE_BY_PLATFORM: Record<string, TemplateId> = {
	standard: "standard",
	"ai-workloads": "ai",
	custom: "custom",
};

/** Example prompts seeding the agent hero. */
const EXAMPLE_PROMPTS = [
	"An EKS cluster for an AI inference API — autoscaling GPU node pool, Postgres + pgvector, Redis.",
	"A GPU training cluster on AWS — spot node pool, shared storage, a Postgres metadata database.",
	"Postgres + pgvector, Redis, and an object store wired into a small cluster for a RAG backend.",
];

const formSchema = z.object({
	prompt: z.string().optional(),
	// Free-text name; the URL slug is derived from it (slugPreview / createProject).
	project_name: z
		.string()
		.min(1, "Project name is required")
		.max(50)
		.refine((v) => slugify(v).length > 0, "Enter at least one letter or number"),
	template: z.string().min(1),
	// The selected cloud provider slug; connectedness/provisionability enforced at submit.
	cloud: z.string().min(1, "Select a connected cloud"),
});

type FormValues = z.infer<typeof formSchema>;

interface CreateProjectFormProps {
	orgSlug: string;
	canManage: boolean;
	/** Whether the org can invite collaborators (Pro). Drives the Collaborate pill. */
	canCollaborate: boolean;
	integrations: ConnectorWithConnection[];
	awsSetup: { externalId: string; identityId: string } | null;
	gcpSetup: { identityId: string } | null;
	azureSetup: { identityId: string } | null;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
}

/**
 * The quick create-project page: an agent prompt hero on top, then a short single-column manual
 * path (project name → template → cloud) with the create actions at the bottom. Templates reuse
 * {@link ContainerPlatformSelector}; the cloud picker uses the connectors connect sheet
 * ({@link useCloudConnect}). Every project is created with Production + Preview environments
 * automatically (no env UI). No pricing shown.
 */
export function CreateProjectForm({
	orgSlug,
	canManage,
	canCollaborate,
	integrations,
	awsSetup,
	gcpSetup,
	azureSetup,
	extraSetup,
}: CreateProjectFormProps) {
	const router = useRouter();
	const { openUpgrade } = useUpgradeSheet();
	const [creating, setCreating] = useState(false);
	const [creatingEmpty, setCreatingEmpty] = useState(false);
	const [launching, setLaunching] = useState(false);

	const cloudConnect: CloudConnectResult = useCloudConnect({
		integrations,
		awsSetup,
		gcpSetup,
		azureSetup,
		extraSetup,
	});

	const cloudIntegrations = useMemo(
		() => integrations.filter((i) => i.category === "cloud"),
		[integrations],
	);

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		mode: "onChange",
		defaultValues: { prompt: "", project_name: "", template: "ai-workloads", cloud: "" },
	});

	const name = form.watch("project_name");
	const template = form.watch("template");
	const cloud = form.watch("cloud");

	const provider = (PROVISIONABLE as string[]).includes(cloud)
		? (cloud as CloudProviderSlug)
		: null;

	/** Starts a design-agent thread from the hero prompt and opens the agent surface. */
	const onAskAgent = async () => {
		const prompt = form.getValues("prompt")?.trim();
		if (!prompt) {
			toast.error("Describe what you want to run first.");
			return;
		}
		setLaunching(true);
		try {
			await createThread(prompt);
			router.push(`${globalHref(orgSlug, "agent")}?prompt=${encodeURIComponent(prompt)}`);
		} catch {
			toast.error("Couldn't start a design session. Try again.");
			setLaunching(false);
		}
	};

	/** Creates the project from the manual path (Production + Preview envs) and opens its design page. */
	const onCreate = form.handleSubmit(async (values) => {
		if (!provider) {
			toast.error("Pick a connected cloud that supports provisioning (AWS, GCP or Azure).");
			return;
		}
		const selected = cloudIntegrations.find((i) => i.slug === values.cloud);
		const cloudIdentityId =
			selected?.accounts?.[0]?.identityId ??
			selected?.connection_details?.cloud_identity_id;
		if (!cloudIdentityId) {
			toast.error("That cloud isn't connected. Connect it first.");
			return;
		}

		const region = DEFAULT_REGION[provider];
		setCreating(true);
		try {
			const { project } = await createProject(
				buildCreateInput({
					projectName: values.project_name,
					template: TEMPLATE_BY_PLATFORM[values.template] ?? "standard",
					provider,
					cloudIdentityId,
					defaultEnvironment: { name: "production", stage: "production", region },
				}),
			);
			await addEnvironment(project.id, {
				name: "preview",
				stage: "development",
				region,
			});

			track("project_created", { provider, template: values.template });
			toast.success("Project created — start designing.");
			router.push(projectHref(orgSlug, project.slug ?? ""));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create project.");
			setCreating(false);
		}
	});

	/** Creates a blank project (name only, no cloud/template) with Production + Preview envs. */
	const onCreateEmpty = async () => {
		if (!(await form.trigger("project_name"))) return;
		const projectName = form.getValues("project_name");
		const region = DEFAULT_REGION.aws;
		setCreatingEmpty(true);
		try {
			const { project } = await createProject(
				buildEmptyCreateInput({
					projectName,
					defaultEnvironment: { name: "production", stage: "production", region },
				}),
			);
			await addEnvironment(project.id, {
				name: "preview",
				stage: "development",
				region,
			});

			toast.success("Empty project created — start designing.");
			router.push(projectHref(orgSlug, project.slug ?? ""));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create project.");
			setCreatingEmpty(false);
		}
	};

	const slugPreview = slugify(name) || "project";
	const busy = creating || creatingEmpty;

	return (
		<div className="mx-auto w-full max-w-3xl space-y-8 pb-20">
			{/* ===== agent hero ===== */}
			<section className="space-y-5">
				<div className="flex items-center justify-between gap-4">
					<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
						Provision the future.
					</h1>
					{canCollaborate ? (
						<Link
							href={globalHref(orgSlug, "settings/members")}
							className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<Users className="size-3.5" />
							Collaborate
						</Link>
					) : (
						<button
							type="button"
							onClick={openUpgrade}
							className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<Users className="size-3.5" />
							Collaborate
							<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider text-muted-foreground">
								Pro
							</span>
						</button>
					)}
				</div>

				<div className="rounded-xl border border-border bg-card shadow-sm focus-within:border-ring">
					<div className="flex items-start gap-3 p-4 pb-2">
						<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-foreground text-background">
							<Sparkles className="size-4" />
						</span>
						<Textarea
							{...form.register("prompt")}
							rows={2}
							placeholder="Ask the design agent to design your infrastructure — e.g. an EKS cluster for an AI inference API, with a Postgres + pgvector store…"
							className="min-h-0 resize-none border-0 bg-transparent p-0 pt-1 text-[15px] shadow-none focus-visible:ring-0"
							onKeyDown={(e) => {
								if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
									e.preventDefault();
									void onAskAgent();
								}
							}}
						/>
					</div>
					<div className="flex items-center justify-between px-4 pb-3">
						<span className="font-mono text-[10px] text-muted-foreground">⌘ + ⏎</span>
						<Button
							type="button"
							size="icon"
							className="size-9"
							onClick={() => void onAskAgent()}
							disabled={launching}
							aria-label="Design with the agent"
						>
							{launching ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<ArrowRight className="size-4" />
							)}
						</Button>
					</div>
				</div>

				<div className="flex flex-wrap gap-2">
					{EXAMPLE_PROMPTS.map((ex) => (
						<button
							key={ex}
							type="button"
							onClick={() => form.setValue("prompt", ex, { shouldDirty: true })}
							className="rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							{ex.split(" — ")[0]}
						</button>
					))}
				</div>
			</section>

			{/* ===== divider ===== */}
			<div className="flex items-center gap-4 py-2">
				<span className="h-px flex-1 bg-border" />
				<span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
					Or configure manually
				</span>
				<span className="h-px flex-1 bg-border" />
			</div>

			{/* ===== 01 project ===== */}
			<section className="space-y-4">
				<BlockHead num="01" title="Project" />
				<div className="space-y-2">
					<Label htmlFor="project_name" className="text-xs text-muted-foreground">
						Project name
					</Label>
					<Input
						id="project_name"
						autoComplete="off"
						placeholder="My Project"
						{...form.register("project_name")}
					/>
					{form.formState.errors.project_name ? (
						<p className="text-xs text-destructive">
							{form.formState.errors.project_name.message}
						</p>
					) : (
						<p className="font-mono text-[11px] text-muted-foreground">
							{orgSlug}/<span className="text-foreground">{slugPreview}</span>
						</p>
					)}
				</div>
			</section>

			{/* ===== 02 template ===== */}
			<section className="space-y-4">
				<BlockHead num="02" title="Template" />
				<ContainerPlatformSelector
					selected={template}
					onSelect={(p) => form.setValue("template", p)}
				/>
			</section>

			{/* ===== 03 cloud ===== */}
			<section className="space-y-4">
				<BlockHead num="03" title="Cloud" hint="one per project" />
				<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
					{cloudIntegrations.map((integration) => (
						<CloudTile
							key={integration.id}
							integration={integration}
							canManage={canManage}
							selected={cloud === integration.slug}
							isConnecting={cloudConnect.connectingSlug === integration.slug}
							onSelect={() => form.setValue("cloud", integration.slug)}
							onConnect={() => cloudConnect.openConnect(integration)}
						/>
					))}
				</div>
				{form.formState.errors.cloud && (
					<p className="text-xs text-destructive">
						{form.formState.errors.cloud.message}
					</p>
				)}
			</section>

			{/* ===== actions ===== */}
			<div className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:justify-end">
				<Button
					type="button"
					variant="outline"
					onClick={() => void onCreateEmpty()}
					disabled={busy}
				>
					{creatingEmpty ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Create empty project"
					)}
				</Button>
				<Button
					type="button"
					className="cta-shine sm:min-w-44"
					onClick={() => void onCreate()}
					disabled={busy}
				>
					{creating ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							Create project
							<ArrowRight className="size-4" />
						</>
					)}
				</Button>
			</div>

			{cloudConnect.sheets}
		</div>
	);
}

/** A numbered section heading ("01 · Project") with a trailing rule and optional hint. */
function BlockHead({
	num,
	title,
	hint,
}: {
	num: string;
	title: string;
	hint?: string;
}) {
	return (
		<div className="flex items-baseline gap-3">
			<span className="font-mono text-[11px] text-muted-foreground">{num}</span>
			<h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
			<span className="h-px flex-1 self-center bg-border" />
			{hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
		</div>
	);
}

interface CloudTileProps {
	integration: ConnectorWithConnection;
	canManage: boolean;
	selected: boolean;
	isConnecting: boolean;
	onSelect: () => void;
	onConnect: () => void;
}

/**
 * A compact cloud tile (matches the design's `.cloud`): a connected + provisionable cloud is a
 * radio-style pick; a not-connected cloud shows a Connect affordance that opens the connect sheet;
 * connected-but-not-provisionable clouds (alibaba/DO/hetzner/civo) read "Provisioning soon".
 */
function CloudTile({
	integration,
	canManage,
	selected,
	isConnecting,
	onSelect,
	onConnect,
}: CloudTileProps) {
	const connected = integration.connected;
	const provisionable = (PROVISIONABLE as string[]).includes(integration.slug);
	const selectable = connected && provisionable;
	const label =
		PROVIDERS[integration.slug as ConnectableCloudSlug]?.shortName ?? integration.name;
	const status = !connected
		? "Not connected"
		: provisionable
			? "Connected"
			: "Provisioning soon";

	return (
		<div
			className={cn(
				"relative flex min-h-[104px] flex-col gap-3 rounded-lg border p-3.5 transition-colors",
				selected
					? "border-foreground bg-accent ring-1 ring-foreground"
					: connected
						? "border-border bg-card hover:bg-accent/40"
						: "border-dashed border-border bg-card",
				selectable && "cursor-pointer",
			)}
			onClick={selectable ? onSelect : undefined}
		>
			{selectable ? (
				<span
					className={cn(
						"absolute right-3 top-3 grid size-[18px] place-items-center rounded-full border",
						selected
							? "border-foreground bg-foreground text-background"
							: "border-border text-transparent",
					)}
					aria-hidden
				>
					<Check className="size-3" />
				</span>
			) : !connected && canManage ? (
				<button
					type="button"
					onClick={onConnect}
					disabled={isConnecting}
					className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-foreground hover:text-background"
				>
					{isConnecting && <Loader2 className="size-3 animate-spin" />}
					Connect
				</button>
			) : null}

			<ConnectorIcon
				src={integration.icon_url}
				name={label}
				size={26}
				mono={!connected}
			/>
			<div>
				<div className="text-sm font-medium">{label}</div>
				<div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
					<span
						className={cn(
							"size-1.5 rounded-full",
							connected ? "bg-foreground" : "border-[1.5px] border-border",
						)}
					/>
					{status}
				</div>
			</div>
		</div>
	);
}
