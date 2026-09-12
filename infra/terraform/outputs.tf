output "namespace" {
  description = "Created Kubernetes namespace"
  value       = kubernetes_namespace.app_ns.metadata[0].name
}

output "deployment_name" {
  description = "Created Kubernetes deployment name"
  value       = kubernetes_deployment.app_deployment.metadata[0].name
}

output "service_name" {
  description = "Created Kubernetes service name"
  value       = kubernetes_service.app_service.metadata[0].name
}
