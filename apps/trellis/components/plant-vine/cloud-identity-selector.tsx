"use client";

import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers/registry";
import { useCloudProvider } from "@/lib/cloud-providers/use-cloud-provider";
import { getCachedResources } from "@/app/server/actions/aws/resources";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef } from "react";

interface CloudIdentitySelectorProps {
	identities: CloudIdentityOption[];
	value: string | null;
	onChange: (id: string, provider: CloudProviderSlug) => void;
}

/** Renders a dropdown of all verified cloud identities across providers. */
export function CloudIdentitySelector({
	identities,
	value,
	onChange,
}: CloudIdentitySelectorProps) {
	const { setIdentity } = useCloudProvider();
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		if (identities.length === 1 && !value) {
			const first = identities[0];
			onChangeRef.current(first.id, first.provider as CloudProviderSlug);
		}
	}, [identities, value]);

	if (identities.length === 0) {
		return (
			<div className="flex items-center justify-between p-3 rounded-md border border-dashed border-destructive/30 bg-destructive/5">
				<div className="flex items-center gap-2 text-sm text-destructive">
					<AlertTriangle className="h-4 w-4" />
					No cloud account connected
				</div>
				<Link href="/dashboard/integrations">
					<Button variant="outline" size="sm" className="h-7 text-xs">
						Connect
					</Button>
				</Link>
			</div>
		);
	}

	return (
		<Select
			value={value ?? undefined}
			onValueChange={(id) => {
				const identity = identities.find((i) => i.id === id);
				if (identity) {
					const provider = identity.provider as CloudProviderSlug;
					onChange(id, provider);
					setIdentity(id, provider, null);
				}
			}}
		>
			<SelectTrigger className="h-9 text-sm">
				<SelectValue placeholder="Select cloud account" />
			</SelectTrigger>
			<SelectContent>
				{identities.map((identity) => {
					const meta = getProvider(identity.provider);
					return (
						<SelectItem key={identity.id} value={identity.id}>
							<div className="flex items-center gap-2">
								<Image
									src={meta.icon}
									alt={meta.shortName}
									width={16}
									height={16}
									className="shrink-0"
								/>
								<span>{identity.name}</span>
								<span className="text-xs text-muted-foreground font-mono">
									{identity.displayId}
								</span>
							</div>
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
