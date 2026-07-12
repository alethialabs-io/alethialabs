terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

module "child" {
  source = "./modules/child"
}
