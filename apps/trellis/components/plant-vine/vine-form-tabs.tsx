"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Database, GitBranch, Layers, Shield, CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { SectionProjectBasics } from "./section-project-basics";
import { SectionNetwork } from "./section-network";
import { SectionCluster } from "./section-cluster";
import { SectionDatabases } from "./section-databases";
import { SectionCaches } from "./section-caches";
import { SectionNosql } from "./section-nosql";
import { SectionMessaging } from "./section-messaging";
import { SectionDns } from "./section-dns";
import { SectionSecrets } from "./section-secrets";
import { SectionRepositories } from "./section-repositories";
import { ReviewTab } from "./review-tab";

/** Tabbed container for all vine form sections. */
export function VineFormTabs() {
	const [activeTab, setActiveTab] = useState("core");

	return (
		<Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
			<TabsList className="w-full justify-start border-b border-border/40 bg-transparent p-0 h-auto gap-0">
				<TabsTrigger
					value="core"
					className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
				>
					<Layers className="h-3.5 w-3.5 mr-1.5" />
					Core
				</TabsTrigger>
				<TabsTrigger
					value="services"
					className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
				>
					<Database className="h-3.5 w-3.5 mr-1.5" />
					Services
				</TabsTrigger>
				<TabsTrigger
					value="security"
					className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
				>
					<Shield className="h-3.5 w-3.5 mr-1.5" />
					Security
				</TabsTrigger>
				<TabsTrigger
					value="git"
					className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
				>
					<GitBranch className="h-3.5 w-3.5 mr-1.5" />
					Git
				</TabsTrigger>
				<TabsTrigger
					value="review"
					className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
				>
					<CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
					Review
				</TabsTrigger>
			</TabsList>

			<div className="pt-6">
				<TabsContent value="core" className="mt-0 space-y-6">
					<SectionProjectBasics />
					<SectionNetwork />
					<SectionCluster />
				</TabsContent>

				<TabsContent value="services" className="mt-0 space-y-6">
					<SectionDatabases />
					<SectionCaches />
					<SectionNosql />
					<SectionMessaging />
				</TabsContent>

				<TabsContent value="security" className="mt-0 space-y-6">
					<SectionDns />
					<SectionSecrets />
				</TabsContent>

				<TabsContent value="git" className="mt-0 space-y-6">
					<SectionRepositories />
				</TabsContent>

				<TabsContent value="review" className="mt-0 space-y-6">
					<ReviewTab />
				</TabsContent>
			</div>
		</Tabs>
	);
}
