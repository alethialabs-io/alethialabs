"use client";

import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign } from "lucide-react";
import { useMemo } from "react";
import type { ConfigFormValues } from "./configuration-form";

const HOURS_PER_MONTH = 730;

const EKS_STANDARD_HOURLY = 0.1;
const EKS_EXTENDED_HOURLY = 0.6;
const NAT_GATEWAY_HOURLY = 0.045;
const T3_MEDIUM_HOURLY = 0.042;
const NODE_COUNT = 3;
const AURORA_ACU_HOURLY = 0.12;
const REDIS_T3_MEDIUM_HOURLY = 0.034;
const WAF_MONTHLY = 5;

type LineItem = {
	label: string;
	monthly: number;
	note?: string;
};

interface CostPreviewProps {
	values: Partial<ConfigFormValues>;
}

export function CostPreview({ values }: CostPreviewProps) {
	const items = useMemo(() => {
		const lines: LineItem[] = [];

		const eksVersion = values.eks_version ?? "1.32";
		const isExtended =
			parseFloat(eksVersion) < 1.3;
		const eksHourly = isExtended
			? EKS_EXTENDED_HOURLY
			: EKS_STANDARD_HOURLY;
		lines.push({
			label: "EKS Control Plane",
			monthly: eksHourly * HOURS_PER_MONTH,
			note: isExtended ? "Extended support" : "Standard",
		});

		if (values.create_vpc !== false) {
			lines.push({
				label: "NAT Gateway",
				monthly: NAT_GATEWAY_HOURLY * HOURS_PER_MONTH,
			});
		}

		lines.push({
			label: `Node Group (${NODE_COUNT}× t3.md)`,
			monthly: T3_MEDIUM_HOURLY * NODE_COUNT * HOURS_PER_MONTH,
		});

		if (values.create_rds !== false) {
			const minCapacity = values.db_min_capacity ?? 2;
			lines.push({
				label: `Aurora (${minCapacity} ACU min)`,
				monthly: minCapacity * AURORA_ACU_HOURLY * HOURS_PER_MONTH,
				note: "At minimum usage",
			});
		}

		if (values.enable_redis) {
			lines.push({
				label: "ElastiCache Redis",
				monthly: REDIS_T3_MEDIUM_HOURLY * HOURS_PER_MONTH,
			});
		}

		if (values.enable_cloudfront_waf) {
			lines.push({
				label: "CloudFront WAF",
				monthly: WAF_MONTHLY,
			});
		}

		return lines;
	}, [
		values.eks_version,
		values.create_vpc,
		values.create_rds,
		values.db_min_capacity,
		values.enable_redis,
		values.enable_cloudfront_waf,
	]);

	const total = items.reduce((sum, item) => sum + item.monthly, 0);

	return (
		<div className="sticky top-20">
			<Card className="shadow-sm border border-border/40">
				<CardHeader className="pb-3">
					<CardTitle className="text-sm font-medium flex items-center gap-2">
						<DollarSign className="h-4 w-4 text-muted-foreground" />
						Monthly Estimate
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2">
					{items.map((item) => (
						<div
							key={item.label}
							className="flex items-baseline justify-between text-xs"
						>
							<div className="flex items-center gap-1.5">
								<span className="text-muted-foreground">
									{item.label}
								</span>
								{item.note && (
									<Badge
										variant="outline"
										className="text-[8px] py-0 px-1 text-muted-foreground border-border/50"
									>
										{item.note}
									</Badge>
								)}
							</div>
							<span className="font-mono text-foreground">
								${item.monthly.toFixed(0)}
							</span>
						</div>
					))}

					<div className="pt-2 mt-2 border-t border-border/40 flex items-baseline justify-between">
						<span className="text-xs font-medium text-foreground">
							Total
						</span>
						<span className="font-mono text-sm font-semibold text-foreground">
							~${total.toFixed(0)}/mo
						</span>
					</div>

					<p className="text-[10px] text-muted-foreground pt-1">
						Estimate based on default instance types and us-east-1
						pricing. Actual costs may vary.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
