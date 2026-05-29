"use client";

import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

type SupportTier = "standard" | "extended";

const EKS_VERSIONS: {
	version: string;
	support: SupportTier;
	recommended?: boolean;
}[] = [
	{ version: "1.32", support: "standard", recommended: true },
	{ version: "1.31", support: "standard" },
	{ version: "1.30", support: "standard" },
	{ version: "1.29", support: "extended" },
	{ version: "1.28", support: "extended" },
];

interface EksVersionSelectorProps {
	value: string;
	onChange: (version: string) => void;
}

export function EksVersionSelector({
	value,
	onChange,
}: EksVersionSelectorProps) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger className="h-9 text-sm">
				<SelectValue placeholder="Select EKS version" />
			</SelectTrigger>
			<SelectContent>
				{EKS_VERSIONS.map((v) => (
					<SelectItem key={v.version} value={v.version}>
						<div className="flex items-center gap-2">
							<span className="font-mono">{v.version}</span>
							{v.recommended && (
								<Badge
									variant="outline"
									className="text-[9px] py-0 px-1.5 text-emerald-600 border-emerald-200 bg-emerald-50"
								>
									Recommended
								</Badge>
							)}
							{v.support === "standard" ? (
								<Badge
									variant="outline"
									className="text-[9px] py-0 px-1.5 text-emerald-600 border-emerald-200 bg-emerald-50"
								>
									Standard
								</Badge>
							) : (
								<Badge
									variant="outline"
									className="text-[9px] py-0 px-1.5 text-amber-600 border-amber-200 bg-amber-50"
								>
									Extended — 6x cost
								</Badge>
							)}
						</div>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
