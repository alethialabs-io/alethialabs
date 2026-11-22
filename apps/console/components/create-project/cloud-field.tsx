"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check } from "lucide-react";

import { NOT_OFFERED_SHORT } from "@/components/connectors/connectors-query";
import { manageReason } from "@/components/errors/manage-gate";
import { PROVIDERS, type CloudProviderSlug } from "@/lib/cloud-providers";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { ProviderIcon } from "@repo/ui/provider-icon";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";

import type { AccountOption, UnofferedCloud } from "./deduce";

interface CloudFieldProps {
	/** The clouds a new project can be created on — the server's offered list. */
	offered: readonly CloudProviderSlug[];
	/** The org's accounts on those clouds. */
	accounts: readonly AccountOption[];
	/** Connected clouds that are not offered for new projects. */
	unoffered: readonly UnofferedCloud[];
	provider: CloudProviderSlug;
	identityId: string;
	onProvider: (provider: CloudProviderSlug) => void;
	onAccount: (identityId: string) => void;
	/** Opens the connect sheet for a cloud, or `null` when that cloud has no connector to open. */
	connectFor: (provider: CloudProviderSlug) => (() => void) | null;
	/** Whether the viewer may connect a cloud account. */
	canManage: boolean;
	/** True when the starting point cannot be created without an account (an import). */
	accountRequired: boolean;
	/** The field's error, from the form or a server refusal. */
	error: string | null;
}

/** The account's name with its id, project or subscription when there is one. */
function accountText(account: AccountOption): string {
	return account.label ? `${account.name} (${account.label})` : account.name;
}

/**
 * "Cloud": the offered clouds as one native radio group, each saying whether the org has an
 * account there. The cloud's account is chosen for the person — the first usable one — and a
 * second account on the same cloud adds a picker. A cloud with no account offers Connect in place;
 * an account that failed verification offers Reconnect. Connected clouds this release does not
 * offer are listed with the reason, never as a choice.
 */
export function CloudField({
	offered,
	accounts,
	unoffered,
	provider,
	identityId,
	onProvider,
	onAccount,
	connectFor,
	canManage,
	accountRequired,
	error,
}: CloudFieldProps) {
	const onCloud = accounts.filter((a) => a.provider === provider);
	const usable = onCloud.filter((a) => a.usable);
	const broken = onCloud.filter((a) => !a.usable);
	const connect = connectFor(provider);
	const connectReason = manageReason({ canManage });
	const name = PROVIDERS[provider].shortName;

	return (
		<div className="space-y-3">
			<fieldset>
				<legend className="sr-only">Cloud</legend>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{offered.map((cloud) => {
						const checked = cloud === provider;
						const hasAccount = accounts.some((a) => a.provider === cloud && a.usable);
						return (
							<label
								key={cloud}
								className={cn(
									"flex cursor-pointer items-center gap-2.5 border border-border bg-card px-3 py-2.5 transition-colors hover:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
									checked && "border-foreground",
								)}
							>
								<input
									type="radio"
									name="provider"
									value={cloud}
									checked={checked}
									onChange={() => onProvider(cloud)}
									className="sr-only"
									aria-label={PROVIDERS[cloud].shortName}
									aria-describedby={`cloud-${cloud}-status`}
								/>
								<ProviderIcon provider={cloud} size={18} decorative mono={!hasAccount} />
								<span className="min-w-0">
									<span className="block text-ui-sm font-medium text-foreground">
										{PROVIDERS[cloud].shortName}
									</span>
									<span
										id={`cloud-${cloud}-status`}
										className="flex items-center gap-1 text-ui-2xs text-muted-foreground"
									>
										{hasAccount ? (
											<>
												<Check aria-hidden="true" className="size-3" />
												Connected
											</>
										) : (
											"Not connected"
										)}
									</span>
								</span>
							</label>
						);
					})}
				</div>
			</fieldset>

			{usable.length > 1 ? (
				<div className="flex items-center gap-3">
					<span id="cloud-account-label" className="text-ui-sm text-muted-foreground">
						Account
					</span>
					<Select value={identityId} onValueChange={(value) => onAccount(value ?? "")}>
						<SelectTrigger className="w-full max-w-[320px]" aria-labelledby="cloud-account-label">
							<SelectValue placeholder="Pick an account" />
						</SelectTrigger>
						<SelectContent>
							{usable.map((account) => (
								<SelectItem key={account.identityId} value={account.identityId}>
									{accountText(account)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : usable.length === 1 && usable[0] ? (
				<p className="text-ui-sm text-muted-foreground">
					Using <span className="text-foreground">{accountText(usable[0])}</span>.
				</p>
			) : (
				<div className="flex flex-wrap items-center gap-3">
					<p className="text-ui-sm text-muted-foreground">
						{broken[0]
							? `${accountText(broken[0])} could not be verified.`
							: `No ${name} account connected.`}{" "}
						{accountRequired ? "" : "You can create the project now and connect one on the canvas."}
					</p>
					{connect ? (
						<DisabledReason reason={connectReason}>
							<Button type="button" variant="outline" size="sm" onClick={connect}>
								{broken[0] ? `Reconnect ${name}` : `Connect ${name}`}
							</Button>
						</DisabledReason>
					) : null}
				</div>
			)}

			{error ? (
				<p id="cloud_account_error" role="alert" className="text-ui-sm text-destructive">
					{error}
				</p>
			) : null}

			{unoffered.length > 0 ? (
				<ul className="space-y-1">
					{unoffered.map((cloud) => (
						<li key={cloud.slug} className="text-ui-xs text-muted-foreground">
							{cloud.name}: {NOT_OFFERED_SHORT}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
