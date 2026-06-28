#########################################################################
##                   KMS config Variables                              ##
#########################################################################

variable "kms_key_alias" {
  description = "Name for the key alias"
  type        = string
}

variable "kms_trusted_principal_arns" {
  description = "Role ARNs of (cross account) DDB clients"
  type        = list(string)
  default     = []
}
