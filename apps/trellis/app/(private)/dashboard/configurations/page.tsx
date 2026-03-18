import { getConfigurations } from "@/app/server/actions/configurations";
import { ConfigurationDownloadButtons } from "@/components/configuration-download-buttons";
import { ConfigurationSheetWrapper } from "@/components/configuration-sheet-wrapper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Clock, Cloud, FileText } from "lucide-react";
import Link from "next/link";

export default async function ConfigurationsPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	const { configurations } = await getConfigurations();

	const { hightlight: highlightedConfig, config_id } = await searchParams;

	return (
		<div className="space-y-8 w-full">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Configurations
				</h1>
				<p className="text-muted-foreground text-sm">
					View, manage, and download your infrastructure
					configurations.
				</p>
			</div>

			{configurations && configurations.length > 0 ? (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{configurations.map((config: PublicConfigurationsRow) => (
						<div
							key={config.id}
							className={cn(
								"group flex flex-col justify-between transition-all bg-card shadow-sm border border-border/40 rounded-xl hover:border-foreground/20 hover:shadow-md",
								(highlightedConfig === config.id ||
									config_id === config.id) &&
									"border-foreground ring-1 ring-foreground shadow-md",
							)}
						>
							<div className="p-5 pb-0">
								<div className="flex items-start justify-between mb-3">
									<div className="flex flex-col gap-1.5 overflow-hidden">
										<h3 className="font-semibold text-base truncate text-foreground pr-2">
											{config.project_name}
										</h3>
										<div className="flex items-center gap-2">
											<Badge
												variant="secondary"
												className="font-medium text-[10px] px-1.5 py-0 h-5 bg-muted/60 text-muted-foreground border-transparent"
											>
												{config.environment_stage}
											</Badge>
											<Badge
												variant="outline"
												className="font-medium text-[10px] px-1.5 py-0 h-5 text-muted-foreground"
											>
												{config.container_platform}
											</Badge>
										</div>
									</div>
								</div>
								<p className="line-clamp-2 text-xs text-muted-foreground h-8 leading-relaxed mb-4">
									{config.description ||
										`A highly-available configuration tailored for ${config.container_platform}.`}
								</p>
							</div>

							<div className="p-5 pt-0 flex flex-col gap-4">
								<div className="flex items-center gap-4 text-xs text-muted-foreground">
									<div className="flex items-center gap-1.5">
										<Cloud className="w-3.5 h-3.5" />
										<span className="truncate max-w-25">
											{config.aws_region || "N/A"}
										</span>
									</div>
									<div className="flex items-center gap-1.5">
										<Clock className="w-3.5 h-3.5" />
										<span>
											{formatDistanceToNow(
												new Date(config.updated_at!),
												{ addSuffix: true },
											)}
										</span>
									</div>
								</div>

								<div className="flex items-center gap-2 pt-4 border-t border-border/40">
									<div className="flex-1">
										<ConfigurationDownloadButtons
											configId={config.id}
										/>
									</div>
									<Link
										href={`?config_id=${config.id}`}
										scroll={false}
									>
										<Button
											variant="ghost"
											size="sm"
											className="h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
										>
											Details{" "}
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
					<FileText className="h-10 w-10 text-muted-foreground mb-4 opacity-40" />
					<h3 className="text-base font-medium text-foreground mb-1">
						No configurations saved yet
					</h3>
					<p className="text-sm text-muted-foreground mb-6 max-w-sm leading-relaxed">
						Create your first infrastructure configuration to see it
						here. You'll be able to quickly view, edit, and reuse it
						across projects.
					</p>
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

			<ConfigurationSheetWrapper configurations={configurations || []} />
		</div>
	);
}
