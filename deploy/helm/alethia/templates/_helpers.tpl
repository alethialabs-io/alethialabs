{{/* Chart name, overridable via nameOverride. */}}
{{- define "alethia.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully-qualified release name. */}}
{{- define "alethia.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "alethia.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "alethia.labels" -}}
app.kubernetes.io/name: {{ include "alethia.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Per-component selector labels. Call with (dict "ctx" . "component" "console"). */}}
{{- define "alethia.selectorLabels" -}}
app.kubernetes.io/name: {{ include "alethia.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Secret name (existing or chart-managed). */}}
{{- define "alethia.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "alethia.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* In-cluster Postgres host (service) or the external host. */}}
{{- define "alethia.pgHost" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "%s-postgres" (include "alethia.fullname" .) -}}
{{- else -}}
{{- required "postgres.host is required when postgres.enabled=false" .Values.postgres.host -}}
{{- end -}}
{{- end -}}

{{/* Owner/superuser DATABASE_URL. */}}
{{- define "alethia.databaseUrl" -}}
{{- printf "postgres://%s:%s@%s:%d/%s" .Values.postgres.user .Values.postgres.password (include "alethia.pgHost" .) (int .Values.postgres.port) .Values.postgres.database -}}
{{- end -}}

{{/* Least-privileged app DATABASE_URL (role created by migrate). */}}
{{- define "alethia.appDatabaseUrl" -}}
{{- printf "postgres://alethia_app:%s@%s:%d/%s" .Values.postgres.appPassword (include "alethia.pgHost" .) (int .Values.postgres.port) .Values.postgres.database -}}
{{- end -}}

{{/* Object-store endpoint (in-cluster service or external). */}}
{{- define "alethia.storageEndpoint" -}}
{{- if .Values.objectStore.enabled -}}
{{- printf "http://%s-seaweedfs:8333" (include "alethia.fullname" .) -}}
{{- else -}}
{{- required "objectStore.endpoint is required when objectStore.enabled=false" .Values.objectStore.endpoint -}}
{{- end -}}
{{- end -}}

{{/* Image refs with sensible defaults from {registry}/{name}:{tag}. */}}
{{- define "alethia.image.console" -}}
{{- .Values.console.image | default (printf "%s/console:%s" .Values.image.registry .Values.image.tag) -}}
{{- end -}}
{{- define "alethia.image.migrate" -}}
{{- .Values.console.migrate.image | default (printf "%s/console-migrate:%s" .Values.image.registry .Values.image.tag) -}}
{{- end -}}
{{- define "alethia.image.docs" -}}
{{- .Values.docs.image | default (printf "%s/docs:%s" .Values.image.registry .Values.image.tag) -}}
{{- end -}}
{{- define "alethia.image.runner" -}}
{{- .Values.runner.image | default (printf "%s/runner:%s" .Values.image.registry .Values.image.tag) -}}
{{- end -}}
