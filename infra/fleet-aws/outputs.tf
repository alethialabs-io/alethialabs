output "ecr_repository_url" {
  value = aws_ecr_repository.runner.repository_url
}

output "runners" {
  description = "Per-runner cluster and service names"
  value = {
    for name, w in local.all_runner_modules : name => {
      region       = var.runners[name].region
      alethia_url  = var.runners[name].alethia_url
      cluster_name = w.cluster_name
      service_name = w.service_name
    }
  }
}

output "scaler_lambda" {
  value = module.scaler.lambda_function_name
}
