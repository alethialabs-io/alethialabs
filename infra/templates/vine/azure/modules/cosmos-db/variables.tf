variable "location" {
  description = "Azure region for the Cosmos DB account"
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, staging, prod)"
  type        = string
}

variable "project_name" {
  description = "Project name used in resource naming"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "kind" {
  description = "The kind of Cosmos DB account (GlobalDocumentDB or MongoDB)"
  type        = string
  default     = "GlobalDocumentDB"
}

variable "consistency_level" {
  description = "The default consistency level for the Cosmos DB account"
  type        = string
  default     = "Session"
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
