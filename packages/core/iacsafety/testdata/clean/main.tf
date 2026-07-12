terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

resource "aws_instance" "web" {
  ami           = "ami-123456"
  instance_type = "t3.micro"

  tags = {
    Name = "web"
  }
}

resource "terraform_data" "marker" {
  input = var.region
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

output "instance_id" {
  value = aws_instance.web.id
}
