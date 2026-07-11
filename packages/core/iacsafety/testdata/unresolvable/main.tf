variable "src" {
  type = string
}

terraform {
  required_providers {
    aws = {
      source = var.src
    }
    num  = 5
    nada = null
    obj = {
      source = null
    }
  }
}

module "dyn" {
  source = var.src
}

module "nosrc" {
}
