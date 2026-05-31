import { getVineyards } from "@/app/server/actions/vineyards";
import { getProvider } from "@/lib/cloud-providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Grape, Map, Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

const STATUS_DOTS: Record<string, string> = {
	ACTIVE: "bg-emerald-500",
	DRAFT: "bg-muted-foreground/40",
	QUEUED: "bg-blue-500",
	PROVISIONING: "bg-amber-500",
	FAILED: "bg-destructive",
	DESTROYING: "bg-orange-500",
	DESTROYED: "bg-muted-foreground/20",
};

export default async function VineyardsPage() {
	const { vineyards } = await getVineyards();

	return (
		<div className="space-y-8">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Vineyards
					</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Your infrastructure workspaces. Each vineyard groups
						related vines and their provisioned resources.
					</p>
				</div>
				<Link href="/dashboard/plant">
					<Button size="sm" className="h-8 text-xs">
						<Plus className="h-3.5 w-3.5 mr-1.5" />
						Plant a Vine
					</Button>
				</Link>
			</div>

			{vineyards.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Grape className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No vineyards yet
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Create your first vine to get started. A vineyard will
						be created automatically when you plant a vine.
					</p>
					<Link href="/dashboard/plant">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Plant a Vine
						</Button>
					</Link>
				</div>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{vineyards.map((vineyard) => {
						const vines = vineyard.vines ?? [];
						const total = vines.length;

						const statusCounts: Record<string, number> = {};
						for (const v of vines) {
							statusCounts[v.status] = (statusCounts[v.status] || 0) + 1;
						}

						const providers = [...new Set(vines.map((v) => v.cloud_provider).filter(Boolean))] as string[];

						const totalCost = vines.reduce((sum, v) => sum + (v.estimated_monthly_cost ?? 0), 0);

						const latestUpdate = vines.length > 0
							? vines.reduce((latest, v) =>
								new Date(v.updated_at) > new Date(latest.updated_at) ? v : latest
							).updated_at
							: vineyard.updated_at;

						return (
							<Link
								key={vineyard.id}
								href={`/dashboard/vineyards/${vineyard.id}`}
							>
								<div className="group p-5 rounded-lg border border-border/50 bg-background hover:bg-muted/30 hover:border-border transition-colors cursor-pointer space-y-3">
									{/* Header */}
									<div className="flex items-start justify-between">
										<div className="flex items-center gap-2.5">
											<div className="p-2 bg-muted/50 rounded-md border border-border/50">
												<Map className="h-4 w-4 text-muted-foreground" />
											</div>
											<div>
												<h3 className="text-sm font-medium text-foreground group-hover:text-foreground">
													{vineyard.name}
												</h3>
												<p className="text-[11px] text-muted-foreground">
													{total === 0 ? "No vines" : `${total} vine${total !== 1 ? "s" : ""}`}
												</p>
											</div>
										</div>
										{/* Cloud provider icons */}
										{providers.length > 0 && (
											<div className="flex items-center gap-1">
												{providers.map((p) => {
													const meta = getProvider(p);
													return (
														<Image
															key={p}
															src={meta.icon}
															alt={meta.shortName}
															width={18}
															height={18}
															className="opacity-60"
														/>
													);
												})}
											</div>
										)}
									</div>

									{/* Status breakdown */}
									{total > 0 && (
										<div className="flex flex-wrap gap-2">
											{Object.entries(statusCounts).map(([status, count]) => (
												<div key={status} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
													<span className={`h-2 w-2 rounded-full ${STATUS_DOTS[status] ?? "bg-muted-foreground/40"}`} />
													{count} {status.charAt(0) + status.slice(1).toLowerCase()}
												</div>
											))}
										</div>
									)}

									{/* Footer */}
									<div className="flex items-center justify-between pt-1 border-t border-border/30">
										{totalCost > 0 ? (
											<span className="text-[11px] text-muted-foreground font-mono">
												~${Math.round(totalCost)}/mo
											</span>
										) : (
											<span className="text-[11px] text-muted-foreground">—</span>
										)}
										{latestUpdate && (
											<span className="text-[11px] text-muted-foreground">
												{formatDistanceToNow(new Date(latestUpdate), { addSuffix: true })}
											</span>
										)}
									</div>
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}
