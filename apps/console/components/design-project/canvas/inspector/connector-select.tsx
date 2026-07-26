"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector's `connector` field: which of the org's CONNECTED pluggable connectors a component
// uses, plus that provider's non-secret knobs.
//
// A pluggable connector has two halves. The SECRET half is org-level and lives once on
// `connector_credentials` (connected on the Connectors page). The non-secret half — the host, URL or
// path that varies by project — belongs to the component row's `provider_config`. This control is
// where the second half is set, and it writes both keys together because a knob means nothing
// without the slug that defines it.
//
// Category-generic on purpose. `helm_registry` is the first consumer; `registry`, `secrets` and
// `dns` are the same shape and can adopt it with one field entry in their CONFIG_SCHEMA block.

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plug } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ProviderConfigFields } from "@/components/connector/provider-config-fields";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import {
	getConnectorProviderBySlug,
	type PluggableCategory,
} from "@/lib/connectors/registry.generated";

interface ConnectorSelectProps {
	category: PluggableCategory;
	/** The stored `connectors.slug`, or null when the component has no connector yet. */
	value: string | null;
	/** The stored `provider_config` JSONB. */
	providerConfig: Record<string, unknown>;
	/** Patches `provider` and `provider_config` on the node config in one write. */
	onChange: (patch: {
		provider: string | null;
		provider_config: Record<string, unknown>;
	}) => void;
	id?: string;
	/** Per-`provider_config`-key validation messages. */
	errors?: Record<string, string>;
}

/** Only strings/booleans reach `provider_config`; anything else is a stale value we ignore. */
function toKnobValues(
	config: Record<string, unknown>,
): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string" || typeof value === "boolean") out[key] = value;
	}
	return out;
}

export function ConnectorSelect({
	category,
	value,
	providerConfig,
	onChange,
	id,
	errors,
}: ConnectorSelectProps) {
	const params = useParams<{ org?: string }>();
	const connected = useConnectedProviders(category);

	// A `coming_soon` provider can't be connected, but filter anyway so a catalog change can never
	// put an unselectable option in front of someone.
	const options = useMemo(
		() => connected.filter((p) => p.status !== "coming_soon"),
		[connected],
	);

	const selected = value ? getConnectorProviderBySlug(value) : undefined;
	// The stored connector may have been disconnected since this was configured. Showing it (marked)
	// beats rendering an empty Select that reads as "nothing chosen" — the row is still pointing at
	// it, and the deploy will still try to use it.
	const staleSelection = Boolean(value && !options.some((p) => p.slug === value));

	const connectorsHref = params?.org ? `/${params.org}/~/connectors` : "/";

	if (options.length === 0 && !value) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-none border border-dashed border-border p-3">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Plug className="h-3.5 w-3.5 shrink-0" />
					No connector connected for this
				</div>
				<Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" render={
					<Link href={connectorsHref}>Connect</Link>
				} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<Select
				value={value ?? ""}
				onValueChange={(slug) => {
					const next = getConnectorProviderBySlug(slug);
					// Carry over only the knobs the NEW provider actually declares. Otherwise switching
					// (say) an HTTPS repo to a GHCR one leaves a stale `repo_url` behind in the JSONB,
					// which then rides into the config snapshot and the seeded credential.
					const keep = new Set((next?.providerConfigFields ?? []).map((f) => f.key));
					const carried: Record<string, unknown> = {};
					for (const [key, v] of Object.entries(providerConfig)) {
						if (keep.has(key)) carried[key] = v;
					}
					onChange({ provider: slug, provider_config: carried });
				}}
			>
				<SelectTrigger id={id} className="h-9 text-sm">
					<SelectValue placeholder="Select a connector" />
				</SelectTrigger>
				<SelectContent>
					{options.map((provider) => (
						<SelectItem key={provider.slug} value={provider.slug}>
							<span className="flex items-center gap-2">
								<span className="flex h-4 w-4 items-center justify-center">
									<ConnectorIcon src={provider.icon_url} name={provider.name} size={16} />
								</span>
								{provider.name}
							</span>
						</SelectItem>
					))}
					{staleSelection && value ? (
						<SelectItem value={value}>
							<span className="flex items-center gap-2">
								{selected?.name ?? value}
								<span className="vx-eyebrow text-[10px] text-muted-foreground">
									not connected
								</span>
							</span>
						</SelectItem>
					) : null}
				</SelectContent>
			</Select>

			{staleSelection ? (
				<p className="text-xs text-muted-foreground">
					This connector isn&apos;t connected for your organization.{" "}
					<Link href={connectorsHref} className="underline underline-offset-2">
						Connect it
					</Link>{" "}
					or pick another, or the deploy won&apos;t be able to authenticate.
				</p>
			) : null}

			{selected ? (
				<ProviderConfigFields
					fields={selected.providerConfigFields}
					values={toKnobValues(providerConfig)}
					onChange={(key, next) =>
						onChange({
							provider: value,
							provider_config: { ...providerConfig, [key]: next },
						})
					}
					errors={errors}
					idPrefix={`${id ?? "connector"}-cfg`}
				/>
			) : null}
		</div>
	);
}
