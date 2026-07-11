terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

resource "aws_instance" "web" {
  ami = "ami-123456"
}
