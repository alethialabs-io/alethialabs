"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Deploy without approval" — the part of the token sheet decision D2 asks for (design §4, "The
// picker"). The environments of the token's projects, grouped by project, each with its stage pill.
//
// What it refuses, and why it still SHOWS what it refuses:
//   · production rows are always disabled, with a lock and "Production always needs a person." They
//     are listed rather than hidden, so nobody wonders where production went;
//   · the whole picker is disabled until the token can Deploy (the `apply` scope): an auto-approve
//     list on a token that cannot ask to deploy means nothing, and the server refuses it;
//   · without `org:manage_agents` the picker is read-only — the PDP verb the owner role carries,
//     answered by the read, never asked of the person.
// The server re-checks every one of these (lib/agents/service-tokens.ts, the auto-approve rule).

import type { TokenProjectChoices } from "@/lib/agents/service-tokens";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { Info, Lock } from "lucide-react";
import { useId } from "react";
import { PICKER_RULES } from "./token-vocab";
import { RuleList, StagePill, TokenNotice } from "./token-parts";

/** The environments the picker can offer, or the state of the read that lists them. */
export type PickerChoices =
	| { state: "loading" }
	| { state: "error"; retry: () => void }
	| { state: "ready"; projects: TokenProjectChoices[] };

/** The auto-approve picker's inputs. */
export interface AutoApprovePickerProps {
	choices: PickerChoices;
	/** The chosen environment ids. */
	value: readonly string[];
	onChange: (next: string[]) => void;
	/** The token carries the Deploy (`apply`) scope. */
	canDeploy: boolean;
	/** The viewer holds `org:manage_agents`. */
	canManageAgents: boolean;
	/** The token is limited to some projects and none is chosen yet. */
	noProjectChosen?: boolean;
	/** An existing token: its scopes cannot change here, so "turn on Deploy" is not advice. */
	editing?: boolean;
}

/** The hint under one environment row, rewritten for its current state. */
function rowHint(production: boolean, checked: boolean): string {
	if (production) return "Production always needs a person.";
	return checked ? "Deploys go ahead without asking anyone." : "Each deploy waits for a person.";
}

/** The "Deploy without approval" fieldset. */
export function AutoApprovePicker({
	choices,
	value,
	onChange,
	canDeploy,
	canManageAgents,
	noProjectChosen = false,
	editing = false,
}: AutoApprovePickerProps) {
	const baseId = useId();
	const hintId = `${baseId}-hint`;
	const noticeId = `${baseId}-notice`;
	const locked = !canManageAgents || !canDeploy;
	const chosen = new Set(value);

	/** Ticks or unticks one environment. */
	const toggle = (id: string, next: boolean) => {
		onChange(next ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
	};

	return (
		<fieldset
			className="grid min-w-0 gap-2"
			aria-describedby={locked ? `${hintId} ${noticeId}` : hintId}
			data-locked={locked || undefined}
		>
			<legend className="mb-1 text-ui-sm font-medium text-text-primary">Deploy without approval</legend>
			<p id={hintId} className="text-ui-sm text-text-tertiary">
				Choose environments where this token&apos;s deploys go ahead without a person approving each one. For CI
				pipelines that deploy to staging on every merge.
			</p>

			{!canManageAgents ? (
				<TokenNotice id={noticeId} icon={<Lock />} title="You can't choose these environments">
					Choosing them needs the Manage agents permission, which your role doesn&apos;t include. You can create the
					token now; someone with that permission can add environments later.
				</TokenNotice>
			) : !canDeploy ? (
				<TokenNotice id={noticeId} icon={<Info />} title="Needs the Deploy permission">
					{editing
						? "This token can't ask to deploy, so there are no environments to choose. To change what it can do, create a new token."
						: "Turn on Deploy above to choose environments."}
				</TokenNotice>
			) : null}

			<div aria-disabled={locked || undefined} className="grid gap-2">
				{noProjectChosen ? (
					<p className="text-ui-sm text-text-tertiary">Choose at least one project first.</p>
				) : choices.state === "loading" ? (
					<div className="grid gap-2" aria-busy="true" aria-label="Loading environments">
						<Skeleton className="h-9 w-full" />
						<Skeleton className="h-9 w-full" />
						<Skeleton className="h-9 w-full" />
					</div>
				) : choices.state === "error" ? (
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border-strong px-3 py-2.5 text-ui-sm text-text-secondary">
						<span>Couldn&apos;t load the environments.</span>
						<Button type="button" variant="ghost" size="xs" onClick={choices.retry}>
							Try again
						</Button>
					</div>
				) : choices.projects.length === 0 ? (
					<p className="text-ui-sm text-text-tertiary">These projects have no environments yet.</p>
				) : (
					choices.projects.map((project) => (
						<div key={project.projectId} className="overflow-hidden rounded-sm border border-border">
							<div
								id={`${baseId}-project-${project.projectId}`}
								className="border-b border-border bg-surface-sunken px-3 py-2 text-ui-md font-medium text-text-primary"
							>
								{project.projectName}
							</div>
							<ul aria-label={`${project.projectName} environments`}>
								{project.environments.map((env) => {
									const production = env.stage === "production";
									const checked = !production && chosen.has(env.id);
									const disabled = production || locked;
									const whyId = `${baseId}-why-${env.id}`;
									const nameId = `${baseId}-name-${env.id}`;
									return (
										<li key={env.id} className="border-b border-border last:border-b-0">
											<label
												className={cn(
													"flex items-start gap-2.5 px-3 py-2.5",
													disabled ? "cursor-not-allowed" : "cursor-pointer",
												)}
											>
												<Checkbox
													className="mt-0.5"
													checked={checked}
													disabled={disabled}
													aria-labelledby={`${nameId} ${baseId}-project-${project.projectId}`}
													aria-describedby={whyId}
													onCheckedChange={(next) => toggle(env.id, next === true)}
												/>
												<span className="min-w-0">
													<span className="flex flex-wrap items-center gap-2">
														<span
															id={nameId}
															className={cn(
																"font-mono text-ui-md font-medium",
																disabled ? "text-text-tertiary" : "text-text-primary",
															)}
														>
															{env.name}
														</span>
														<StagePill stage={env.stage} />
													</span>
													<span id={whyId} className="mt-0.5 flex items-center gap-1 text-ui-sm text-text-tertiary">
														{production ? <Lock className="size-3" aria-hidden /> : null}
														{rowHint(production, checked)}
													</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						</div>
					))
				)}
			</div>

			<RuleList className="mt-1">
				{PICKER_RULES.map((rule) => (
					<li key={rule}>{rule}</li>
				))}
			</RuleList>
		</fieldset>
	);
}
