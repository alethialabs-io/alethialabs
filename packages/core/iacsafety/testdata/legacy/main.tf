terraform {
  required_providers {
    aws = "~> 2.7"
  }
}

resource "aws_instance" "web" {
  ami = "ami-123456"
}
