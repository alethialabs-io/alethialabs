terraform {
  backend "s3" {
    bucket = "user-bucket"
    key    = "state"
  }

  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
