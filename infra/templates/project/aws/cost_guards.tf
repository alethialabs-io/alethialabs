# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Plan-FAILING money-guards for the AWS project template (BYOC A1.2).
#
# Why this file exists: the BYOC nightly real-apply campaign provisions this template with LIVE
# cloud credentials (infra/aws-oidc, A1.1). A typo (`eks_ng_max_size = 5` -> `500`), a fat instance
# family, or an oversized root volume would silently provision an expensive estate before anyone
# noticed. `check` blocks (checks.tf) only emit WARNINGS — they do NOT stop a plan/apply — so cost
# ceilings live HERE, enforced with `terraform_data` resource `precondition`s (and variable
# `validation`), which ABORT `tofu plan`/`apply` with an error.
#
# Ceilings are generous enough for a real production BYOC cluster and each is overridable via its
# own `cost_guard_*` variable (an explicit, reviewed decision). Their job is to stop *accidental*
# runaway, not to cap intentional scale. Defaults are chosen so the shipped default config and the
# example tfvars plan cleanly; only pathological values fail.
#
# `terraform_data` is a built-in resource: it makes NO cloud API call and provisions nothing. Its
# preconditions are evaluated at PLAN time, so a violated guard fails the plan without ever touching
# the cloud. `tofu validate` does not evaluate preconditions, so the template still validates
# cleanly with default vars.

variable "cost_guard_max_nodes" {
  type        = number
  default     = 100
  description = "Money-guard: plan fails if eks_ng_max_size exceeds this. Guards a runaway worker-node ceiling. Raise explicitly for a genuinely large cluster."

  validation {
    condition     = var.cost_guard_max_nodes >= 1
    error_message = "cost_guard_max_nodes must be >= 1."
  }
}

variable "cost_guard_max_disk_gb" {
  type        = number
  default     = 1000
  description = "Money-guard: plan fails if eks_disk_size (per-node root EBS volume) exceeds this."

  validation {
    condition     = var.cost_guard_max_disk_gb >= 20
    error_message = "cost_guard_max_disk_gb must be >= 20 (the EKS root-volume floor)."
  }
}

variable "cost_guard_max_rds_acu" {
  type        = number
  default     = 16
  description = "Money-guard: plan fails if rds_scaling_config.max_capacity (Aurora Serverless v2 ACUs) exceeds this. Only enforced when create_rds is true."

  validation {
    condition     = var.cost_guard_max_rds_acu >= 0.5
    error_message = "cost_guard_max_rds_acu must be >= 0.5 (the Aurora Serverless v2 ACU floor)."
  }
}

variable "cost_guard_allow_large_instances" {
  type        = bool
  default     = false
  description = "Money-guard: when false (default), the plan rejects bare-metal / >=16xlarge / high-end GPU-accelerator EC2 types in eks_instance_types. Set true to intentionally provision them."
}

variable "cost_guard_require_expiry_tag" {
  type        = bool
  default     = false
  description = "Money-guard: when true, the plan fails unless a cost-owner expiry/TTL tag key (see cost_guard_expiry_tag_keys) is present in the classification/base tags, so a leaked estate is always time-bounded. The e2e nightly sets this true; production leaves it false."
}

variable "cost_guard_expiry_tag_keys" {
  type        = list(string)
  default     = ["alethia:expiry", "alethia:ttl", "expiry", "ttl"]
  description = "Acceptable expiry/TTL tag keys checked when cost_guard_require_expiry_tag is true."
}

locals {
  # EC2 instance types that are almost never intended for an automated/e2e provision and cost real
  # money per hour: bare metal (`.metal`), the largest sizes (>= .16xlarge — i.e. 16/18/24/32/48
  # xlarge), and high-end GPU/accelerator families (p2-p9, dl*, trn*, inf*). Matched
  # case-insensitively via RE2. The default `m5a.4xlarge` and the example `m5a.large` do NOT match.
  cost_guard_expensive_instance_regex = "(?i)(\\.metal|\\.(1[6-9]|[2-9][0-9])xlarge|^(p[2-9]|dl[0-9]|trn[0-9]|inf[0-9]))"

  cost_guard_flagged_instance_types = [
    for t in var.eks_instance_types : t
    if length(regexall(local.cost_guard_expensive_instance_regex, t)) > 0
  ]

  # Expiry/TTL tag keys actually present on the merged AWS default tags.
  cost_guard_present_expiry_keys = setintersection(
    toset(keys(local.aws_default_tags)),
    toset(var.cost_guard_expiry_tag_keys)
  )
}

# Single, inert guard resource holding every money-guard as a plan-time precondition. Each guard
# self-gates on the feature it protects (EKS / RDS / the expiry flag) so it is a no-op when that
# feature is off. A violated precondition aborts the plan with the MONEY-GUARD message.
resource "terraform_data" "cost_guards" {
  lifecycle {
    # Worker-node ceiling — the single biggest accidental-cost lever.
    precondition {
      condition     = !var.provision_eks || var.eks_ng_max_size <= var.cost_guard_max_nodes
      error_message = "MONEY-GUARD: eks_ng_max_size (${var.eks_ng_max_size}) exceeds cost_guard_max_nodes (${var.cost_guard_max_nodes}). Lower the node ceiling, or raise cost_guard_max_nodes intentionally."
    }

    # Desired must fit inside the ceiling, else the node group over-provisions / never stabilizes.
    precondition {
      condition     = !var.provision_eks || var.eks_ng_desired_size <= var.eks_ng_max_size
      error_message = "MONEY-GUARD: eks_ng_desired_size (${var.eks_ng_desired_size}) exceeds eks_ng_max_size (${var.eks_ng_max_size}); the node group would overspend and never stabilize."
    }

    # Per-node root EBS volume ceiling.
    precondition {
      condition     = !var.provision_eks || var.eks_disk_size <= var.cost_guard_max_disk_gb
      error_message = "MONEY-GUARD: eks_disk_size (${var.eks_disk_size} GB) exceeds cost_guard_max_disk_gb (${var.cost_guard_max_disk_gb} GB)."
    }

    # Reject bare-metal / oversized / high-end GPU EC2 types unless explicitly allowed.
    precondition {
      condition     = !var.provision_eks || var.cost_guard_allow_large_instances || length(local.cost_guard_flagged_instance_types) == 0
      error_message = "MONEY-GUARD: eks_instance_types contains expensive/oversized types ${jsonencode(local.cost_guard_flagged_instance_types)} (bare-metal / >=16xlarge / high-end GPU-accelerator). Pick a smaller type, or set cost_guard_allow_large_instances = true."
    }

    # Aurora Serverless v2 ACU ceiling (each ACU bills ~2 GB RAM of capacity per hour).
    precondition {
      condition     = !var.create_rds || var.rds_scaling_config.max_capacity <= var.cost_guard_max_rds_acu
      error_message = "MONEY-GUARD: rds_scaling_config.max_capacity (${var.rds_scaling_config.max_capacity} ACU) exceeds cost_guard_max_rds_acu (${var.cost_guard_max_rds_acu} ACU)."
    }

    # A cost-guarded (e.g. e2e) run must carry an expiry/TTL tag so a leaked estate is time-bounded.
    precondition {
      condition     = !var.cost_guard_require_expiry_tag || length(local.cost_guard_present_expiry_keys) > 0
      error_message = "MONEY-GUARD: cost_guard_require_expiry_tag is set but no expiry/TTL tag key (${join(", ", var.cost_guard_expiry_tag_keys)}) is present in classification/base tags; a cost-guarded run must be time-bounded."
    }
  }
}
