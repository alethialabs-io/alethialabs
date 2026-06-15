variable "worker_id" {
  type        = string
  description = "Pre-registered worker UUID"
}

variable "worker_token" {
  type        = string
  sensitive   = true
  description = "Worker authentication token"
}

variable "worker_name" {
  type        = string
  description = "Human-readable worker name"
}

variable "trellis_url" {
  type        = string
  default     = "https://adp.prod.itgix.eu"
  description = "Trellis API base URL"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "grape-worker Docker image tag"
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

variable "image_repository" {
  type        = string
  default     = "787587782604.dkr.ecr.eu-west-1.amazonaws.com/tendril-dev-tendril"
  description = "Container image repository"
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
