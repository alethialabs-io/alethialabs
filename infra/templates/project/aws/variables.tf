#########################################################################
##                     General Configuration Variables                 ##
#########################################################################

variable "aws_account_id" {
  type        = string
  description = "AWS account to deploy resources"

  # FAIL CLOSED. This id is interpolated into account-scoped ARNs all over the template — the RDS
  # secret KMS key policy, every IRSA policy, the ECR repository ARNs, the DynamoDB assume-role.
  # An empty value renders `arn:aws:iam:::root` and the apply dies deep in the graph, hours in,
  # with an error that names KMS rather than the missing input:
  #
  #   InvalidArnException: An ARN in the specified key policy is invalid.
  #
  # That is exactly what run 30738253176 hit: the emitted plan JSON carried
  # "aws_account_id":{"value":""} while the credentials themselves were fine. A malformed account
  # id must never reach apply, so this rejects at plan time and says which input is wrong.
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account id. It is empty or malformed — the runner resolves it from the connector's CloudIdentity, or for an ambient-credential runner from $AWS_ACCOUNT_ID."
  }
}

variable "region" {
  type        = string
  description = "AWS region to deploy to"
}

variable "environment" {
  type        = string
  description = "Environment in which the infrastructure is going to be deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

# Per-cloud classification tags emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia:project-id` /
# `alethia:environment-id` sweep handles that let a guarded sweeper scope destroys to exactly one
# environment. Merged into local.aws_default_tags and the EBS-CSI extraVolumeTags so it lands on
# real resources; the platform base tags always WIN a key collision (they sit on the merge RHS).
variable "classification_tags" {
  type        = map(string)
  description = "Classification + sweep-handle tags to stamp on every taggable resource (colon-namespaced AWS keys). Platform base tags override on conflict."
  default     = {}
}

variable "rds_iam_irsa" {
  type        = bool
  description = "Enable creation of RDS IAM Policy"
  default     = false
}

variable "allow_long_names" {
  type        = string
  default     = true
  description = "Allows longer IAM role names without suffixes. Leave true for new clusters. Set to false for pre-existing clusters to avoid re-creation."
}

#########################################################################
##                   Networking Variables                              ##
#########################################################################
variable "provision_vpc" {
  type    = bool
  default = true
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR of VPC to be used by Resale common resources"
  default     = ""

  validation {
    condition     = var.vpc_cidr == "" || can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be empty (use an external VPC) or a valid IPv4 CIDR, e.g. 10.0.0.0/16."
  }
}

variable "vpc_id" {
  type        = string
  description = "External VPC ID"
  default     = ""
}

variable "vpc_private_subnet_ids" {
  description = "External VPC private subnet IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_public_subnet_ids" {
  description = "External VPC public subnet IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_private_route_table_ids" {
  description = "External VPC private route table IDs"
  type        = list(string)
  default     = [""]
}

variable "vpc_single_nat_gateway" {
  type        = bool
  default     = false
  description = "Wether to use just a single NAT gateway instead of a NAT GW per availability zone for HA and as recommended. This might be suitable for dev/test environments"
}

#########################################################################
##                   EKS Variables                              ##
#########################################################################


variable "provision_eks" {
  type    = bool
  default = true
}

variable "eks_cluster_version" {
  type = string
  # NOTE: the managed path sets this from the catalog SSOT (catalog.json); this default is the
  # BYO-IaC fallback only. Keep both on the same standard minor.
  description = "Desired Kubernetes cluster version"
  default     = "1.35"
}

# #1987. ADDITIVE, never restrictive: merged into the EKS node security group's rules alongside the
# template's own, so the empty default leaves the plan byte-identical and cannot lock the external
# runner out of a cluster it still has to provision. Distinct from
# cluster_endpoint_public_access_cidrs below, which gates the API ENDPOINT rather than the network.
variable "vpc_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "Extra source CIDRs permitted inbound to this VPC's cluster nodes, on top of the template's own rules. Empty (the default) adds nothing."

  validation {
    # alltrue([]) is true, so the empty default passes without a special case.
    condition     = alltrue([for c in var.vpc_allowed_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "vpc_allowed_cidr_blocks must all be valid CIDRs (e.g. 10.1.0.0/16)."
  }
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "CIDRs with access to the EKS cluster. Restricted to customer and Alethia"
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.cluster_endpoint_public_access_cidrs) > 0 && alltrue([for c in var.cluster_endpoint_public_access_cidrs : can(cidrhost(c, 0))])
    error_message = "cluster_endpoint_public_access_cidrs must be a non-empty list of valid IPv4 CIDRs."
  }
}

variable "cluster_log_retention_in_days" {
  type        = number
  description = "Cluster log retention in days"
  default     = 14
}

variable "eks_kms_key_users" {
  description = "A list of IAM ARNs for [key users](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html#key-policy-default-allow-users)"
  type        = list(string)
  default     = []
}

variable "eks_cluster_admins" {
  type = list(
    object({
      username = string
      path     = optional(string, "/users/")
    })
  )
  default = []
}

variable "eks_access_entries" {
  type        = any
  description = "Map of access entries to add to the cluster"
  default     = {}
}

################################################################################
# Node group defaults
################################################################################

variable "eks_ami_type" {
  description = "Default AMI type for the EKS worker nodes"
  type        = string
  default     = "BOTTLEROCKET_x86_64"
}

variable "eks_disk_size" {
  description = "Disk size of the root volume attached to the EKS worker nodes"
  type        = number
  default     = 50

  validation {
    condition     = var.eks_disk_size >= 20
    error_message = "eks_disk_size must be at least 20 GB."
  }
}

variable "eks_instance_types" {
  # Equal to the catalog default (packages/core/catalog/catalog.json compute.aws.default_instance)
  # by rule: TestTemplateNodeDefaultsEqualTheCatalog fails when they differ (#5266).
  description = "EC2 instance types for the EKS worker nodes"
  type        = list(string)
  default     = ["t3.large"]

  validation {
    condition     = length(var.eks_instance_types) > 0
    error_message = "eks_instance_types must list at least one instance type."
  }
}

variable "eks_volume_type" {
  description = "Type of the root EBS volume attached to the EKS worker nodes"
  type        = string
  default     = "gp3"
}

variable "eks_volume_iops" {
  description = "Number of IOPs on the root EBS volumes"
  type        = number
  default     = 3000
}

variable "eks_ng_min_size" {
  description = "Minimum number of the worker nodes in the node group"
  type        = number
  default     = 2
}

variable "eks_ng_max_size" {
  description = "Maximum number of the worker nodes in the node group"
  type        = number
  default     = 5

  validation {
    condition     = var.eks_ng_max_size >= var.eks_ng_min_size
    error_message = "eks_ng_max_size must be >= eks_ng_min_size."
  }
}

variable "eks_ng_desired_size" {
  description = "Desired number of the worker nodes in the node group"
  type        = number
  default     = 2
}

variable "eks_ng_capacity_type" {
  # ON_DEMAND by default, Spot opt-in (#5266, maintainer decision): a cluster nobody asked to make
  # interruptible is not interruptible. The console carries the choice as project_cluster.capacity_type
  # and the aws provider writes this variable from it. Clusters provisioned while the default was SPOT
  # were pinned to SPOT by migration, so changing this default replaces no existing node group.
  description = "Capacity type for the EKS managed node group: ON_DEMAND (default) or SPOT"
  type        = string
  default     = "ON_DEMAND"

  validation {
    condition     = contains(["SPOT", "ON_DEMAND"], var.eks_ng_capacity_type)
    error_message = "eks_ng_capacity_type must be SPOT or ON_DEMAND."
  }
}

# ── Node labels, taints and extra EKS managed node groups (#5534) ────────────────────────────────
#
# The cross-cloud node-pool contract (#5533). The three blocks below are COPIES of
# packages/core/cloud/testdata/nodepool/reference/variables.tf: the `type`, `default`, `nullable` and
# every `validation` must stay token-equal to it (packages/core/cloud/nodepool_aws_test.go holds them
# there), and the key/value regexes are packages/core/nodekeys (drift_test.go). Read the reference
# for what each rule is and why. AWS adds one rule of its own on extra_node_pools (the instance type
# and its architecture).
#
# eks.tf renders what each pool's nodes carry (local.nodepool_contract_render), and modules/eks builds
# the node groups from that render: node_labels reach eks_workers and every extra group, node_taints and the arm64
# platform taint only the extra groups.

variable "node_labels" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Labels on the nodes of every Alethia-managed pool, the default pool included. A pool's own labels win for the same key. At most 24. Keys whose prefix ends in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io are refused."

  validation {
    condition = length(var.node_labels) <= 24 && alltrue([for k, v in var.node_labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ])
    error_message = "node_labels may hold at most 24 labels. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for k, v in var.node_labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ])
    error_message = "node_labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those labels themselves, and a kubelet refuses to start with them. Use your own prefix, such as example.com/team, or none."
  }
}

variable "node_taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default     = []
  nullable    = false
  description = "Taints on the nodes of every extra pool (not the default pool, which runs the platform's add-ons). A pool's own taint wins for the same key and effect. At most 24. effect is one of NoSchedule, PreferNoSchedule and NoExecute."

  validation {
    condition     = length(var.node_taints) <= 24 && alltrue([for t in var.node_taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in var.node_taints : "${t.key}:${t.effect}"])) == length(var.node_taints)
    error_message = "node_taints may hold at most 24 taints, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ])
    error_message = "node_taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ])
    error_message = "node_taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those taints themselves (alethia.io/arch marks arm64 pools)."
  }
}

variable "extra_node_pools" {
  type = list(object({
    name          = string
    instance_type = string
    min_size      = number
    max_size      = number
    desired_size  = optional(number)
    arch          = optional(string, "amd64")
    capacity_type = optional(string, "on-demand")
    labels        = optional(map(string), {})
    taints = optional(list(object({
      key    = string
      value  = optional(string)
      effect = string
    })), [])
  }))
  default     = []
  nullable    = false
  description = "Node pools beside the default pool. Each has a name, an instance type, min/max/desired sizes, an optional arch (amd64 or arm64) and capacity_type (on-demand or spot), and its own labels and taints. Its nodes carry the label alethia.io/pool=<name>; an arm64 pool also carries the taint alethia.io/arch=arm64:NoSchedule."

  validation {
    condition = length(var.extra_node_pools) <= 10 && length(distinct([for p in var.extra_node_pools : p.name])) == length(var.extra_node_pools) && alltrue([for p in var.extra_node_pools :
      can(regex("^[a-z][a-z0-9]{0,11}$", p.name)) && !contains(["default", "system", "spot"], p.name) && !can(regex("^pool[0-9]+$", p.name))
    ])
    error_message = "extra_node_pools may list at most 10 pools, each with a unique name of 1 to 12 lowercase letters and digits starting with a letter (the AKS pool-name rule, applied on every cloud so the file is portable). The names default, system, spot and pool1, pool2, ... are taken by pools Alethia already makes."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", p.instance_type)) && contains(["amd64", "arm64"], p.arch) && contains(["on-demand", "spot"], p.capacity_type)
    ])
    error_message = "extra_node_pools instance_type must be a cloud instance type such as \"m7g.large\", \"e2-standard-4\", \"Standard_D4s_v5\" or \"cx32\" (letters, digits, '.', '_' and '-', up to 64); arch must be \"amd64\" or \"arm64\"; capacity_type must be \"on-demand\" or \"spot\"."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      floor(p.min_size) == p.min_size && floor(p.max_size) == p.max_size && p.min_size >= 0 && p.max_size >= 1 && p.max_size <= 100 && p.min_size <= p.max_size &&
      (p.desired_size == null ? true : floor(p.desired_size) == p.desired_size && p.desired_size >= p.min_size && p.desired_size <= p.max_size)
    ])
    error_message = "extra_node_pools sizes must be whole numbers with 0 <= min_size <= desired_size <= max_size and 1 <= max_size <= 100. desired_size may be left out, and then equals min_size."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools : length(p.labels) <= 25]) && alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ]]))
    error_message = "extra_node_pools labels may hold at most 25 labels per pool. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ]]))
    error_message = "extra_node_pools labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia labels every pool alethia.io/pool=<name> itself."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      length(p.taints) <= 25 && alltrue([for t in p.taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in p.taints : "${t.key}:${t.effect}"])) == length(p.taints)
    ])
    error_message = "extra_node_pools taints may hold at most 25 taints per pool, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once in a pool."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ]]))
    error_message = "extra_node_pools taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ]]))
    error_message = "extra_node_pools taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia taints every arm64 pool alethia.io/arch=arm64:NoSchedule itself."
  }
  # AWS's own rule, beside the contract's: an EC2 instance type (family.size, the family being letters
  # then a generation digit, as every EC2 family since the first is), whose architecture is
  # the pool's arch. Graviton families are a1, and those with a "g" right after their generation
  # digit (m7g, c6gn, t4g, g5g). An arm64 pool on an x86 type, or the reverse, fails at apply with an AMI/instance
  # mismatch, so it is refused here, at plan.
  validation {
    condition = alltrue([for p in var.extra_node_pools :
      can(regex("^[a-z]+[0-9][a-z0-9-]*\\.[a-z0-9-]+$", p.instance_type)) && (p.arch == "arm64") == can(regex("^(a1([.]|$)|[a-z]+[0-9]+g)", p.instance_type))
    ])
    error_message = "extra_node_pools instance_type must be an EC2 instance type (family.size, such as \"m7i.large\") whose architecture matches the pool's arch: an arm64 pool needs a Graviton type such as \"m7g.large\", \"c7g.xlarge\" or \"a1.large\", and an amd64 pool an x86 type such as \"m7i.large\" or \"g5.xlarge\"."
  }
  # AWS: an AMI exists for every pool, in eks_workers' OS family (eks.tf, local.eks_ami_families; the
  # GPU regex is eks.tf's local.eks_nvidia_instance_type, written out because a validation cannot
  # read a local that reads this variable).
  # Without this, a missing AMI would leave the group on the module default, eks_workers' x86 AMI.
  validation {
    condition = length(var.extra_node_pools) == 0 || (
      contains(keys(local.eks_ami_family_of), var.eks_ami_type) &&
      alltrue([for p in var.extra_node_pools :
        contains(["amd64", "arm64"], p.arch) ? local.eks_ami_families[lookup(local.eks_ami_family_of, var.eks_ami_type, "al2023")][p.arch][
          can(regex("^(g[0-9]+[a-z]*|gr[0-9]+[a-z]*|p[0-9]+[a-z]*)[.]", p.instance_type)) && !startswith(p.instance_type, "g4ad.") ? "gpu" : "cpu"
        ] != null : true
      ])
    )
    error_message = "extra_node_pools need an x86 eks_ami_type to take their OS family from (BOTTLEROCKET_x86_64, BOTTLEROCKET_x86_64_NVIDIA, BOTTLEROCKET_x86_64_FIPS, AL2023_x86_64_STANDARD, AL2023_x86_64_NVIDIA, AL2023_x86_64_NEURON, AL2_x86_64 or AL2_x86_64_GPU), and an EKS AMI must exist for each pool: there is no FIPS Bottlerocket AMI for a GPU instance type, and no AL2 AMI for an arm64 GPU instance type."
  }


}

#########################################################################
##                   RDS Variables                                     ##
#########################################################################
variable "create_rds" {
  type        = bool
  description = "If a new RDS and Proxy needs to be created"
  default     = false
}
# The `engine_version` defaults below (there are TWO — the optional() one and the whole-object one)
# are COUPLED to cloud.DefaultAuroraPostgresVersion in packages/core/cloud/aws_provider.go and are
# asserted equal to it by TestAuroraVersionCouplings. Change them together or CI fails.
#
# They were 16.6 until AWS withdrew that minor and every full-bar aws nightly died at the cluster.
# `cluster_family` tracks this version's MAJOR (Aurora PostgreSQL families are major-only).
variable "rds_config" {
  description = "Configuration for RDS resources"
  type = object({
    engine         = optional(string, "aurora-postgresql")
    engine_version = optional(string, "16.8")
    engine_mode    = optional(string, "provisioned")
    cluster_family = optional(string, "aurora-postgresql16")
    cluster_size   = optional(number, 1)
    db_port        = optional(number, 5432)
    db_name        = optional(string, "")
  })
  default = ({
    engine         = "aurora-postgresql"
    engine_version = "16.8"
    engine_mode    = "provisioned"
    cluster_family = "aurora-postgresql16"
    cluster_size   = 1
    db_port        = 5432
    db_name        = ""
  })
}
variable "rds_scaling_config" {
  description = "The minimum and maximum number of Aurora capacity units (ACUs) for a DB instance"
  type = object({
    min_capacity = number
    max_capacity = number
  })
  default = ({
    min_capacity = 0.5
    max_capacity = 2.0
    }
  )
}
variable "rds_default_username" {
  type        = string
  description = "DB username"
  default     = "postgres"
}
variable "rds_iam_auth_enabled" {
  type        = bool
  description = "Specifies whether or mappings of AWS Identity and Access Management (IAM) accounts to database accounts is enabled"
  default     = false
}
variable "rds_logs_exports" {
  type        = list(string)
  description = "List of log types to export to cloudwatch. Aurora MySQL: audit, error, general, slowquery. Aurora PostgreSQL: postgresql"
  default     = ["postgresql"]
}

variable "rds_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "List of CIDRs to be allowed to connect to the DB instance"
}

variable "rds_extra_credentials" {
  description = "Database extra credentials"
  type = object({
    username = string
    password = optional(string)
    database = string
  })
  default = {
    username = "demouser"
    database = "demodb"
  }
}
variable "rds_instance_type" {
  description = "Instance type - can be changed to db.t2.small for a non-serverless db"
  type        = string
  default     = "db.serverless"
}
#variable "bucket_to_export_name" {
#  type        = string
#  description = "Variable to set the name of the bucket in the policy to export data from the database to S3"
#  default     = ""
#}
#
#variable "enable_rds_s3_exports" {
#  type        = bool
#  description = "If a the s3 exports needs to be enabled"
#  default     = false
#}

variable "rds_backup_retention_period" {
  type        = number
  default     = 5
  description = "Number of days to retain backups for"
}

variable "rds_cluster_parameters" {
  type = list(object({
    name         = string
    value        = string
    apply_method = string
  }))
  default = []
}
#########################################################################
##                   SQS Variables                                     ##
#########################################################################

variable "sqs_username" {
  type        = string
  default     = ""
  description = "If not empty, created IAM User for usage with SQS for a more granular access"
}
variable "sqs_iam_role_name" {
  type        = string
  default     = ""
  description = "If not empty, created IAM Role for usage with SQS for a more granular access"
}
variable "sqs_queues" {
  type = map(any)
}
variable "sns_topics" {
  type = map(any)
}
variable "provision_sqs" {
  type        = string
  default     = false
  description = "Enables creation of SQS/SNS resources"
}

#########################################################################
##                   WAF Variables                                     ##
#########################################################################
variable "application_waf_enabled" {
  type        = bool
  description = "Specifies whether WAF should be provisioned"
  default     = false
}
variable "cloudfront_waf_enabled" {
  type        = bool
  description = "Specifies whether cloudfront for the WAF should be provisioned"
  default     = false
}
variable "waf_default_action" {
  type        = string
  default     = "allow"
  description = "allow or block - default action of WAF when a request hasn't matched any rules"
}

# WIRED BY #4320. Declared, carried all the way to tfvars, and read by NO resource: modules/wafv2
# had one rule input (`custom_rules`) and this list reached neither it nor the Web ACL, so a rate
# limit a caller asked for was accepted and never built. It now has its own typed input and its own
# rule loop in modules/wafv2/webacl.tf.
#
# Typed rather than left `list(any)`: `any` declares no shape at all, so a misspelt key used to be
# dropped in silence — the same failure this knob already was, one level down.
variable "waf_rate_limit_rules" {
  description = <<-EOT
    Rate-based WAF rules, short form. Applied to BOTH Web ACLs (regional + CloudFront), like every
    other rule input here.

    Priorities share one space with `waf_custom_rules` and the managed rule groups — WAFv2 rejects a
    Web ACL with two rules at the same priority. `evaluation_window_sec` unset leaves WAF's own
    300-second window.

    A rate limit that needs a scope-down statement (limit only requests matching some other
    statement tree) belongs in `waf_custom_rules` as `statement.rate_based_statement` instead; see
    modules/wafv2/examples/custom-rules.tfvars.
  EOT
  type = list(object({
    name                  = string
    priority              = number
    limit                 = number
    action                = optional(string, "block")
    aggregate_key_type    = optional(string, "IP")
    evaluation_window_sec = optional(number)
  }))
  default = []
}

variable "waf_webacl_cloudwatch_enabled" {}
variable "waf_sampled_requests_enabled" {}
variable "waf_logging_enabled" {}
variable "waf_log_retention_days" {}
variable "aws_managed_waf_rule_groups" {
  type    = any
  default = []
}

variable "custom_managed_waf_rule_groups" {
  type    = list(any)
  default = []
}

variable "waf_custom_rules" {
  description = <<-EOT
    Custom WAF rules passed to tf-module-wafv2 (name, priority, action, statement map).
    For rate limiting, use statement.rate_based_statement — there is no separate rate_limit_rules input.
  EOT
  type        = any
  default     = []
}


#########################################################################
##                   ECR Variables                                     ##
#########################################################################

variable "provision_ecr" {
  type    = bool
  default = false
}

variable "resources_tags" {
  description = "A map of tags to add to all resources"
  type        = map(string)
  default     = {}
}

variable "ecr_repository_type" {
  description = "The type of repository to create. Either `public` or `private`"
  type        = string
  default     = "private"
}

variable "ecr_names_map" {
  type        = map(string)
  default     = {}
  description = "Map of repositories to create. Example: { r1 = \"myfirstrepo\", r2 = \"mysecondrepo\" }"
}

# Per-repository answers to the canvas's two registry switches, keyed by the SAME logical name as
# `ecr_names_map` — the key the user typed, and the key `repository_urls_map` is keyed by.
#
# It is a map rather than the two scalars below because the canvas offers both switches PER registry
# component and `aws_ecr_repository` accepts both PER repository: `image_tag_mutability` and
# `image_scan_on_push` are repository properties, not registry-wide ones, and ecr.tf already
# for_eaches. An earlier cut of #1811 OR-aggregated the components into the two scalars on the
# grounds that "ECR expresses these registry-wide", which is not true of ECR — it was true only of
# this template's own variable shape. The cost was silent: two registries with different answers
# both got the safer one, so a user asking for MUTABLE was overruled without being told.
#
# An entry is OPTIONAL. A key absent from this map falls back to the two scalars below, which keep
# the template's own defaults — so a project that emits nothing here plans exactly what it planned
# before, and a live registry is never rewritten by a snapshot that simply predates the switch.
variable "ecr_repo_settings" {
  type = map(object({
    immutable_tags         = optional(bool, true)
    vulnerability_scanning = optional(bool, true)
  }))
  default     = {}
  description = "Per-repository registry switches, keyed like ecr_names_map. Omitted repositories use ecr_repository_image_tag_mutability / ecr_repository_image_scan_on_push."
}

# The project-wide DEFAULT for tag mutability — the answer for any repository `ecr_repo_settings`
# does not name. It stays IMMUTABLE: it is what every repository built so far already has, and it is
# the safer position, so a snapshot that omits the key must not quietly downgrade a live registry.
variable "ecr_repository_image_tag_mutability" {
  description = "The tag mutability setting for the repository. Must be one of: `MUTABLE` or `IMMUTABLE`. Defaults to `IMMUTABLE`"
  type        = string
  default     = "IMMUTABLE"

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.ecr_repository_image_tag_mutability)
    error_message = "ecr_repository_image_tag_mutability must be MUTABLE or IMMUTABLE."
  }
}

variable "ecr_repository_encryption_type" {
  description = "The encryption type for the repository. Must be one of: `KMS` or `AES256`. Defaults to `AES256`"
  type        = string
  default     = "AES256"
}

# The project-wide DEFAULT for scan-on-push, read the same way. This is ECR BASIC scanning, a
# per-repository setting. It is deliberately NOT wired to
# `aws_ecr_registry_scanning_configuration` (enhanced/Inspector scanning), which is account- AND
# region-wide and, per its own provider docs, "can't be completely deleted" — a per-project switch
# must not reach that far.
variable "ecr_repository_image_scan_on_push" {
  description = "Indicates whether images are scanned after being pushed to the repository (`true`) or not scanned (`false`)"
  type        = bool
  default     = true
}

variable "ecr_repository_read_access_arns" {
  description = "The ARNs of the IAM users/roles that have read access to the repository"
  type        = list(string)
  default     = []
}

variable "ecr_repository_read_write_access_arns" {
  description = "The ARNs of the IAM users/roles that have read/write access to the repository"
  type        = list(string)
  default     = []
}

variable "ecr_manage_registry_scanning_configuration" {
  description = "Determines whether the registry scanning configuration will be managed"
  type        = bool
  default     = false
}

variable "ecr_registry_scan_type" {
  description = "the scanning type to set for the registry. Can be either `ENHANCED` or `BASIC`"
  type        = string
  default     = "BASIC"
}

variable "ecr_registry_scan_rules" {
  description = "One or multiple blocks specifying scanning rules to determine which repository filters are used and at what frequency scanning will occur"
  type        = any
  default     = []
}

variable "ecr_create_lifecycle_policy" {
  description = "Determines whether a lifecycle policy will be created"
  type        = bool
  default     = true
}

# The DOCUMENT that goes with the flag above. It defaults on, so leaving this unset used to fail
# every native-ECR apply outright (InvalidParameterException on an empty lifecyclePolicyText) —
# not just in e2e: any tenant with provision_ecr + registry_provider == "native" hit it on their
# first apply. Null keeps the module's default (expire untagged after 14d, keep the last 30
# tagged) rather than meaning "no policy": an unbounded registry is a real, recurring storage bill.
variable "ecr_repository_lifecycle_policy" {
  description = "ECR lifecycle policy document (JSON). Null ⇒ the template default: expire untagged after 14 days, keep the last 30 tagged images."
  type        = string
  default     = null
}

#########################################################################
##                   Elasticache Redis cluster                         ##
#########################################################################
variable "create_elasticache_redis" {
  type        = bool
  description = "If a new Elasticache Redis instance needs to be created"
}

variable "redis_cluster_size" {
  type        = number
  description = "Number of nodes in cluster. Ignored when redis_cluster_mode_enabled == true"
}

# WIRED BY #4320, and the wire CHANGES A DEPLOYED CACHE. This was declared here, required, emitted
# by the console as `false` (packages/core/cloud/aws_provider.go), and threaded into
# modules/redis by nothing — so the module's own default, `true`, decided it. Every ElastiCache
# this template has ever built is running with cluster mode ON against a caller that asked for OFF.
#
# Honouring the caller is the fix, and on an EXISTING replication group the flip from a sharded
# cluster to a single node group is a TOPOLOGY change, not an in-place update. `redis_cluster_size`
# is ignored while this is true, which is the other half of the same lie.
variable "redis_cluster_mode_enabled" {
  type        = bool
  description = "Flag to enable/disable cluster mode. Threaded into modules/redis (#4320) — the module used to default it to true regardless, so turning it off is a topology change on an existing cache."
}

variable "redis_instance_type" {
  type        = string
  description = "Elastic cache instance type"
}

variable "redis_engine_version" {
  type        = string
  description = "Redis engine version"
}

variable "redis_family" {
  type        = string
  description = "Redis family"
}

variable "redis_allowed_cidr_blocks" {
  type        = list(any)
  description = "List of CIDRs allowed on Redis security group rules"
}

variable "redis_allowed_security_group_ids" {
  type        = list(string)
  description = <<-EOT
    A list of IDs of Security Groups to allow access to the security group created by this module on Redis port.
  EOT
}

variable "redis_multi_az_enabled" {
  type        = bool
  description = "Flag to enable/disable Multiple AZs"
  default     = true
}

## Elasticache Redis - Logging variables

# WIRED BY #4320, and the wire CHANGES A DEPLOYED CACHE — the same shape as
# `redis_cluster_mode_enabled` above. Declared here, required, emitted by the console as `false`
# (packages/core/cloud/aws_provider.go), threaded nowhere, so modules/redis' default of `true` won:
# every cache this template has built is streaming slow-log and engine-log to CloudWatch against a
# caller that asked for none.
#
# The consequence of honouring `false` is stated rather than softened: modules/redis creates
# `aws_cloudwatch_log_group.redis` under `count = var.cloudwatch_logs_enabled ? 1 : 0`, so the first
# apply after this wire DESTROYS that log group and the retained log events with it. The module
# falls back to the firehose delivery configuration, which is itself off by default, so the cache
# ends up delivering no logs at all — which is what `false` means.
variable "redis_cloudwatch_logs_enabled" {
  type        = bool
  description = "Indicates whether you want to enable or disable streaming broker logs to Cloudwatch Logs. Threaded into modules/redis (#4320) — the module used to default it to true regardless, so setting it false now destroys the cache's CloudWatch log group."
}

variable "redis_automatic_failover_enabled" {
  type        = bool
  description = "Automatic failover (Not available for T1/T2 instances)"
  default     = true
}

# Declared at the ROOT because NAMING-004 composes the default user's id from it
# ("restricted-<environment>-<aws_elasticache_user_name>-user") and that name has to be derived
# where `tofu test` can reach it. The default matches modules/redis/variables.tf so no existing
# deploy changes; it is now passed explicitly rather than left to the module's own default, so the
# value the name is built from and the value the resource uses cannot drift apart.
variable "aws_elasticache_user_name" {
  type        = string
  description = "Username for the ElastiCache default user. Change this only if the default user already exists by other means. Feeds the NAMING-004 derivation of the default user's id."
  default     = "default"
}

#########################################################################
##                   Elasticache Valkey                                ##
#########################################################################

variable "create_elasticache_valkey" {
  type    = bool
  default = false
}

variable "valkey_snapshot_time" {
  type    = string
  default = "05:00"
}

variable "valkey_engine_version" {
  type    = string
  default = "7"
}

variable "valkey_data_storage_max" {
  type    = number
  default = 2
}

variable "valkey_ecpu_per_second_max" {
  type    = number
  default = 1000
}

variable "valkey_create_valkey_user_and_secret" {
  type    = bool
  default = true
}

#########################################################################
##             AWS Certificate manager valid certificate               ##
#########################################################################
variable "acm_certificate_enable" {
  type        = bool
  description = "Generate a validated acm cert"
  default     = false
}
variable "dns_hosted_zone" {
  type        = string
  description = "Managed R53 Zone ID"
  default     = "Z2INQZ6AA9H9SI"
}
variable "dns_main_domain" {
  type        = string
  description = "Domain Managed under the R53 Zone"
  default     = "example.com"
}

variable "cloud_dns_enabled" {
  type        = bool
  default     = false
  description = "Create and manage the Route 53 hosted zone in-template (parity with GCP/Azure, which create their managed zone). When false, an existing zone id (dns_hosted_zone) is used."
}

variable "cloud_dns_zone_name" {
  type        = string
  default     = ""
  description = "Optional Name-tag label for the created Route 53 hosted zone; defaults to the domain."
}

################################################################################
# Karpenter
################################################################################


variable "enable_karpenter" {
  type    = bool
  default = false
}

variable "ec2_spot_service_role" {
  type        = bool
  default     = false
  description = "Configure EC2 spot service role provisioning."
}

# ── The Karpenter NodePool (#5527) ───────────────────────────────────────────────────────────────
#
# None of these builds an AWS resource. Karpenter's NodePool is a Kubernetes object the RUNNER applies
# after the cluster is up (packages/core/provisioner/karpenter.go), so they are gathered into
# `local.karpenter_nodepool` (karpenter.tf) and handed to it through the `karpenter_nodepool` output.
#
# Every default is the literal the runner hard-coded before these existed, so a cluster that sets
# nothing renders a byte-identical NodePool. The runner re-checks every value before it applies the
# manifest with cluster-admin rights, because a validation that lives only here is bypassed by a
# hand-edited state or output.

variable "karpenter_capacity_types" {
  type        = list(string)
  default     = ["on-demand"]
  description = "Karpenter capacity types: any of \"spot\" and \"on-demand\". With both, Karpenter prefers Spot and falls back to on-demand."

  validation {
    condition     = length(var.karpenter_capacity_types) > 0 && length(distinct(var.karpenter_capacity_types)) == length(var.karpenter_capacity_types) && alltrue([for c in var.karpenter_capacity_types : contains(["spot", "on-demand"], c)])
    error_message = "karpenter_capacity_types must list \"spot\", \"on-demand\" or both, each at most once."
  }
}

variable "karpenter_architectures" {
  type        = list(string)
  default     = ["amd64"]
  description = "CPU architectures the default Karpenter NodePool may launch. Only \"amd64\" is accepted: arm64 runs on the separate, tainted NodePool karpenter_arm64_nodepool creates (#5534)."

  validation {
    condition     = length(var.karpenter_architectures) > 0 && length(distinct(var.karpenter_architectures)) == length(var.karpenter_architectures) && alltrue([for a in var.karpenter_architectures : a == "amd64"])
    error_message = "karpenter_architectures must be [\"amd64\"]. arm64 is not offered on the default Karpenter NodePool: the managed node group is x86_64 and most images Alethia builds are amd64-only, so an arm64 node in the only pool would crash them with exec format error. arm64 needs a separate, tainted NodePool: set karpenter_arm64_nodepool instead."
  }
}

variable "karpenter_instance_categories" {
  type        = list(string)
  default     = ["t", "m"]
  description = "EC2 instance categories Karpenter may launch (the letters before the generation: \"c\", \"m\", \"r\", \"t\", ...). An empty list puts no category requirement on the NodePool."

  validation {
    condition     = length(distinct(var.karpenter_instance_categories)) == length(var.karpenter_instance_categories) && alltrue([for c in var.karpenter_instance_categories : can(regex("^[a-z]{1,8}$", c))])
    error_message = "karpenter_instance_categories entries must be lowercase EC2 instance categories such as \"c\", \"m\" or \"r\" (1-8 letters), each at most once."
  }
}

variable "karpenter_instance_families" {
  type        = list(string)
  default     = []
  description = "EC2 instance families Karpenter may launch, for example [\"c7g\", \"m7g\"]. Empty (the default) puts no family requirement on the NodePool. Each family must belong to one of karpenter_instance_categories, unless that list is empty."

  validation {
    condition     = length(distinct(var.karpenter_instance_families)) == length(var.karpenter_instance_families) && alltrue([for f in var.karpenter_instance_families : can(regex("^[a-z][a-z0-9-]{0,15}$", f))])
    error_message = "karpenter_instance_families entries must be EC2 instance families such as \"c7g\" or \"m7i-flex\" (lowercase letters, digits and hyphens, starting with a letter), each at most once."
  }
}

variable "karpenter_cpu_limit" {
  type        = number
  default     = 100
  description = "The most vCPU the Karpenter NodePool may launch in total, from 1 to 1000. It is the only bound on the size of Karpenter's fleet: Karpenter launches EC2 outside OpenTofu, so plan-time cost guards do not see it."

  validation {
    condition     = var.karpenter_cpu_limit >= 1 && var.karpenter_cpu_limit <= 1000 && floor(var.karpenter_cpu_limit) == var.karpenter_cpu_limit
    error_message = "karpenter_cpu_limit must be a whole number of vCPU from 1 to 1000."
  }
}

variable "karpenter_node_labels" {
  type        = map(string)
  default     = {}
  description = "Labels on every node Karpenter launches. Keys whose prefix ends in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io are refused, except node-restriction.kubernetes.io/."

  validation {
    condition = alltrue([for k, v in var.karpenter_node_labels :
      length(split("/", k)[0]) <= 253 && alltrue([for l in split(".", split("/", k)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ])
    error_message = "karpenter_node_labels keys must be Kubernetes label keys ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and values must be up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for k, v in var.karpenter_node_labels :
      !strcontains(k, "/") || can(regex("(^|\\.)node-restriction\\.kubernetes\\.io$", split("/", k)[0])) || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ])
    error_message = "karpenter_node_labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io (node-restriction.kubernetes.io/ is allowed). Kubernetes, Karpenter, the clouds and Alethia own those labels; the list is packages/core/nodekeys."
  }
}

variable "karpenter_node_taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default     = []
  description = "Taints on every node Karpenter launches, so only pods that tolerate them schedule there. effect is one of NoSchedule, PreferNoSchedule and NoExecute."

  validation {
    condition     = alltrue([for t in var.karpenter_node_taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in var.karpenter_node_taints : "${t.key}:${t.effect}"])) == length(var.karpenter_node_taints)
    error_message = "karpenter_node_taints effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once."
  }

  validation {
    condition = alltrue([for t in var.karpenter_node_taints :
      length(split("/", t.key)[0]) <= 253 && alltrue([for l in split(".", split("/", t.key)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ])
    error_message = "karpenter_node_taints key must be a Kubernetes key ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and value, when set, up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for t in var.karpenter_node_taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ])
    error_message = "karpenter_node_taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, Karpenter, the clouds and Alethia set those taints themselves (alethia.io/arch marks arm64 capacity); the list is packages/core/nodekeys."
  }
}

# The arm64 (Graviton) Karpenter NodePool (#5534), beside `default`. Null (the default) renders no
# such pool. The runner renders it with kubernetes.io/arch In ["arm64"] and ALWAYS adds the taint
# alethia.io/arch=arm64:NoSchedule itself, after it has validated the user's values: the images
# Alethia builds (kaniko) and the Deployments it generates are single-arch and pin no arch, so arm64
# capacity must never take a pod that did not ask for it. A workload opts in with a toleration for
# that taint and a kubernetes.io/arch=arm64 nodeSelector, and needs a multi-arch (or arm64) image.
# The pool shares the default pool's capacity types, instance categories, labels and taints; it has
# its own instance families and its own CPU limit.
variable "karpenter_arm64_nodepool" {
  type = object({
    instance_families = optional(list(string), [])
    cpu_limit         = optional(number, 100)
  })
  default     = null
  description = "An arm64 (Graviton) Karpenter NodePool beside the default one, or null for none. Its nodes carry the taint alethia.io/arch=arm64:NoSchedule, so only pods that tolerate it run there. instance_families (empty: any Graviton family in karpenter_instance_categories) and cpu_limit (1 to 1000 vCPU) are its own; capacity types, categories, labels and taints are the default pool's."

  validation {
    condition = var.karpenter_arm64_nodepool == null ? true : (
      length(distinct(var.karpenter_arm64_nodepool.instance_families)) == length(var.karpenter_arm64_nodepool.instance_families) &&
      alltrue([for f in var.karpenter_arm64_nodepool.instance_families : can(regex("^[a-z][a-z0-9-]{0,15}$", f)) && can(regex("^(a1([.]|$)|[a-z]+[0-9]+g)", f))])
    )
    error_message = "karpenter_arm64_nodepool.instance_families entries must be Graviton EC2 instance families such as \"m7g\", \"c7gn\" or \"t4g\" (a \"g\" right after the generation digit), each at most once."
  }

  validation {
    condition     = var.karpenter_arm64_nodepool == null ? true : !contains(var.karpenter_arm64_nodepool.instance_families, "a1")
    error_message = "karpenter_arm64_nodepool.instance_families may not list \"a1\": both Karpenter NodePools require instance generation 3 or later (karpenter.k8s.aws/instance-generation Gt 2), so a1 (Graviton 1) could never launch. An extra_node_pools entry can use an a1 instance type."
  }

  validation {
    condition     = var.karpenter_arm64_nodepool == null ? true : var.karpenter_arm64_nodepool.cpu_limit >= 1 && var.karpenter_arm64_nodepool.cpu_limit <= 1000 && floor(var.karpenter_arm64_nodepool.cpu_limit) == var.karpenter_arm64_nodepool.cpu_limit
    error_message = "karpenter_arm64_nodepool.cpu_limit must be a whole number of vCPU from 1 to 1000."
  }
}

################################################################################
# Custom Secrets Variables - Alethia tf-module-awssm-passgen
################################################################################


variable "custom_secrets" {
  description = "List of custom secrets to create"
  type = list(object({
    secret_name      = string
    length           = optional(number)
    special          = optional(bool)
    override_special = optional(string)
    keepers          = optional(map(string))
    manual           = optional(bool, false)
    value            = optional(string)
  }))
}

variable "custom_secret_keepers" {
  description = "Map of keepers for the secrets"
  type        = map(map(string))
  default     = {}
}
#########################################################################
##           DynamoDB - Table Configuration Variables                  ##
#########################################################################

variable "ddb_create" {
  type        = bool
  description = "If a DynomoDB table needs to be created"
  default     = false

}

variable "ddb_global_create" {
  type        = bool
  description = "If a DynomoDB global table needs to be created"
  default     = false

}

variable "ddb_table_configuration" {
  type = list(object({
    table_name_suffix = string
    hash_key          = string
    range_key         = string
    hash_key_type     = string
    range_key_type    = string
    enable_autoscaler = optional(bool, false)
    dynamodb_attributes = optional(list(object({
      name = string
      type = string
    })), [])
    global_secondary_index_map = optional(list(object({
      hash_key           = string
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
      read_capacity      = optional(number, 0)
      write_capacity     = optional(number, 0)
    })), [])
    local_secondary_index_map = optional(list(object({
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
    })), [])
    replicas                      = optional(list(string), [])
    tags_enabled                  = optional(bool, true)
    billing_mode                  = optional(string, "PAY_PER_REQUEST")
    enable_point_in_time_recovery = optional(bool, false)
    ttl_enabled                   = optional(bool, false)
    ttl_attribute                 = optional(string, "")

    # DEFAULT OFF, AND THE DEFAULT IS THE WHOLE POINT.
    #
    # This defaulted to `true`, and `buildDDBTables` (packages/core/cloud/aws_provider.go) has never
    # emitted the key — so the root default was materialised into every table object of every AWS
    # project and handed to modules/dynamodb, which passes it straight to the table. An
    # aws_dynamodb_table with deletion protection on REFUSES DeleteTable, so `tofu destroy` errored
    # on the table and never reached the rest of the graph: RDS and ElastiCache kept their ENIs, and
    # the subnets and VPC behind them could not be deleted either. Any customer who added a nosql
    # table could not destroy their own environment.
    #
    # `false` is not a new posture — it is the one modules/dynamodb/variables.tf already declares for
    # the same field. The root was the outlier, and it was overriding the module toward the setting
    # that traps the user.
    #
    # Nothing in the canvas collects a deletion-protection value (no column, no config-schema field,
    # no zod entry — checked across apps/console and packages/core), so there is no user intent to
    # carry here. When there is no control, the default has to be the one that cannot lock someone
    # out of their own account; a customer can always re-enable protection on the table, but a
    # customer wedged behind it has no console path out at all. `provider_config` passthrough
    # (mergeProviderConfig) makes this field settable per table today for anyone who wants it on.
    deletion_protection_enabled = optional(bool, false)
  }))
  description = "List of objects to pass to the module for the creation of the table."
}

variable "ddb_global_table_configuration" {
  type = list(object({
    table_type        = optional(string, "regional")
    table_name_suffix = string
    hash_key          = string
    range_key         = string
    hash_key_type     = string
    range_key_type    = string
    enable_autoscaler = optional(bool, false)
    dynamodb_attributes = optional(list(object({
      name = string
      type = string
    })), [])
    global_secondary_index_map = optional(list(object({
      hash_key           = string
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
      read_capacity      = optional(number, 0)
      write_capacity     = optional(number, 0)
    })), [])
    local_secondary_index_map = optional(list(object({
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = optional(list(string), [])
    })), [])
    replicas                      = optional(list(string), [])
    tags_enabled                  = optional(bool, true)
    billing_mode                  = optional(string, "PAY_PER_REQUEST")
    enable_point_in_time_recovery = optional(bool, false)
    ttl_enabled                   = optional(bool, false)
    ttl_attribute                 = optional(string, "")

    # Same default, same reason as ddb_table_configuration above — and it matters MORE here. A
    # global table's replicas are torn down through the same DeleteTable call, so protection left on
    # wedges the destroy in every replica region at once, not just the primary.
    deletion_protection_enabled = optional(bool, false)
  }))
  description = "List of objects to pass to the module for the creation of the global table."
}
#########################################################################
##           S3 - Bucket Configuration Variables                       ##
#########################################################################

variable "s3_create" {
  type        = bool
  description = "Creation of a S3 bucket"
  default     = false

}


variable "bucket_configuration" {
  type = list(object({
    bucket_name_suffix      = string
    acl_type                = string
    create_s3_user          = bool
    versioning_enabled      = bool
    sse_algorithm           = string
    store_access_key_in_ssm = bool
    logging_bucket_name     = optional(string)
    block_public_acls       = optional(bool)
    block_public_policy     = optional(bool)
    ignore_public_acls      = optional(bool)
    restrict_public_buckets = optional(bool)
    cors_configuration = list(object({
      allowed_headers = list(string)
      allowed_methods = list(string)
      allowed_origins = list(string)
      expose_headers  = list(string)
      max_age_seconds = number
    }))
    privileged_principal_arns    = optional(list(map(list(string))))
    privileged_principal_actions = optional(list(string))
  }))
  description = "Values needed for the creation of a new S3 bucket. For the value of the argument 'bucket_name_prefix' it should be a value that has the service name and the purpose of that bucket."
  default = [{
    bucket_name_suffix      = "bkt"
    acl_type                = "log-delivery-write"
    create_s3_user          = false
    versioning_enabled      = true
    sse_algorithm           = "AES256"
    store_access_key_in_ssm = true
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
    cors_configuration      = []
  }]
}

variable "custom_iac_vars" {
  type        = any
  default     = {}
  description = "Object of custom values that can be used for extra terraform files outside of the template"
}
