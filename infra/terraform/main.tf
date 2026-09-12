terraform {
  required_version = ">= 1.5.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30.0"
    }
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = var.kube_context
}

resource "kubernetes_namespace" "app_ns" {
  metadata {
    name = var.app_name
    labels = {
      app        = var.app_name
      managed-by = "aegis"
    }
  }
}

resource "kubernetes_deployment" "app_deployment" {
  metadata {
    name      = var.app_name
    namespace = kubernetes_namespace.app_ns.metadata[0].name
    labels = {
      app        = var.app_name
      managed-by = "aegis"
    }
  }

  wait_for_rollout = false

  spec {
    replicas = var.replicas

    selector {
      match_labels = {
        app = var.app_name
      }
    }

    template {
      metadata {
        labels = {
          app = var.app_name
        }
      }

      spec {
        container {
          name  = var.app_name
          image = var.image

          resources {
            limits = {
              cpu    = "${var.cpu}"
              memory = "${var.memory}Mi"
            }
            requests = {
              cpu    = "${var.cpu / 2}"
              memory = "${var.memory / 2}Mi"
            }
          }

          port {
            container_port = 80
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "app_service" {
  metadata {
    name      = var.app_name
    namespace = kubernetes_namespace.app_ns.metadata[0].name
    labels = {
      app        = var.app_name
      managed-by = "aegis"
    }
  }

  spec {
    selector = {
      app = var.app_name
    }

    port {
      port        = 80
      target_port = 80
    }

    type = "ClusterIP"
  }
}
