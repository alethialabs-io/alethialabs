import { getVineyardById } from "@/app/server/actions/vineyards";
import { VineyardEstateMap } from "@/components/vineyard-estate-map";
import { BootstrapLogsViewer } from "@/components/bootstrap-logs-viewer";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function VineyardDetailsPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	try {
		const { vineyard } = await getVineyardById(id);

		if (!vineyard) {
			return notFound();
		}

		return (
			<div className="flex flex-col gap-6 w-full">
				<div className="flex flex-col min-h-[600px] h-[600px] w-full relative rounded-xl border border-border shadow-sm overflow-hidden">
					{/* Top bar over the canvas */}
					<div className="absolute top-4 left-4 z-10 flex flex-col gap-4 bg-background/80 backdrop-blur-md p-4 rounded-xl border border-border/50 shadow-sm pointer-events-auto">
						<div className="flex items-center gap-3">
							<Link href="/dashboard/vineyards">
								<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
									<ArrowLeft className="w-4 h-4" />
								</Button>
							</Link>
							<div>
								<h1 className="text-xl font-semibold tracking-tight text-foreground">
									{vineyard.name}
								</h1>
								<p className="text-xs text-muted-foreground">
									Estate Map & Topology
								</p>
							</div>
						</div>
					</div>

					<div className="flex-1 w-full h-full relative bg-muted/10">
						<VineyardEstateMap vineyard={vineyard} />
					</div>
				</div>

				<div className="w-full mb-10">
					<BootstrapLogsViewer vineyardId={id} />
				</div>
			</div>
		);
	} catch (error) {
		return notFound();
	}
}