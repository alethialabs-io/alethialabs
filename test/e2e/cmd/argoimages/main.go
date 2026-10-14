// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// argoimages prints, one per line, every container image the argo-cd chart renders at the version
// the runner installs, for ci.yml's provision-e2e job to pull before T1 boots kind (#6044).
//
// The list is rendered, not written down: the derivation and the reason are on
// test/e2e/t1_image_preload.go. It exits non-zero when the chart cannot be rendered, renders no
// images, or names an image the kubelet would pull even when the node holds it.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/test/e2e"
)

// main renders the chart and prints its image list.
func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	images, err := e2e.ArgoChartImages(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "::error title=ArgoCD chart image list (#6044)::%v\n", err)
		os.Exit(1)
	}
	for _, img := range images {
		fmt.Println(img)
	}
	fmt.Fprintf(os.Stderr, "argoimages: the argo-cd chart renders %d distinct image(s)\n", len(images))
}
