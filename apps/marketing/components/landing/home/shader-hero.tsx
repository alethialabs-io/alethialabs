"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { buildProgram } from "./shaders/gl";
import { buildFragSrc, VERT_SRC } from "./shaders/focusing-field";

/** True when the visitor prefers reduced motion. */
function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

const DPR_CAP = 1.5;
const STATIC_T = 14.0; // the frozen time for the reduced-motion still frame

/**
 * ShaderHero — the grayscale WebGL2 "Focusing Field" behind the hero copy.
 *
 * Decorative (aria-hidden, pointer-events: none), theme-aware via a transparent
 * canvas composited over the page --background, and reduced-motion safe (one
 * static frame, no loop). The rAF loop pauses when the hero scrolls offscreen
 * or the tab is hidden. If WebGL2 is unavailable or the program fails to build,
 * it falls back to the existing .ah-grid-bg blueprint grid.
 */
export function ShaderHero() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const fallbackRef = useRef<HTMLDivElement>(null);
	const { resolvedTheme } = useTheme();
	// Read the theme inside the rAF loop without re-subscribing the effect.
	const themeRef = useRef(0);
	themeRef.current = resolvedTheme === "dark" ? 1 : 0;
	// Set by the init effect; lets the theme-change effect repaint one frame
	// even while the loop is paused or reduced-motion is on.
	const redrawRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const showFallback = () => fallbackRef.current?.style.setProperty("display", "block");
		if (!canvas) return;

		const gl = canvas.getContext("webgl2", {
			alpha: true,
			antialias: false,
			premultipliedAlpha: false,
			depth: false,
			stencil: false,
			powerPreference: "low-power",
		});
		if (!gl) {
			showFallback();
			return;
		}

		const reduce = prefersReducedMotion();
		const lowQuality =
			window.matchMedia("(pointer: coarse)").matches ||
			(navigator.hardwareConcurrency ?? 8) <= 4;
		const dprCap = lowQuality ? 1.0 : DPR_CAP;

		const program = buildProgram(gl, VERT_SRC, buildFragSrc(lowQuality ? 3 : 5));
		if (!program) {
			showFallback();
			return;
		}
		gl.useProgram(program);
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.clearColor(0, 0, 0, 0);

		const uRes = gl.getUniformLocation(program, "uResolution");
		const uTime = gl.getUniformLocation(program, "uTime");
		const uThemeDark = gl.getUniformLocation(program, "uThemeDark");
		const uPointer = gl.getUniformLocation(program, "uPointer");
		const uReveal = gl.getUniformLocation(program, "uReveal");

		const ptr = { x: 0, y: 0 };
		const ptrTarget = { x: 0, y: 0 };
		let raf = 0;
		let elapsed = 0;
		let last = performance.now();
		let onScreen = true;
		let visible = true;
		let start = performance.now();

		const resize = () => {
			const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
			const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
			const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
				gl.viewport(0, 0, w, h);
			}
			gl.uniform2f(uRes, canvas.width, canvas.height);
		};

		const render = (tSec: number) => {
			resize();
			gl.uniform1f(uTime, tSec);
			gl.uniform1f(uThemeDark, themeRef.current);
			gl.uniform2f(uPointer, ptr.x, ptr.y);
			// Reduced motion skips the intro animation; the loop eases it in.
			gl.uniform1f(uReveal, reduce ? 1.0 : Math.min(1, (performance.now() - start) / 900));
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};

		redrawRef.current = () => render(reduce ? STATIC_T : elapsed);

		const loop = () => {
			if (!onScreen || !visible) {
				raf = 0;
				return;
			}
			const now = performance.now();
			elapsed += (now - last) / 1000;
			last = now;
			ptr.x += (ptrTarget.x - ptr.x) * 0.06;
			ptr.y += (ptrTarget.y - ptr.y) * 0.06;
			render(elapsed);
			raf = requestAnimationFrame(loop);
		};
		const kick = () => {
			if (raf || reduce || !onScreen || !visible) return;
			last = performance.now(); // resume without a time jump
			raf = requestAnimationFrame(loop);
		};

		if (reduce) render(STATIC_T);
		else kick();

		const ro = new ResizeObserver(() => {
			if (reduce || !raf) render(reduce ? STATIC_T : elapsed);
		});
		ro.observe(canvas);

		const io = new IntersectionObserver(
			([e]) => {
				onScreen = e.isIntersecting;
				if (onScreen) kick();
			},
			{ threshold: 0.01 },
		);
		io.observe(canvas);

		const onVisibility = () => {
			visible = document.visibilityState === "visible";
			if (visible) kick();
		};
		document.addEventListener("visibilitychange", onVisibility);

		const fine = window.matchMedia("(pointer: fine)").matches;
		const onMove = (ev: PointerEvent) => {
			const b = canvas.getBoundingClientRect();
			ptrTarget.x = ((ev.clientX - b.left) / b.width) * 2 - 1;
			ptrTarget.y = -(((ev.clientY - b.top) / b.height) * 2 - 1);
		};
		if (fine && !reduce) window.addEventListener("pointermove", onMove, { passive: true });

		const onLost = (ev: Event) => {
			ev.preventDefault();
			cancelAnimationFrame(raf);
			raf = 0;
			showFallback();
		};
		canvas.addEventListener("webglcontextlost", onLost);

		return () => {
			redrawRef.current = null;
			cancelAnimationFrame(raf);
			ro.disconnect();
			io.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("webglcontextlost", onLost);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		};
	}, []);

	// Repaint one frame on light/dark toggle (covers the paused/reduced-motion
	// case; when the loop is running it repaints itself on the next frame).
	useEffect(() => {
		redrawRef.current?.();
	}, [resolvedTheme]);

	return (
		<div
			aria-hidden
			style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden" }}
		>
			<canvas
				ref={canvasRef}
				className="ah-hero-mask"
				style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
			/>
			<div ref={fallbackRef} className="ah-grid-bg" style={{ display: "none" }} />
		</div>
	);
}
