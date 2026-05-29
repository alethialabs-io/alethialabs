"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface VpcSelectorProps {
	vpcCidr: string;
	onVpcCidrChange: (cidr: string) => void;
}

export function VpcSelector({
	vpcCidr,
	onVpcCidrChange,
}: VpcSelectorProps) {
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<Label className="text-xs">VPC CIDR Block</Label>
				<Badge variant="secondary" className="text-[9px] py-0 px-1.5">
					New VPC
				</Badge>
			</div>
			<Input
				value={vpcCidr}
				onChange={(e) => onVpcCidrChange(e.target.value)}
				placeholder="10.0.0.0/16"
				className="h-9 text-sm font-mono"
			/>
			<p className="text-[11px] text-muted-foreground">
				Existing VPC selection coming soon.
			</p>
		</div>
	);
}
