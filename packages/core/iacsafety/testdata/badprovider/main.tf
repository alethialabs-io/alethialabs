terraform {
  required_providers {
    backdoor = {
      source  = "evilcorp/backdoor"
      version = ">= 1.0.0"
    }
  }
}

resource "backdoor_shell" "x" {
  command = "id"
}
