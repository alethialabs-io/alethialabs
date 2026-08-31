variable "runner_id" {
  type        = string
  description = "Pre-registered runner UUID"
}

variable "runner_token" {
  type        = string
  sensitive   = true
  description = "Runner authentication token"
}

variable "runner_name" {
  type        = string
  description = "Human-readable runner name"
}

variable "alethia_url" {
  type        = string
  description = "Alethia API base URL"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "runner Docker image tag"
}

variable "region" {
  type        = string
  description = "AWS region for deployment"
}

variable "cpu" {
  type        = number
  default     = 512
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)"
}

variable "memory" {
  type        = number
  default     = 1024
  description = "Fargate task memory in MB"
}

# This template runs in the CUSTOMER's AWS account, so the default has to be an image that
# account can actually pull. The previous default was a PRIVATE ECR repository —
# `787587782604.dkr.ecr.eu-west-1.amazonaws.com/runner-dev-runner`, an account id this repository
# names nowhere else, under a repository name retired by the 53abe279 rename (2026-06-20). Two
# things were wrong with it and only one was staleness: no customer's task execution role can pull
# a private repository in someone else's account at all, so the ECS service would have sat in
# CannotPullContainerError no matter which of our account ids the string carried.
#
# GHCR is the right answer and is already the answer everywhere else that names this image:
# apps/console/app/server/actions/runners.ts (the ONLY caller — it passes
# `deployConfig.image_repository ?? "ghcr.io/alethialabs-io/runner"`, so this default is the
# value a hand-run of the template gets), infra/connector/aws/runner.yaml:163 and
# deploy/prod/docker-compose.prod.yml. It is public, so it needs no cross-account grant.
#
# The private mirror in our own account (alethia-runner-dev-runner, #3438) is for the MANAGED
# Fargate fleet, which runs in our account and pulls through its own execution role. It is not
# reachable from here and must never be this default.
variable "image_repository" {
  type        = string
  default     = "ghcr.io/alethialabs-io/runner"
  description = "Container image repository the runner task pulls. Public GHCR by default — this template applies in the customer's own account, which cannot pull a private repository in ours."
}

variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "Subnet IDs for the Fargate task. If empty, uses default VPC subnets."
}

variable "assign_public_ip" {
  type        = bool
  default     = true
  description = "Assign public IP to the Fargate task (required if no NAT gateway)"
}
