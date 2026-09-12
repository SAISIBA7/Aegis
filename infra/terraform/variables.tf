variable "kube_context" {
  description = "The kubeconfig context to use"
  type        = string
  default     = "kind-aegis"
}

variable "app_name" {
  description = "Name of the application and target namespace"
  type        = string
}

variable "image" {
  description = "Container image to deploy"
  type        = string
}

variable "cpu" {
  description = "CPU limit in cores"
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory limit in MiB"
  type        = number
  default     = 256
}

variable "replicas" {
  description = "Number of desired pod replicas"
  type        = number
  default     = 1
}
