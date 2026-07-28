// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Detect whether the browser can actually create a WebGL context (guards the Canvas). */
function detectWebgl(): boolean {
	try {
		const canvas = document.createElement("canvas");
		const gl =
			canvas.getContext("webgl2") ??
			canvas.getContext("webgl") ??
			canvas.getContext("experimental-webgl");
		if (gl === null) return false;
		// Release the throwaway probe context so it doesn't count against the
		// browser's small cap on concurrent WebGL contexts.
		if (gl instanceof WebGLRenderingContext || gl instanceof WebGL2RenderingContext) {
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		}
		return true;
	} catch {
		return false;
	}
}

/** Build the receding grayscale point cloud: XY spread, Z into the distance, brightness by depth. */
function buildPoints(count: number): { positions: Float32Array; colors: Float32Array } {
	const positions = new Float32Array(count * 3);
	const colors = new Float32Array(count * 3);
	const spreadX = 7;
	const spreadY = 4.6;
	const depth = 13;
	for (let i = 0; i < count; i += 1) {
		const z = -Math.random() * depth;
		positions[i * 3 + 0] = (Math.random() * 2 - 1) * spreadX;
		positions[i * 3 + 1] = (Math.random() * 2 - 1) * spreadY;
		positions[i * 3 + 2] = z;
		// Nearer points read brighter; strictly zero-chroma (r === g === b).
		const near = 1 - -z / depth;
		const g = 0.32 + 0.6 * near;
		colors[i * 3 + 0] = g;
		colors[i * 3 + 1] = g;
		colors[i * 3 + 2] = g;
	}
	return { positions, colors };
}

/** Build a faint blueprint line-grid (segment endpoints) on a single receding plane. */
function buildGrid(): Float32Array {
	const halfX = 7;
	const halfY = 4.6;
	const stepX = 1.75;
	const stepY = 1.53;
	const z = -3.4;
	const segs: number[] = [];
	for (let x = -halfX; x <= halfX + 0.001; x += stepX) {
		segs.push(x, -halfY, z, x, halfY, z);
	}
	for (let y = -halfY; y <= halfY + 0.001; y += stepY) {
		segs.push(-halfX, y, z, halfX, y, z);
	}
	return new Float32Array(segs);
}

/** The animated scene contents: a drifting point lattice + blueprint grid, parallaxed by pointer/scroll. */
function Field({
	intensity,
	scroll,
	pointer,
}: {
	intensity: number;
	scroll: { current: number };
	pointer: { current: { x: number; y: number } };
}) {
	const group = useRef<THREE.Group>(null);
	const count = Math.max(500, Math.min(3000, Math.round(2000 * intensity)));
	const cloud = useMemo(() => buildPoints(count), [count]);
	const grid = useMemo(() => buildGrid(), []);

	useFrame((state) => {
		const g = group.current;
		if (!g) return;
		const t = state.clock.elapsedTime;
		const p = pointer.current;
		const s = scroll.current;
		// Slow autonomous drift, layered with a gentle pointer parallax.
		g.rotation.y = Math.sin(t * 0.06) * 0.14 + p.x * 0.22;
		g.rotation.x = Math.cos(t * 0.05) * 0.07 - p.y * 0.16;
		// Scroll pushes the field deeper and lifts it, so it recedes as you read.
		g.position.z = s * 3.2;
		g.position.y = s * 0.9;
	});

	return (
		<group ref={group}>
			<points>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" args={[cloud.positions, 3]} />
					<bufferAttribute attach="attributes-color" args={[cloud.colors, 3]} />
				</bufferGeometry>
				<pointsMaterial
					vertexColors
					transparent
					opacity={Math.min(1, 0.85 * intensity + 0.1)}
					size={0.022}
					sizeAttenuation
					depthWrite={false}
				/>
			</points>
			<lineSegments>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" args={[grid, 3]} />
				</bufferGeometry>
				<lineBasicMaterial color={0xffffff} transparent opacity={0.06 * intensity} depthWrite={false} />
			</lineSegments>
		</group>
	);
}

/**
 * AmbientField — the signature grayscale WebGL backdrop: a lattice of points and
 * blueprint lines receding in Z, drifting slowly and parallaxing to the pointer
 * and scroll. Strictly monochrome (depth is expressed as point brightness, never
 * hue). The render loop pauses when the field scrolls offscreen or the tab is
 * hidden. Falls back to the static CSS blueprint grid (`.ah-grid-bg`) under
 * `prefers-reduced-motion` or when a WebGL context cannot be created.
 */
export function AmbientField({
	className,
	intensity = 1,
}: {
	className?: string;
	intensity?: number;
}) {
	const reduced = usePrefersReducedMotion();
	const wrapRef = useRef<HTMLDivElement>(null);
	const scroll = useRef<number>(0);
	const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const [webgl, setWebgl] = useState<boolean | null>(null);
	const [active, setActive] = useState(false);

	// One-shot WebGL capability probe (client-only; server renders the grid fallback).
	useEffect(() => {
		setWebgl(detectWebgl());
	}, []);

	// Drive `active` (and thus the raf loop) from viewport intersection + tab visibility.
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		let onScreen = false;
		const recompute = () => setActive(onScreen && !document.hidden);
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) onScreen = e.isIntersecting;
				recompute();
			},
			{ threshold: 0.01 },
		);
		io.observe(el);
		document.addEventListener("visibilitychange", recompute);
		return () => {
			io.disconnect();
			document.removeEventListener("visibilitychange", recompute);
		};
	}, []);

	// Track normalized scroll progress in a ref (no re-render) for the scene to read.
	useEffect(() => {
		const onScroll = () => {
			const max = document.documentElement.scrollHeight - window.innerHeight;
			scroll.current = max > 0 ? window.scrollY / max : 0;
		};
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	// Track the pointer globally (the backdrop is pointer-events:none, so the
	// Canvas never receives its own pointer events) — normalized to -1…1.
	useEffect(() => {
		const onMove = (e: PointerEvent) => {
			pointer.current = {
				x: (e.clientX / window.innerWidth) * 2 - 1,
				y: -((e.clientY / window.innerHeight) * 2 - 1),
			};
		};
		window.addEventListener("pointermove", onMove, { passive: true });
		return () => window.removeEventListener("pointermove", onMove);
	}, []);

	const outer = ["ah-grid-bg", className].filter(Boolean).join(" ");

	// Static fallback: reduced motion, or WebGL unavailable/undetermined.
	if (reduced || webgl === false || webgl === null) {
		return <div ref={wrapRef} className={outer} />;
	}

	return (
		<div
			ref={wrapRef}
			className={className}
			style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
		>
			<Canvas
				frameloop={active ? "always" : "never"}
				dpr={[1, 2]}
				camera={{ position: [0, 0, 6], fov: 55 }}
				gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
				style={{ background: "transparent" }}
			>
				<Field intensity={intensity} scroll={scroll} pointer={pointer} />
			</Canvas>
		</div>
	);
}
