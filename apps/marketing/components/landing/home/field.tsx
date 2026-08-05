// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useRef } from "react";
import { RAMP_THEME } from "@repo/brand/ramp-srgb";

import {
	FIELD_GLYPHS,
	FIELD_SUBJECTS,
	type FieldSubject,
} from "@/lib/proof/plan-field";

/**
 * The hero field: plan subjects under gravity, and a bracket you drag them into.
 *
 * The page's argument is that Alethia does not assert, it examines — so the hero
 * is the examination rather than a picture of one. Chips carrying real OpenTofu
 * addresses fall, collide and pile up; drop one between the brackets and a scan
 * passes over it and it comes back stamped with its verdict.
 *
 * Canvas rather than DOM because this is ~12 bodies resolved pairwise every
 * frame; and 2D canvas rather than WebGL because there is nothing here a GPU
 * would help with. It is decorative — `aria-hidden` — and every verdict it
 * produces is mirrored into the readout, which is real text.
 */

interface Body {
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Rotation and angular velocity. */
	a: number;
	va: number;
	/** Collision radius. Chips are boxes resolved as circles, so this must stay close
	 * to the drawn half-height or they hold each other apart and never look stacked. */
	r: number;
	/** Half-width / half-height, measured at draw time for hit-testing. */
	hw: number;
	hh: number;
	subject?: FieldSubject;
	glyph?: string;
	/** Filled rather than outlined — half the glyph chips, for contrast. */
	inverted?: boolean;
	/** Set once the gate has ruled on it. */
	stamp?: string;
}

const GRAVITY = 0.55;
const RESTITUTION = 0.3;
const AIR_FRICTION = 0.992;
const FLOOR_FRICTION = 0.88;
const WALL_DAMPING = 0.12;
/** Frames the scan hairline takes to cross a subject. */
const SCAN_FRAMES = 22;
/** The pile rests this far above the viewport floor. Resting on the floor itself put
 * the chips half off-screen, which made the one interactive thing on the page invisible. */
const FLOOR_INSET = 132;

export interface FieldVerdict {
	subject: FieldSubject;
	/** Monotonic counter so the readout re-animates on a repeat verdict. */
	seq: number;
}

interface FieldProps {
	onVerdict: (verdict: FieldVerdict | null) => void;
}

export function Field({ onVerdict }: FieldProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	/** Kept in a ref so the animation loop never re-subscribes when the parent
	 * re-renders — the simulation must survive every verdict it reports. */
	const verdictRef = useRef(onVerdict);
	useEffect(() => {
		verdictRef.current = onVerdict;
	}, [onVerdict]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const dpr = Math.min(window.devicePixelRatio || 1, 2);

		let width = 0;
		let height = 0;
		let bodies: Body[] = [];
		let dragging: Body | null = null;
		let grabX = 0;
		let grabY = 0;
		let lastX = 0;
		let lastY = 0;
		let throwX = 0;
		let throwY = 0;
		let gate = { x: 0, y: 0, w: 0, h: 0 };
		/* Narrow viewports get the falling pile as texture but no gate: there is no room
		   for a drop target that does not collide with the headline, and the fixed consent
		   notice covers the lower half on a phone anyway. The chips stay throwable. */
		let showGate = true;
		let held: Body | null = null;
		let scan = -1;
		let seq = 0;
		let running = true;
		let frame = 0;

		/* Theme colours come from the tokens, not hardcoded, and are re-read only
		   when the theme actually changes — never per frame.

		   The tokens are OKLCH. Canvas 2D accepts CSS Color 4 in current browsers,
		   but when it does not, assigning an unparseable `fillStyle` is a silent
		   no-op that leaves the previous colour in place — which would render the
		   whole field in whatever was set last. So each value is probed once and
		   falls back to the ramp's sRGB transcription if the canvas rejects it. */
		let ink: string = RAMP_THEME.dark.textPrimary;
		let surface: string = RAMP_THEME.dark.surface;
		let page: string = RAMP_THEME.dark.background;

		const accepts = (value: string) => {
			if (!value) return false;
			const probe = "#010203";
			ctx.fillStyle = probe;
			ctx.fillStyle = value;
			return ctx.fillStyle !== probe;
		};
		const readTheme = () => {
			const s = getComputedStyle(document.documentElement);
			const dark = document.documentElement.classList.contains("dark");
			const fallback = RAMP_THEME[dark ? "dark" : "light"];
			const pick = (token: string, spare: string) => {
				const value = s.getPropertyValue(token).trim();
				return accepts(value) ? value : spare;
			};
			ink = pick("--text-primary", fallback.textPrimary);
			surface = pick("--surface", fallback.surface);
			page = pick("--background", fallback.background);
		};

		const cursorFor = (closed: boolean) => {
			const glyph = closed
				? "<path d='M13 8H9v16h4'/><path d='M23 8h4v16h-4'/>"
				: "<path d='M10 7H5v18h5'/><path d='M26 7h5v18h-5'/>";
			const dot = closed
				? `<circle cx='16' cy='16' r='2.4' fill='${ink}' stroke='none'/>`
				: "";
			const svg =
				`<svg xmlns='http://www.w3.org/2000/svg' width='36' height='32'>` +
				`<g fill='none' stroke='${ink}' stroke-width='2.2' stroke-linecap='square'>` +
				`${glyph}${dot}</g></svg>`;
			return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 18 16, grab`;
		};

		const layout = () => {
			const rect = canvas.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			showGate = width >= 900;
			const w = Math.min(300, Math.max(180, width * 0.26));
			const h = Math.min(190, Math.max(130, height * 0.24));
			// Upper right. It cannot sit above the pile where the drag would be shortest:
			// the first-visit consent notice is fixed to the lower right and would cover
			// it completely on the one view that matters most.
			gate = {
				x: width - w - Math.max(40, width * 0.08),
				y: Math.max(96, height * 0.26),
				w,
				h,
			};
		};

		const seed = () => {
			const small = width < 820;
			// Clustered right of the copy column, not spread across the full width: a
			// dozen chips strewn edge to edge read as debris, stacked they read as a pile.
			const spawn = (spread: number) =>
				width * (small ? 0.14 : 0.46) + Math.random() * width * spread;

			bodies = FIELD_SUBJECTS.map((subject) => ({
				x: spawn(small ? 0.72 : 0.44),
				y: -80 - Math.random() * height * 0.45,
				vx: (Math.random() - 0.5) * 1.6,
				vy: Math.random(),
				a: (Math.random() - 0.5) * 0.5,
				va: (Math.random() - 0.5) * 0.05,
				r: small ? 17 : 22,
				hw: 0,
				hh: 0,
				subject,
			}));
			FIELD_GLYPHS.forEach((glyph, i) => {
				bodies.push({
					x: spawn(small ? 0.72 : 0.44),
					y: -60 - Math.random() * height * 0.35,
					vx: (Math.random() - 0.5) * 2,
					vy: Math.random(),
					a: (Math.random() - 0.5) * 0.7,
					va: (Math.random() - 0.5) * 0.07,
					r: small ? 16 : 21,
					hw: 0,
					hh: 0,
					glyph,
					inverted: i % 2 === 1,
				});
			});
		};

		const roundRect = (x: number, y: number, w: number, h: number, radius: number) => {
			ctx.beginPath();
			ctx.moveTo(x + radius, y);
			ctx.arcTo(x + w, y, x + w, y + h, radius);
			ctx.arcTo(x + w, y + h, x, y + h, radius);
			ctx.arcTo(x, y + h, x, y, radius);
			ctx.arcTo(x, y, x + w, y, radius);
			ctx.closePath();
		};

		const drawGate = () => {
			if (!showGate) return;
			const { x, y, w, h } = gate;
			const arm = Math.min(34, w * 0.15);
			ctx.save();
			ctx.strokeStyle = ink;
			ctx.lineWidth = 1.5;
			ctx.globalAlpha = held ? 0.95 : dragging ? 0.6 : 0.28;
			ctx.beginPath();
			ctx.moveTo(x + arm, y);
			ctx.lineTo(x, y);
			ctx.lineTo(x, y + h);
			ctx.lineTo(x + arm, y + h);
			ctx.moveTo(x + w - arm, y);
			ctx.lineTo(x + w, y);
			ctx.lineTo(x + w, y + h);
			ctx.lineTo(x + w - arm, y + h);
			ctx.stroke();

			ctx.globalAlpha = 0.45;
			ctx.fillStyle = ink;
			ctx.font = '400 10px "Geist Mono", ui-monospace, monospace';
			ctx.textAlign = "center";
			ctx.textBaseline = "alphabetic";
			ctx.fillText("ELENCH · THE GATE", x + w / 2, y + h + 22);

			if (scan >= 0) {
				const t = scan / SCAN_FRAMES;
				ctx.globalAlpha = 0.9;
				ctx.lineWidth = 1;
				const sy = y + h * t;
				ctx.beginPath();
				ctx.moveTo(x + 8, sy);
				ctx.lineTo(x + w - 8, sy);
				ctx.stroke();
			}
			ctx.restore();
		};

		const render = () => {
			ctx.clearRect(0, 0, width, height);
			drawGate();

			for (const b of bodies) {
				ctx.save();
				ctx.translate(b.x, b.y);
				ctx.rotate(b.a);

				if (b.glyph) {
					const s = b.r * 1.8;
					b.hw = s / 2;
					b.hh = s / 2;
					roundRect(-s / 2, -s / 2, s, s, 4);
					ctx.fillStyle = b.inverted ? ink : surface;
					ctx.fill();
					ctx.lineWidth = 1;
					ctx.strokeStyle = ink;
					ctx.globalAlpha = 0.5;
					ctx.stroke();
					ctx.globalAlpha = 1;
					ctx.fillStyle = b.inverted ? page : ink;
					ctx.font = `400 ${Math.round(b.r * 0.7)}px "Geist Mono", ui-monospace, monospace`;
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText(b.glyph, 0, 1);
				} else if (b.subject) {
					ctx.font = '400 11px "Geist Mono", ui-monospace, monospace';
					const pad = 13;
					const w = Math.min(250, ctx.measureText(b.subject.address).width + pad * 2);
					const h = b.stamp ? 44 : 30;
					b.hw = w / 2;
					b.hh = h / 2;
					roundRect(-w / 2, -h / 2, w, h, 2);
					ctx.fillStyle = surface;
					ctx.fill();
					ctx.lineWidth = 1;
					ctx.strokeStyle = ink;
					ctx.globalAlpha = b.stamp ? 0.85 : 0.36;
					ctx.stroke();
					ctx.globalAlpha = 1;
					ctx.fillStyle = ink;
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText(b.subject.address, 0, b.stamp ? -7 : 0, w - pad * 2);
					if (b.stamp) {
						ctx.globalAlpha = 0.7;
						ctx.font = '400 9px "Geist Mono", ui-monospace, monospace';
						ctx.fillText(b.stamp, 0, 9, w - pad * 2);
					}
				}
				ctx.restore();
			}
		};

		const integrate = () => {
			for (const b of bodies) {
				if (b === dragging) continue;
				b.vy += GRAVITY;
				b.vx *= AIR_FRICTION;
				b.vy *= AIR_FRICTION;
				b.x += b.vx;
				b.y += b.vy;
				b.a += b.va;
				if (b.x - b.r < 0) {
					b.x = b.r;
					b.vx = Math.abs(b.vx) * WALL_DAMPING;
					b.va = -b.va;
				}
				if (b.x + b.r > width) {
					b.x = width - b.r;
					b.vx = -Math.abs(b.vx) * WALL_DAMPING;
					b.va = -b.va;
				}
				const floor = height - FLOOR_INSET;
				if (b.y + b.r > floor) {
					b.y = floor - b.r;
					b.vy = -b.vy * RESTITUTION;
					b.vx *= FLOOR_FRICTION;
					b.va *= 0.8;
					if (Math.abs(b.vy) < 1.4) {
						b.vy = 0;
						b.va *= 0.55;
					}
				}
			}

			for (let i = 0; i < bodies.length; i++) {
				for (let j = i + 1; j < bodies.length; j++) {
					const a = bodies[i];
					const b = bodies[j];
					if (!a || !b) continue;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const dist = Math.hypot(dx, dy) || 0.01;
					const min = a.r + b.r;
					if (dist >= min) continue;
					const nx = dx / dist;
					const ny = dy / dist;
					const overlap = min - dist;
					const aFree = a !== dragging;
					const bFree = b !== dragging;
					const share = aFree && bFree ? 0.5 : 1;
					if (aFree) {
						a.x -= nx * overlap * share;
						a.y -= ny * overlap * share;
					}
					if (bFree) {
						b.x += nx * overlap * share;
						b.y += ny * overlap * share;
					}
					const normal = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
					if (normal >= 0) continue;
					const impulse = (-(1 + RESTITUTION) * normal) / 2;
					if (aFree) {
						a.vx -= impulse * nx;
						a.vy -= impulse * ny;
					}
					if (bFree) {
						b.vx += impulse * nx;
						b.vy += impulse * ny;
					}
				}
			}

			if (scan >= 0) {
				scan += 1;
				if (scan > SCAN_FRAMES) settle();
			}
		};

		/** The gate rules, stamps the subject, and hands it back to the pile. */
		const settle = () => {
			scan = -1;
			const body = held;
			held = null;
			if (!body?.subject) return;
			const { subject } = body;
			body.stamp =
				subject.status === "pass"
					? `✓ ${subject.controlId} · pass`
					: "— not evaluable";
			body.vy = -7;
			body.vx = -3 - Math.random() * 2;
			body.va = (Math.random() - 0.5) * 0.12;
			seq += 1;
			verdictRef.current({ subject, seq });
		};

		const hits = (b: Body, x: number, y: number) =>
			b.glyph
				? Math.hypot(x - b.x, y - b.y) < b.r * 1.1
				: Math.abs(x - b.x) < (b.hw || b.r) && Math.abs(y - b.y) < (b.hh || b.r);

		const point = (event: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			return { x: event.clientX - rect.left, y: event.clientY - rect.top };
		};

		const onDown = (event: PointerEvent) => {
			const { x, y } = point(event);
			for (let i = bodies.length - 1; i >= 0; i--) {
				const b = bodies[i];
				if (!b || !hits(b, x, y)) continue;
				dragging = b;
				grabX = x - b.x;
				grabY = y - b.y;
				lastX = x;
				lastY = y;
				b.va = 0;
				canvas.setPointerCapture(event.pointerId);
				canvas.style.cursor = cursorFor(true);
				return;
			}
		};

		const onMove = (event: PointerEvent) => {
			const { x, y } = point(event);
			if (!dragging) {
				canvas.style.cursor = cursorFor(bodies.some((b) => hits(b, x, y)));
				return;
			}
			throwX = x - lastX;
			throwY = y - lastY;
			lastX = x;
			lastY = y;
			dragging.x = x - grabX;
			dragging.y = y - grabY;
		};

		const onUp = () => {
			const body = dragging;
			dragging = null;
			canvas.style.cursor = cursorFor(false);
			if (!body) return;
			body.vx = Math.max(-26, Math.min(26, throwX));
			body.vy = Math.max(-26, Math.min(26, throwY));
			body.va = Math.max(-0.2, Math.min(0.2, throwX * 0.006));

			const inside =
				showGate &&
				body.x > gate.x &&
				body.x < gate.x + gate.w &&
				body.y > gate.y &&
				body.y < gate.y + gate.h;
			if (inside && body.subject && scan < 0) {
				body.x = gate.x + gate.w / 2;
				body.y = gate.y + gate.h / 2;
				body.vx = 0;
				body.vy = 0;
				body.va = 0;
				body.a = 0;
				held = body;
				scan = 0;
			}
		};

		const loop = () => {
			if (running) {
				integrate();
				render();
			}
			frame = requestAnimationFrame(loop);
		};

		readTheme();
		layout();
		seed();
		canvas.style.cursor = cursorFor(false);

		const onResize = () => {
			layout();
		};
		const themeObserver = new MutationObserver(() => {
			readTheme();
			canvas.style.cursor = cursorFor(false);
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		const visibility = new IntersectionObserver((entries) => {
			running = entries[0]?.isIntersecting ?? true;
		});
		visibility.observe(canvas);
		const onHidden = () => {
			running = !document.hidden;
		};

		window.addEventListener("resize", onResize, { passive: true });
		document.addEventListener("visibilitychange", onHidden);
		canvas.addEventListener("pointerdown", onDown);
		canvas.addEventListener("pointermove", onMove);
		canvas.addEventListener("pointerup", onUp);
		canvas.addEventListener("pointercancel", onUp);

		if (reduced) {
			// Settle the pile off-screen, then hold one static, legible frame.
			for (let i = 0; i < 420; i++) integrate();
			render();
		} else {
			loop();
		}

		return () => {
			cancelAnimationFrame(frame);
			themeObserver.disconnect();
			visibility.disconnect();
			window.removeEventListener("resize", onResize);
			document.removeEventListener("visibilitychange", onHidden);
			canvas.removeEventListener("pointerdown", onDown);
			canvas.removeEventListener("pointermove", onMove);
			canvas.removeEventListener("pointerup", onUp);
			canvas.removeEventListener("pointercancel", onUp);
		};
	}, []);

	return <canvas ref={canvasRef} className="mkt-field" aria-hidden="true" />;
}
