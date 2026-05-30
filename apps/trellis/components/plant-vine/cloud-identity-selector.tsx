"use client";

import {
	getVerifiedCloudIdentities,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Cloud, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface CloudIdentitySelectorProps {
	value: string | null;
	onChange: (id: string, accountId: string) => void;
}

export function CloudIdentitySelector({
	value,
	onChange,
}: CloudIdentitySelectorProps) {
	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [loading, setLoading] = useState(true);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		getVerifiedCloudIdentities().then((data) => {
			setIdentities(data);
			setLoading(false);
			if (data.length === 1 && !value) {
				onChangeRef.current(data[0].id, data[0].accountId);
			}
		});
	}, [value]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading AWS accounts...
			</div>
		);
	}

	if (identities.length === 0) {
		return (
			<div className="flex items-center justify-between p-3 rounded-md border border-dashed border-destructive/30 bg-destructive/5">
				<div className="flex items-center gap-2 text-sm text-destructive">
					<AlertTriangle className="h-4 w-4" />
					No AWS account connected
				</div>
				<Link href="/dashboard/integrations">
					<Button variant="outline" size="sm" className="h-7 text-xs">
						Connect AWS
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
				if (identity) onChange(id, identity.accountId);
			}}
		>
			<SelectTrigger className="h-9 text-sm">
				<SelectValue placeholder="Select AWS account" />
			</SelectTrigger>
			<SelectContent>
				{identities.map((identity) => (
					<SelectItem key={identity.id} value={identity.id}>
						<div className="flex items-center gap-2">
							<Cloud className="h-3.5 w-3.5 text-muted-foreground" />
							<span>{identity.name}</span>
							<span className="text-xs text-muted-foreground font-mono">
								{identity.accountId}
							</span>
						</div>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
