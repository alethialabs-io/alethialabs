"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatDistanceToNow } from "date-fns"
import { ArrowRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { PublicConfigurationsRow } from "@/lib/validations/db.schemas"

const featureFlags = [
  { key: "create_vpc", label: "VPC" },
  { key: "create_rds", label: "RDS" },
  { key: "enable_redis", label: "Redis" },
  { key: "enable_karpenter", label: "Karpenter" },
] as const

export const vinesColumns: ColumnDef<PublicConfigurationsRow>[] = [
  {
    accessorKey: "project_name",
    header: "Project",
    enableSorting: true,
    cell: ({ row }) => (
      <span className="text-sm font-medium">
        {row.getValue("project_name")}
      </span>
    ),
  },
  {
    accessorKey: "environment_stage",
    header: "Environment",
    enableSorting: true,
    cell: ({ row }) => (
      <Badge variant="outline" className="text-xs uppercase">
        {row.getValue("environment_stage")}
      </Badge>
    ),
  },
  {
    accessorKey: "container_platform",
    header: "Platform",
    enableSorting: false,
    cell: ({ row }) => (
      <Badge variant="secondary" className="text-xs">
        {row.getValue("container_platform")}
      </Badge>
    ),
  },
  {
    accessorKey: "aws_region",
    header: "Region",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.getValue("aws_region") ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    enableSorting: true,
    cell: ({ row }) => {
      const status = row.getValue("status") as string | null

      if (status === "completed") {
        return (
          <Badge
            variant="outline"
            className="border-emerald-200 bg-emerald-50 text-emerald-700"
          >
            {status}
          </Badge>
        )
      }

      if (status === "draft") {
        return (
          <Badge
            variant="outline"
            className="bg-muted/30 text-muted-foreground"
          >
            {status}
          </Badge>
        )
      }

      return (
        <Badge
          variant="outline"
          className="bg-foreground/5 text-foreground"
        >
          {status ?? "—"}
        </Badge>
      )
    },
  },
  {
    id: "features",
    header: "Features",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        {featureFlags.map(({ key, label }) => (
          <span
            key={key}
            title={label}
            className={`h-2 w-2 rounded-full ${
              row.original[key] ? "bg-foreground" : "bg-muted-foreground/20"
            }`}
          />
        ))}
      </div>
    ),
  },
  {
    accessorKey: "updated_at",
    header: "Updated",
    enableSorting: true,
    cell: ({ row }) => {
      const updatedAt = row.getValue("updated_at") as string | null
      if (!updatedAt) return <span className="text-xs text-muted-foreground">{"—"}</span>

      return (
        <span className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(updatedAt), { addSuffix: true })}
        </span>
      )
    },
  },
  {
    id: "actions",
    enableSorting: false,
    cell: () => (
      <div className="flex justify-end">
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </div>
    ),
  },
]
