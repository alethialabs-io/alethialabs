"use client";

import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { HelpCircle } from "lucide-react";

const HELP_CONTENT: Record<string, { title: string; description: string }> = {
	vineyard: {
		title: "Vineyard Workspace",
		description:
			"Groups multiple vines together. Think of it as a project workspace — one vineyard per team or product.",
	},
	environment: {
		title: "Environment Stage",
		description:
			"Development for testing and iteration. Staging for pre-production validation. Production for live workloads.",
	},
	vpc: {
		title: "Virtual Private Cloud",
		description:
			"An isolated network in your AWS account. All your infrastructure runs inside it. Create a new one or reuse an existing one.",
	},
	cidr: {
		title: "CIDR Block",
		description:
			"Defines the IP address range for your VPC. 10.0.0.0/16 gives ~65,000 addresses (recommended). Smaller /24 gives 256 addresses.",
	},
	"nat-gateway": {
		title: "NAT Gateway",
		description:
			"Lets resources in private subnets access the internet (e.g. pulling Docker images). Single is cheaper. Per-AZ provides high availability if one zone fails.",
	},
	"eks-version": {
		title: "EKS Version",
		description:
			"The Kubernetes version for your cluster. Newer versions have more features and security patches. Extended support versions cost 6x more per hour.",
	},
	karpenter: {
		title: "Karpenter Auto-Scaling",
		description:
			"Automatically provisions and removes EC2 nodes based on your workload's actual resource needs. Saves cost by right-sizing nodes instead of over-provisioning.",
	},
	"instance-types": {
		title: "EC2 Instance Types",
		description:
			"The machine sizes for your EKS nodes. t3 = burstable, good for dev/staging. m5a = general purpose, good for production. r5 = memory-optimized. Select up to 5 types for flexibility.",
	},
	"cluster-admins": {
		title: "Cluster Admins",
		description:
			"IAM users with full administrative access to the EKS cluster (system:masters group). Add your team members' email addresses.",
	},
	acu: {
		title: "Aurora Capacity Units",
		description:
			"Serverless scaling units for Aurora. Each ACU provides ~2 GB of memory. 0.5 ACU = minimal for dev ($43/mo). 2-4 = small production. 16+ = heavy workloads. You only pay for what you use between min and max.",
	},
	"iam-auth": {
		title: "IAM Authentication",
		description:
			"Lets applications authenticate to the database using IAM roles instead of passwords. More secure — no credentials to manage or rotate.",
	},
	"cache-engine": {
		title: "Cache Engine",
		description:
			"Redis is the industry standard in-memory cache. Valkey is a fully open-source Redis-compatible alternative maintained by the Linux Foundation. Both work the same way.",
	},
	"multi-az": {
		title: "Multi-AZ Failover",
		description:
			"Automatically replicates your cache to another availability zone. If the primary fails, the replica takes over with minimal downtime. Recommended for production.",
	},
	fifo: {
		title: "FIFO Queue",
		description:
			"First-In-First-Out. Guarantees messages are processed in exact order and delivered exactly once. Standard queues are cheaper but may deliver messages out of order or more than once.",
	},
	"visibility-timeout": {
		title: "Visibility Timeout",
		description:
			"After a consumer reads a message, it becomes invisible to other consumers for this duration. If not deleted in time, the message reappears in the queue. Default: 30 seconds.",
	},
	"acm-certificate": {
		title: "ACM Certificate",
		description:
			"AWS Certificate Manager automatically provisions, validates, and renews an SSL/TLS certificate for your domain. Free when used with AWS services like ALB and CloudFront.",
	},
	"cloudfront-waf": {
		title: "CloudFront WAF",
		description:
			"Web Application Firewall at the CDN edge. Protects against DDoS attacks, bot traffic, and common web exploits before they reach your infrastructure. ~$5/mo base cost.",
	},
	"application-waf": {
		title: "Application WAF",
		description:
			"Web Application Firewall at the application load balancer. Protects against SQL injection, cross-site scripting (XSS), and other application-layer attacks. ~$5/mo base cost.",
	},
	"hosted-zone": {
		title: "Route53 Hosted Zone",
		description:
			"A DNS zone that manages records for your domain. Select an existing zone from your AWS account. Grape uses it for DNS records but does not create new zones.",
	},
	dynamodb: {
		title: "DynamoDB Table",
		description:
			"A fully managed NoSQL database. Great for key-value lookups, session storage, and event logs. Pay per request — no capacity planning needed.",
	},
	"hash-key": {
		title: "Hash Key (Partition Key)",
		description:
			"The primary key for your table. Each item must have a unique hash key. Use something like 'id', 'userId', or 'orderId'.",
	},
	"range-key": {
		title: "Range Key (Sort Key)",
		description:
			"Optional second part of a composite primary key. Enables range queries within a partition. Common patterns: timestamp, version, or category.",
	},
	"billing-mode": {
		title: "Billing Mode",
		description:
			"On-demand: pay per read/write, no capacity planning. Best for unpredictable workloads. Provisioned: set read/write capacity units, cheaper for steady traffic.",
	},
	secrets: {
		title: "AWS Secrets Manager",
		description:
			"Securely stores and rotates sensitive values like database passwords, API keys, and tokens. Your application retrieves them at runtime — no hardcoded credentials.",
	},
};

interface Props {
	topic: keyof typeof HELP_CONTENT;
	className?: string;
}

export function HelpTooltip({ topic, className }: Props) {
	const content = HELP_CONTENT[topic];
	if (!content) return null;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={`inline-flex items-center justify-center rounded-full text-muted-foreground/50 hover:text-muted-foreground transition-colors ${className ?? ""}`}
				>
					<HelpCircle className="h-3.5 w-3.5" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="start"
				className="w-72 p-3"
			>
				<p className="text-xs font-medium text-foreground mb-1">
					{content.title}
				</p>
				<p className="text-xs text-muted-foreground leading-relaxed">
					{content.description}
				</p>
			</PopoverContent>
		</Popover>
	);
}
