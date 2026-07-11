data "terraform_remote_state" "net" {
  backend = "s3"
  config = {
    bucket = "someone-elses-bucket"
    key    = "network/terraform.tfstate"
    region = "eu-central-1"
  }
}
