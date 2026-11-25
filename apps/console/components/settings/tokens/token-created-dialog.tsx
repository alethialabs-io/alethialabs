"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Copy your new token" (AGT-L2 design §4, state "Created"): the only time the plaintext exists in
// the browser. It is shown in full, selectable, because a copy can fail (no clipboard access) and the
// person must then be able to select it by hand. Closing the dialog drops it from memory; the caller
// holds it in state only while this is open.

import type { CreatedServiceToken } from "@/app/server/actions/agents/service-tokens";
import type { ServiceTokenEnvironmentRef } from "@/lib/queries/service-tokens";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { RuleList } from "./token-parts";

/** The created dialog's inputs. */
export interface TokenCreatedDialogProps {
	/** The new token, with its plaintext; null while the dialog is closed. */
	token: CreatedServiceToken | null;
	/** Its auto-approve environments, named (from the picker's read). */
	autoApprove: readonly ServiceTokenEnvironmentRef[];
	onClose: () => void;
}

/**
 * The pipeline line the dialog suggests. It names a real environment when the token has one it
 * deploys to without approval; otherwise it shows the shape with the flags left to the reader.
 * `alethia project deploy` takes the project and the environment by NAME, and `--yes` because a
 * pipeline cannot answer its question.
 */
export function pipelineLine(autoApprove: readonly ServiceTokenEnvironmentRef[]): string {
	const first = autoApprove[0];
	const target = first ? ` --project ${first.projectName} --env ${first.name}` : "";
	return `ALETHIA_TOKEN=… alethia project deploy${target} --yes`;
}

/** The "Copy your new token" dialog. */
export function TokenCreatedDialog({ token, autoApprove, onClose }: TokenCreatedDialogProps) {
	return (
		<Dialog open={token !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Copy your new token</DialogTitle>
					<DialogDescription>This is the only time it&apos;s shown. Alethia stores a fingerprint, never the token.</DialogDescription>
				</DialogHeader>
				{token ? (
					<div className="grid gap-4">
						<div className="flex items-center gap-2 rounded-sm border border-ink bg-surface-sunken px-2.5 py-2">
							<code
								aria-label={`Service token ${token.name}`}
								className="min-w-0 flex-1 select-all font-mono text-ui-sm text-text-primary [overflow-wrap:anywhere]"
							>
								{token.token}
							</code>
							<CopyButton text={token.token} className="shrink-0" />
						</div>
						<div className="grid gap-1.5">
							<span className="text-ui-sm font-medium text-text-primary">Use it in your pipeline</span>
							<code className="block rounded-sm border border-border bg-surface-sunken p-2 font-mono text-ui-sm text-text-primary [overflow-wrap:anywhere]">
								{pipelineLine(autoApprove)}
							</code>
						</div>
						<RuleList>
							{autoApprove.length > 0 ? (
								<li>
									Deploys to{" "}
									{autoApprove.map((env, i) => (
										<span key={env.id}>
											{i > 0 ? ", " : null}
											<span className="font-mono text-text-primary">
												{env.projectName} / {env.name}
											</span>
										</span>
									))}{" "}
									go ahead without approval.
								</li>
							) : null}
							<li>
								{autoApprove.length > 0
									? "Everything else this token asks to deploy waits for a person in Approvals."
									: "Every deploy this token asks for waits for a person in Approvals."}
							</li>
						</RuleList>
					</div>
				) : null}
				<DialogFooter>
					<Button size="sm" onClick={onClose}>
						I&apos;ve copied it
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
