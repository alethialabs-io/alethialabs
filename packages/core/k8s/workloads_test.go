// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import "testing"

// render is a representative multi-doc `helm template` stream exercising every described workload
// kind plus non-workload noise (Service/ConfigMap) that must be skipped, a CronJob (deeper pod
// template), a multi-container Deployment (port/env union + first-container resources), and an
// init-container whose env must NOT leak into the description.
const render = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  template:
    spec:
      initContainers:
        - name: migrate
          image: migrate:1
          env:
            - name: INIT_ONLY
              value: "x"
      containers:
        - name: app
          image: ghcr.io/acme/web:1.2.3
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          env:
            - name: LOG_LEVEL
              value: info
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: db
                  key: url
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: "1", memory: 256Mi }
        - name: sidecar
          image: envoy:1
          ports:
            - containerPort: 9090
          env:
            - name: LOG_LEVEL
              value: debug
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
    - port: 80
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: pg
          image: postgres:16
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: agent
spec:
  template:
    spec:
      containers:
        - name: agent
          image: agent:2
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: cron
              image: cron:3
---
apiVersion: batch/v1
kind: Job
metadata:
  name: seed
spec:
  template:
    spec:
      containers:
        - name: seed
          image: seed:4
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  a: b
`

func TestWorkloads_ExtractsEveryKind(t *testing.T) {
	resources, err := Decode([]byte(render))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := Workloads(resources)
	if len(got) != 5 {
		names := make([]string, len(got))
		for i, w := range got {
			names[i] = string(w.WorkloadKind) + "/" + w.Name
		}
		t.Fatalf("expected 5 workloads (Service/ConfigMap skipped), got %d: %v", len(got), names)
	}

	byName := map[string]int{}
	for i, w := range got {
		byName[w.Name] = i
	}

	// web — Deployment, multi-container: image = first container, ports = union, env = de-duped
	// NAMES only (valueFrom kept as a name, init-container env excluded), resources = first
	// container's, replicas = 3.
	web := got[byName["web"]]
	if web.WorkloadKind != "deployment" {
		t.Errorf("web kind = %q, want deployment", web.WorkloadKind)
	}
	if web.Rendered.Image != "ghcr.io/acme/web:1.2.3" {
		t.Errorf("web image = %q", web.Rendered.Image)
	}
	if len(web.Rendered.Ports) != 2 || web.Rendered.Ports[0].ContainerPort != 8080 ||
		web.Rendered.Ports[0].Name != "http" || web.Rendered.Ports[0].Protocol != "TCP" ||
		web.Rendered.Ports[1].ContainerPort != 9090 {
		t.Errorf("web ports drifted: %+v", web.Rendered.Ports)
	}
	if got, want := web.Rendered.EnvKeys, []string{"LOG_LEVEL", "DB_URL"}; !eqStrings(got, want) {
		t.Errorf("web env_keys = %v, want %v (init env excluded, deduped, names only)", got, want)
	}
	if web.Rendered.Resources == nil ||
		web.Rendered.Resources.Requests.CPU != "100m" || web.Rendered.Resources.Requests.Memory != "128Mi" ||
		web.Rendered.Resources.Limits.CPU != "1" || web.Rendered.Resources.Limits.Memory != "256Mi" {
		t.Errorf("web resources drifted: %+v", web.Rendered.Resources)
	}
	if web.Rendered.Replicas == nil || *web.Rendered.Replicas != 3 {
		t.Errorf("web replicas = %v, want 3", web.Rendered.Replicas)
	}

	// db — StatefulSet, replicas from spec.
	db := got[byName["db"]]
	if db.WorkloadKind != "statefulset" || db.Rendered.Image != "postgres:16" ||
		db.Rendered.Replicas == nil || *db.Rendered.Replicas != 1 {
		t.Errorf("db drifted: %+v", db)
	}

	// agent — DaemonSet: no replicas.
	agent := got[byName["agent"]]
	if agent.WorkloadKind != "daemonset" || agent.Rendered.Replicas != nil {
		t.Errorf("agent drifted: kind=%q replicas=%v", agent.WorkloadKind, agent.Rendered.Replicas)
	}

	// nightly — CronJob: pod template is one level deeper.
	nightly := got[byName["nightly"]]
	if nightly.WorkloadKind != "cronjob" || nightly.Rendered.Image != "cron:3" || nightly.Rendered.Replicas != nil {
		t.Errorf("nightly (cronjob) drifted: %+v", nightly)
	}

	// seed — Job.
	seed := got[byName["seed"]]
	if seed.WorkloadKind != "job" || seed.Rendered.Image != "seed:4" {
		t.Errorf("seed (job) drifted: %+v", seed)
	}

	// Empty slices must be non-nil so the JSON wire is [] not null (the console zod rejects null).
	if agent.Rendered.Ports == nil || agent.Rendered.EnvKeys == nil {
		t.Errorf("agent empty ports/env_keys must be non-nil slices: ports=%v env=%v",
			agent.Rendered.Ports, agent.Rendered.EnvKeys)
	}
}

func TestWorkloads_EmptyAndNonWorkloadOnly(t *testing.T) {
	resources, err := Decode([]byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: only\n"))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := Workloads(resources)
	if got == nil || len(got) != 0 {
		t.Fatalf("expected non-nil empty slice, got %#v", got)
	}
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
