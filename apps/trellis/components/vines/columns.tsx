"use client"

import type { ColumnDef } from "@tanstack/react-table"
import { formatDistanceToNow } from "date-fns"
import { ArrowRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { PublicVinesRow } from "@/lib/validations/db.schemas"

export const vinesColumns: ColumnDef<PublicVinesRow>[] = [
  {
    accessorKey: "project_name",
    header: "Project",
    enableSorting: true,
    cell: ({ row }) => (
      <span className="font-medium text-foreground text-sm">
        {row.getValue("project_name")}
      </span>
    ),
  },
  {
    accessorKey: "environment_stage",
    header: "Environment",
    enableSorting: true,
    cell: ({ row }) => (
      <Badge variant="outline" className="text-[11px] font-normal capitalize">
        {row.getValue("environment_stage")}
      </Badge>
    ),
  },
  {
    accessorKey: "region",
    header: "Region",
    enableSorting: true,
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground font-mono">
        {row.getValue("region")}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    enableSorting: true,
    cell: ({ row }) => {
      const status = row.getValue("status") as string
      const variant =
        status === "ACTIVE"
          ? "default"
          : status === "FAILED"
            ? "destructive"
            : "secondary"
      const className =
        status === "ACTIVE"
          ? "bg-emerald-600 text-white"
          : ""
      return (
        <Badge variant={variant} className={`text-[11px] font-normal ${className}`}>
          {status}
        </Badge>
      )
    },
  },
  {
    accessorKey: "estimated_monthly_cost",
    header: "Est. Cost",
    enableSorting: true,
    cell: ({ row }) => {
      const cost = row.getValue("estimated_monthly_cost") as number | null
      if (!cost) return <span className="text-xs text-muted-foreground">—</span>
      return (
        <span className="text-xs text-muted-foreground font-mono">
          ${cost.toFixed(0)}/mo
        </span>
      )
    },
  },
  {
    accessorKey: "updated_at",
    header: "Updated",
    enableSorting: true,
    cell: ({ row }) => {
      const updatedAt = row.getValue("updated_at") as string | null
      if (!updatedAt) return <span className="text-xs text-muted-foreground">—</span>

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
