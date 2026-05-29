"use client";

import {
	getProviderTokenOptions,
	type ProviderTokenOption,
} from "@/app/server/actions/git/tokens";
import { GitProviderIcon } from "@/components/git-provider-icon";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface ArgocdTokenSelectorProps {
	value: string;
	onChange: (provider: string) => void;
	manualToken: string;
	onManualTokenChange: (token: string) => void;
}

export function ArgocdTokenSelector({
	value,
	onChange,
	manualToken,
	onManualTokenChange,
}: ArgocdTokenSelectorProps) {
	const [providers, setProviders] = useState<ProviderTokenOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [manual, setManual] = useState(false);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	useEffect(() => {
		getProviderTokenOptions().then((data) => {
			setProviders(data);
			setLoading(false);
			if (data.length === 1 && !value) {
				onChangeRef.current(data[0].provider);
			}
		});
	}, [value]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading providers...
			</div>
		);
	}

	if (manual || providers.length === 0) {
		return (
			<div className="space-y-2">
				<Input
					type="password"
					placeholder="Enter Git access token"
					value={manualToken}
					onChange={(e) => onManualTokenChange(e.target.value)}
					className="h-9 text-sm"
				/>
				{providers.length > 0 && (
					<button
						type="button"
						onClick={() => setManual(false)}
						className="text-xs text-muted-foreground hover:text-foreground underline"
					>
						Use linked provider instead
					</button>
				)}
				{providers.length === 0 && (
					<p className="text-xs text-muted-foreground">
						No linked Git providers.{" "}
						<Link
							href="/dashboard/integrations"
							className="underline hover:text-foreground"
						>
							Connect one
						</Link>{" "}
						to auto-select.
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger className="h-9 text-sm">
					<SelectValue placeholder="Select Git provider for ArgoCD" />
				</SelectTrigger>
				<SelectContent>
					{providers.map((p) => (
						<SelectItem key={p.provider} value={p.provider}>
							<div className="flex items-center gap-2">
								<GitProviderIcon
									provider={p.provider}
									size={16}
								/>
								<span className="capitalize">
									{p.provider}
								</span>
								<span className="text-xs text-muted-foreground">
									@{p.username}
								</span>
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<button
				type="button"
				onClick={() => setManual(true)}
				className="text-xs text-muted-foreground hover:text-foreground underline"
			>
				Enter token manually
			</button>
		</div>
	);
}
