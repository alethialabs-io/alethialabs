variable "project_name" {
  type        = string
  description = "Name of the project"
}

variable "environment" {
  type        = string
  description = "Environment (e.g. dev, staging, prod)"
}

variable "region" {
  type        = string
  description = "AWS region to deploy to"
}

variable "vpc_cidr" {
  type        = string
  default     = ""
  description = "CIDR block for the VPC"
}

variable "vpc_id" {
  type        = string
  default     = ""
  description = "Existing VPC ID. If empty, a new VPC is created."
}

variable "cluster_version" {
  type        = string
  default     = "1.32"
  description = "Kubernetes cluster version for EKS"
}

variable "instance_types" {
  type        = list(string)
  default     = ["t4g.medium"]
  description = "EC2 instance types for the EKS managed node group"
}
