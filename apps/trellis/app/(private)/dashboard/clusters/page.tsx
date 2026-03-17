import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { Terminal } from "lucide-react";
import Link from "next/link";
import { ClusterList } from "@/components/clusters/cluster-list";

export default async function ClustersPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: clusters } = await supabase
		.from("clusters")
		.select("*")
		.eq("user_id", user!.id)
		.order("created_at", { ascending: false });

	return (
		<div className="space-y-8 w-full max-w-[1400px]">
			<div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
				<div className="space-y-1.5">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Connected Clusters
					</h1>
					<p className="text-muted-foreground text-sm">
						Manage your Kubernetes environments and Tendril agents.
					</p>
				</div>
				<div className="flex gap-3 shrink-0">
					<Link href="https://docs.itgix.com/setup/cli" target="_blank">
						<Button variant="outline" size="sm" className="h-9 text-xs font-medium border-border/50">
							<Terminal className="mr-2 h-3.5 w-3.5" />
							CLI Documentation
						</Button>
					</Link>
				</div>
			</div>

			<ClusterList initialClusters={clusters || []} userId={user!.id} />
		</div>
	);
}