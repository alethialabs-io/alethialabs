"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Boxes, ExternalLink, GitBranch, LayoutTemplate, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { SegmentedControl } from "@repo/ui/segmented-control";
import { TEMPLATE_OPTIONS, type TemplateId } from "@/components/create-project/templates";
import { PROVIDERS, type CloudProviderSlug } from "@/lib/cloud-providers";

/** What the board is, in one sentence. The guide and its picture say the same words. */
export const BOARD_SENTENCE =
	"This environment is one Kubernetes cluster. Size it, add what runs on it, then review the plan.";

/** Why an attach start is not offered on this instance. */
export const NOT_ENABLED = "Not enabled on this instance.";

/**
 * The clouds a template can be sized for when the project has none yet: the server's list, or why
 * there is no list to choose from.
 */
export type CloudChoices =
	| { readonly status: "ready"; readonly clouds: readonly CloudProviderSlug[] }
	| { readonly status: "loading" }
	| { readonly status: "error" };

/** A template that is applied to the board right now, and what to do with its starter. */
export interface AppliedTemplateNote {
	title: string;
	cloud: string;
	sentence: string;
	starter: { name: string; url: string } | null;
}

/** Everything the guide draws and every start it offers. It holds no board state of its own. */
export interface BoardGuideViewProps {
	/** The project's own cloud, when it has one: templates are sized for it and nothing is asked. */
	projectCloud: CloudProviderSlug | null;
	/** The clouds to choose from when the project has none. */
	cloudChoices: CloudChoices;
	/** Size the cluster from a template on a cloud. */
	onTemplate: (templateId: TemplateId, provider: CloudProviderSlug) => void;
	/** Open the Add picker. */
	onAdd: () => void;
	/** Open the attach flow for the user's own Helm chart; absent when the instance has it off. */
	onAttachChart?: () => void;
	/** Open the attach flow for the user's own IaC module; absent when the instance has it off. */
	onAttachIac?: () => void;
	/** Open the environment's cluster settings. */
	onOpenCluster: () => void;
	/** The template applied to the board right now, if one is. */
	applied?: AppliedTemplateNote | null;
}

/** Why the template buttons cannot be used, or null when they can. */
function templateGate(
	projectCloud: CloudProviderSlug | null,
	choices: CloudChoices,
): string | null {
	if (projectCloud) return null;
	if (choices.status === "loading") return "Loading the clouds available here.";
	if (choices.status === "error") {
		return "The clouds available here could not be loaded. Reload the page to try again.";
	}
	return choices.clouds.length === 0 ? "No cloud a cluster can run on is available here." : null;
}

/** One start: what it is, what it does, and its actions underneath. */
function Start({
	icon,
	title,
	description,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: ReactNode;
	children: ReactNode;
}) {
	return (
		<li className="flex flex-col gap-2.5 p-3">
			<div className="flex items-start gap-2.5">
				<span className="mt-0.5 grid size-6 shrink-0 place-items-center border border-border bg-surface-sunken text-muted-foreground [&_svg]:size-3.5">
					{icon}
				</span>
				<div className="min-w-0">
					<p className="text-ui-md font-medium text-foreground">{title}</p>
					<p className="text-ui-sm text-muted-foreground">{description}</p>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2 pl-[34px]">{children}</div>
		</li>
	);
}

/**
 * What an empty board says and offers (#6836): one sentence naming what the board is, then three
 * starts that each do something — a template sized for the project's cloud, the first component
 * added by hand, or the user's own chart or IaC module.
 *
 * Purely drawn from its props, so the server's picture of the board (`BoardPreview`) and the live
 * board render the same guide; only the live one's handlers do anything.
 */
export function BoardGuideView({
	projectCloud,
	cloudChoices,
	onTemplate,
	onAdd,
	onAttachChart,
	onAttachIac,
	onOpenCluster,
	applied,
}: BoardGuideViewProps) {
	// The cloud picked for a project that has none. Until one is picked it is the first offered.
	const [picked, setPicked] = useState<CloudProviderSlug | null>(null);
	const choices = cloudChoices.status === "ready" ? cloudChoices.clouds : [];
	const fallback = picked !== null && choices.includes(picked) ? picked : (choices[0] ?? null);
	const cloud = projectCloud ?? fallback;
	const gate = templateGate(projectCloud, cloudChoices);

	return (
		<Empty className="pointer-events-auto max-w-xl flex-none gap-5">
			<EmptyHeader className="max-w-md">
				<EmptyMedia variant="icon">
					<Boxes aria-hidden />
				</EmptyMedia>
				<EmptyTitle>Nothing designed yet</EmptyTitle>
				<EmptyDescription>{BOARD_SENTENCE}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="max-w-xl items-stretch gap-3">
				<ul
					aria-label="Ways to start"
					className="divide-y divide-border border border-border bg-background text-left"
				>
					<Start
						icon={<LayoutTemplate aria-hidden />}
						title="Start from a template"
						description={
							projectCloud
								? `Sizes the cluster for ${PROVIDERS[projectCloud].name}: a version, a machine type and an auto-scaling node pool.`
								: "Sizes the cluster: a version, a machine type and an auto-scaling node pool. No cloud account is connected yet, so pick the cloud to size for."
						}
					>
						{!projectCloud && choices.length > 1 && fallback && (
							<SegmentedControl
								label="Cloud to size for"
								options={choices.map((slug) => ({ value: slug, label: PROVIDERS[slug].shortName }))}
								value={fallback}
								onChange={setPicked}
							/>
						)}
						{TEMPLATE_OPTIONS.map((option) => (
							<DisabledReason key={option.id} reason={gate}>
								<Button
									type="button"
									variant="outline"
									size="sm"
									aria-label={`Start from the ${option.title} template`}
									title={option.description}
									onClick={() => {
										if (cloud) onTemplate(option.id, cloud);
									}}
								>
									{option.title}
								</Button>
							</DisabledReason>
						))}
					</Start>
					<Start
						icon={<Plus aria-hidden />}
						title="Add the first piece yourself"
						description="A service, a database, a queue: pick one and it is drawn here. Press A to add from anywhere on the board."
					>
						<Button type="button" size="sm" onClick={onAdd}>
							<Plus aria-hidden />
							Add a component
						</Button>
					</Start>
					<Start
						icon={<GitBranch aria-hidden />}
						title="Bring your own"
						description="Attach a Helm chart or an infrastructure-as-code module from your repository. It is scanned, then drawn here."
					>
						<DisabledReason reason={onAttachChart ? null : NOT_ENABLED}>
							<Button type="button" variant="outline" size="sm" onClick={onAttachChart}>
								Attach a Helm chart
							</Button>
						</DisabledReason>
						<DisabledReason reason={onAttachIac ? null : NOT_ENABLED}>
							<Button type="button" variant="outline" size="sm" onClick={onAttachIac}>
								Attach an IaC module
							</Button>
						</DisabledReason>
					</Start>
				</ul>
				{applied && (
					<p role="status" className="text-left text-ui-sm text-muted-foreground">
						<span className="text-foreground">
							The cluster is sized from the {applied.title} template for {applied.cloud}.
						</span>{" "}
						{applied.sentence}
						{applied.starter && (
							<>
								{" "}
								<a
									href={applied.starter.url}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
								>
									{applied.starter.name}
									<ExternalLink aria-hidden className="size-3" />
									<span className="sr-only">(opens in a new tab)</span>
								</a>
							</>
						)}
					</p>
				)}
				<div className="flex justify-center">
					<Button type="button" variant="link" size="sm" onClick={onOpenCluster}>
						Open cluster settings
					</Button>
				</div>
			</EmptyContent>
		</Empty>
	);
}
