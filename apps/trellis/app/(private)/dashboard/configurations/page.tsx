import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Bot, Briefcase, Clock, FileText, Settings } from "lucide-react";
import Link from "next/link";

export default async function ConfigurationsPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: configurations } = await supabase
		.from("configurations")
		.select("*")
		.eq("user_id", user!.id)
		.order("updated_at", { ascending: false });

	const { hightlight: highlightedConfig } = await searchParams;

	return (
		<div className="space-y-8 w-full max-w-[1200px]">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Configurations
				</h1>
				<p className="text-muted-foreground text-sm">
					View, manage, and download your infrastructure configurations.
				</p>
			</div>

			{configurations && configurations.length > 0 ? (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{configurations.map((config: PublicConfigurationsRow) => (
						<Card
							key={config.id}
							className={cn(
								"flex flex-col justify-between transition-colors shadow-sm border-border/40 hover:border-border",
								highlightedConfig === config.id &&
									"border-foreground ring-1 ring-foreground shadow-md"
							)}
						>
							<CardHeader className="pb-4">
								<div className="flex items-center gap-3 mb-2">
									<div className="p-2 border border-border/50 bg-muted/20 rounded-md">
										<Settings className="h-4 w-4 text-foreground" />
									</div>
									<CardTitle className="text-base font-medium truncate">
										{config.project_name}
									</CardTitle>
								</div>
								<CardDescription className="line-clamp-2 h-10 text-xs">
									{config.description ||
										`A configuration for the ${config.environment_stage} environment.`}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4 pb-4">
								<div className="flex items-center justify-between text-[13px]">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Briefcase className="h-3.5 w-3.5" />
										<span>Platform</span>
									</div>
									<Badge variant="secondary" className="font-normal px-2 py-0 h-5 text-[11px]">
										{config.container_platform}
									</Badge>
								</div>
								<div className="flex items-center justify-between text-[13px]">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Clock className="h-3.5 w-3.5" />
										<span>Last Updated</span>
									</div>
									<span className="font-medium text-foreground">
										{formatDistanceToNow(
											new Date(config.updated_at!),
											{
												addSuffix: true,
											},
										)}
									</span>
								</div>
							</CardContent>
							<CardFooter className="flex justify-end gap-2 pt-4 border-t border-border/20 bg-muted/5">
								<Button variant="ghost" size="sm" className="h-8 text-xs font-medium">View Details</Button>
								<Link
									href={`/api/download/config?id=${config.id}`}
								>
									<Button size="sm" variant="outline" className="h-8 text-xs font-medium">Download</Button>
								</Link>
							</CardFooter>
						</Card>
					))}
				</div>
			) : (
				<Card className="border-border/40 shadow-sm bg-muted/10">
					<CardContent className="flex flex-col items-center justify-center py-16 text-center">
						<FileText className="h-12 w-12 text-muted-foreground mb-4 opacity-30" />
						<h3 className="text-sm font-medium text-foreground mb-1">
							No configurations saved yet
						</h3>
						<p className="text-xs text-muted-foreground mb-6 max-w-sm">
							Create your first configuration to see it here.
							You'll be able to view, edit, and reuse them.
						</p>
						<Link href="/dashboard/configure">
							<Button size="sm" className="h-8 text-xs font-medium">
								Create Configuration
								<ArrowRight className="ml-2 h-3.5 w-3.5" />
							</Button>
						</Link>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
