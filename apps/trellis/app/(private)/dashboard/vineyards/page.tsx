import { getVineyards } from "@/app/server/actions/vineyards";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Grape, Map, Plus } from "lucide-react";
import Link from "next/link";

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
				<Link href="/dashboard/configure">
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
					<Link href="/dashboard/configure">
						<Button size="sm" className="h-8 text-xs">
							<Plus className="h-3.5 w-3.5 mr-1.5" />
							Plant a Vine
						</Button>
					</Link>
				</div>
			) : (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{vineyards.map((vineyard) => {
						const configs = vineyard.vines ?? [];
						const completed = configs.filter(
							(c) => c.status === "ACTIVE",
						).length;
						const total = configs.length;

						return (
							<Link
								key={vineyard.id}
								href={`/dashboard/vineyards/${vineyard.id}`}
							>
								<div className="group p-5 rounded-lg border border-border/50 bg-background hover:bg-muted/30 hover:border-border transition-colors cursor-pointer">
									<div className="flex items-start justify-between mb-3">
										<div className="p-2 bg-muted/50 rounded-md border border-border/50">
											<Map className="h-4 w-4 text-muted-foreground" />
										</div>
										{total > 0 && (
											<Badge
												variant="secondary"
												className="text-[10px] py-0"
											>
												{completed}/{total} provisioned
											</Badge>
										)}
									</div>
									<h3 className="text-sm font-medium text-foreground group-hover:text-foreground mb-1">
										{vineyard.name}
									</h3>
									<p className="text-xs text-muted-foreground">
										{total === 0
											? "No vines planted"
											: `${total} vine${total !== 1 ? "s" : ""}`}
									</p>
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}
