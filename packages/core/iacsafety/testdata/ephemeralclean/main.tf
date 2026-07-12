terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

ephemeral "random_password" "db" {
  length = 32
}
