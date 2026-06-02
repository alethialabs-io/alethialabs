variable "global_tags" {
  default = {}
}

variable "sqs_username" {
  default     = ""
  description = "Iam User for SQS and SNS resources created by this module. If left empty no user will be created"
}

variable "sqs_iam_role_name" {
  default     = ""
  description = "Iam Role for SQS and SNS resources created by this module. If left empty no user will be created"
}

variable "sqs_queues" {
  default     = {}
  description = "Complex dict of sqs queue definitions. Refer to the Readme for more info"
}

variable "sns_topics" {
  default     = {}
  description = "Complex dict of sns topic definitions. Refer to the Readme for more info"
}

variable "environment" {
  type = string
  description = "Environment"
}
