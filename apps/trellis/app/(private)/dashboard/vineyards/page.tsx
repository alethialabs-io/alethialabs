import { ThemedInfoPopover } from "@/components/themed-info-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Map } from "lucide-react";
import Link from "next/link";

export default async function VineyardsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: vineyards } = await supabase
		.from("vineyards")
		.select("*, configurations(*)")
		.eq("user_id", user!.id)
		.order("updated_at", { ascending: false });

	return (
		<div className="space-y-8 w-full">
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Vineyards
					</h1>
					<ThemedInfoPopover type="vineyard" />
				</div>
				<p className="text-muted-foreground text-sm">
					Manage your distinct workspaces and infrastructure projects.
				</p>
			</div>

			{vineyards && vineyards.length > 0 ? (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{vineyards.map((vineyard: any) => (
						<div
							key={vineyard.id}
							className={cn(
								"group flex flex-col justify-between transition-all bg-card shadow-sm border border-border/40 rounded-xl hover:border-foreground/20 hover:shadow-md",
							)}
						>
							<div className="p-5 pb-0">
								<div className="flex items-start justify-between mb-3">
									<div className="flex flex-col gap-1.5 overflow-hidden">
										<h3 className="font-semibold text-base truncate text-foreground pr-2">
											{vineyard.name}
										</h3>
										<div className="flex items-center gap-2">
											<Badge
												variant="secondary"
												className="font-medium text-[10px] px-1.5 py-0 h-5 bg-muted/60 text-muted-foreground border-transparent"
											>
												{vineyard.configurations
													?.length || 0}{" "}
												Configs
											</Badge>
										</div>
									</div>
								</div>
								<p className="line-clamp-2 text-xs text-muted-foreground h-8 leading-relaxed mb-4">
									{vineyard.description ||
										`A workspace for infrastructure configuration.`}
								</p>
							</div>

							<div className="p-5 pt-0 flex flex-col gap-4">
								<div className="flex items-center justify-between pt-4 border-t border-border/40">
									<span className="text-xs text-muted-foreground">
										Updated{" "}
										{formatDistanceToNow(
											new Date(vineyard.updated_at!),
											{ addSuffix: true },
										)}
									</span>
									<Link
										href={`/dashboard/vineyards/${vineyard.id}`}
									>
										<Button
											variant="ghost"
											size="sm"
											className="h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
										>
											Open{" "}
											<ArrowRight className="ml-1 h-3.5 w-3.5" />
										</Button>
									</Link>
								</div>
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="border border-dashed border-border/60 rounded-xl bg-muted/5 flex flex-col items-center justify-center py-20 text-center">
					<Map className="h-10 w-10 text-muted-foreground mb-4 opacity-40" />
					<h3 className="text-base font-medium text-foreground mb-1">
						No Vineyards found
					</h3>
					<p className="text-sm text-muted-foreground mb-6 max-w-sm leading-relaxed">
						Create your first Vineyard to start organizing your
						infrastructure configurations and deployments.
					</p>
					{/* Currently, Vineyards can only be created during Configuration creation or via Grape CLI. We can add a simple creation dialog here later. */}
					<Link href="/dashboard/configure">
						<Button
							size="sm"
							className="h-9 text-sm font-medium shadow-sm"
						>
							Create Configuration
							<ArrowRight className="ml-2 h-4 w-4" />
						</Button>
					</Link>
				</div>
			)}
		</div>
	);
}
