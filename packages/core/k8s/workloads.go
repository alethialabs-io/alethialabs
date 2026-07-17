// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"strconv"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// workloadKind maps a rendered manifest Kind to the normalized lowercase chart_workload_kind and
// reports whether it is a workload Alethia DESCRIBES. Pod / ReplicaSet / ReplicationController are
// intentionally excluded — they are controller-owned, not the first-class workloads a chart declares.
func workloadKind(kind string) (string, bool) {
	switch kind {
	case "Deployment":
		return "deployment", true
	case "StatefulSet":
		return "statefulset", true
	case "DaemonSet":
		return "daemonset", true
	case "CronJob":
		return "cronjob", true
	case "Job":
		return "job", true
	}
	return "", false
}

// Workloads extracts one ChartWorkload per described workload resource in the decoded stream, in
// document order. Non-workload resources (Services, ConfigMaps, RBAC, …) are skipped, as is any
// workload whose pod template can't be located (rather than emitting an empty description). The
// returned slice is never nil.
func Workloads(resources []Resource) []types.ChartWorkload {
	out := make([]types.ChartWorkload, 0, len(resources))
	for _, r := range resources {
		kind, ok := workloadKind(r.Kind)
		if !ok {
			continue
		}
		ps, ok := podSpec(r)
		if !ok {
			continue
		}
		// The primary (non-init) containers describe the workload's image/ports/env/resources.
		mains := containers(ps, "containers")
		out = append(out, types.ChartWorkload{
			Name:         r.Name,
			WorkloadKind: types.ChartWorkloadKind(kind),
			Rendered: types.ChartWorkloadRendered{
				Image:     firstImage(mains),
				Ports:     ports(mains),
				EnvKeys:   envKeys(mains),
				Resources: firstResources(mains),
				Replicas:  replicas(r, kind),
			},
		})
	}
	return out
}

// podSpec returns the PodSpec of a described workload. A CronJob nests its pod template one level
// deeper (spec.jobTemplate.spec.template.spec); every other kind is spec.template.spec.
func podSpec(r Resource) (map[string]any, bool) {
	spec, ok := r.Raw["spec"].(map[string]any)
	if !ok {
		return nil, false
	}
	if r.Kind == "CronJob" {
		jt, ok := spec["jobTemplate"].(map[string]any)
		if !ok {
			return nil, false
		}
		if spec, ok = jt["spec"].(map[string]any); !ok {
			return nil, false
		}
	}
	tmpl, ok := spec["template"].(map[string]any)
	if !ok {
		return nil, false
	}
	ps, ok := tmpl["spec"].(map[string]any)
	return ps, ok
}

// containers returns the named container list ("containers" | "initContainers") of a pod spec.
func containers(ps map[string]any, key string) []map[string]any {
	var out []map[string]any
	if list, ok := ps[key].([]any); ok {
		for _, c := range list {
			if cm, ok := c.(map[string]any); ok {
				out = append(out, cm)
			}
		}
	}
	return out
}

// firstImage returns the first container's image — the workload's primary image.
func firstImage(cs []map[string]any) string {
	if len(cs) == 0 {
		return ""
	}
	return asString(cs[0]["image"])
}

// ports returns the union of the containers' declared container ports, in order. Never nil (so the
// wire serializes `[]`, which the console zod array accepts, rather than `null`).
func ports(cs []map[string]any) []types.ServicePort {
	out := make([]types.ServicePort, 0)
	for _, c := range cs {
		list, ok := c["ports"].([]any)
		if !ok {
			continue
		}
		for _, p := range list {
			pm, ok := p.(map[string]any)
			if !ok {
				continue
			}
			cp := asInt(pm["containerPort"])
			if cp <= 0 {
				continue
			}
			out = append(out, types.ServicePort{
				Name:          asString(pm["name"]),
				ContainerPort: cp,
				Protocol:      asString(pm["protocol"]),
			})
		}
	}
	return out
}

// envKeys returns the de-duplicated env-variable NAMES across the containers, in order — never the
// values or valueFrom refs, so a description can't persist a rendered secret. Never nil.
func envKeys(cs []map[string]any) []string {
	seen := map[string]bool{}
	out := make([]string, 0)
	for _, c := range cs {
		list, ok := c["env"].([]any)
		if !ok {
			continue
		}
		for _, e := range list {
			em, ok := e.(map[string]any)
			if !ok {
				continue
			}
			name := asString(em["name"])
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// firstResources returns the requests/limits of the first container that declares either — the
// pragmatic "primary container" resource description. nil when no container sets resources.
func firstResources(cs []map[string]any) *types.ServiceResources {
	for _, c := range cs {
		res, ok := c["resources"].(map[string]any)
		if !ok {
			continue
		}
		reqs, _ := res["requests"].(map[string]any)
		lims, _ := res["limits"].(map[string]any)
		if reqs == nil && lims == nil {
			continue
		}
		return &types.ServiceResources{
			Requests: types.ServiceResourceQuantities{
				CPU:    asScalar(reqs["cpu"]),
				Memory: asScalar(reqs["memory"]),
			},
			Limits: types.ServiceResourceQuantities{
				CPU:    asScalar(lims["cpu"]),
				Memory: asScalar(lims["memory"]),
			},
		}
	}
	return nil
}

// replicas returns the rendered replica count for a Deployment/StatefulSet; nil for
// DaemonSet/Job/CronJob (no replica count) or when the manifest omits it.
func replicas(r Resource, kind string) *int {
	if kind != "deployment" && kind != "statefulset" {
		return nil
	}
	spec, ok := r.Raw["spec"].(map[string]any)
	if !ok {
		return nil
	}
	v, ok := spec["replicas"]
	if !ok {
		return nil
	}
	n := asInt(v)
	if n < 0 {
		return nil
	}
	return &n
}

// asInt coerces a decoded YAML numeric scalar to an int (-1 when absent/non-numeric).
func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return -1
}

// asScalar coerces a decoded YAML scalar (string or number) to a string — k8s quantities render as
// strings ("100m", "128Mi") but a bare `cpu: 1` decodes to a number, which we stringify.
func asScalar(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return ""
}
