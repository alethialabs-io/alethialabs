module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

module "git" {
  source = "git::https://github.com/example/mod.git?ref=v1.0.0"
}
