terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

resource "aws_db_instance" "main" {
  identifier = "app"
}

module "child" {
  source = "./modules/child"
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "db_secret_name" {
  value = "app/db/master"
}
