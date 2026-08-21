import React, { useEffect, useRef } from 'react';
import { ViewportTransform } from '../types';

const BASE_WORLD_SPACING = 32;
const MIN_SCREEN_SPACING = 20;
const MAX_SCREEN_SPACING = 44;
const HIGHLIGHT_RADIUS = 110;

interface ParticleCanvasProps {
    theme?: 'dark' | 'light';
    viewport: ViewportTransform;
}

interface PointerState {
    targetX: number;
    targetY: number;
    displayX: number;
    displayY: number;
    strength: number;
    active: boolean;
}

const positiveModulo = (value: number, divisor: number) => ((value % divisor) + divisor) % divisor;
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

const ParticleCanvas: React.FC<ParticleCanvasProps> = ({ theme = 'dark', viewport }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef(viewport);
    const requestDrawRef = useRef<() => void>(() => undefined);

    useEffect(() => {
        viewportRef.current = viewport;
        requestDrawRef.current();
    }, [viewport.x, viewport.y, viewport.k]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        const pointer: PointerState = {
            targetX: -HIGHLIGHT_RADIUS,
            targetY: -HIGHLIGHT_RADIUS,
            displayX: -HIGHLIGHT_RADIUS,
            displayY: -HIGHLIGHT_RADIUS,
            strength: 0,
            active: false,
        };
        let width = 0;
        let height = 0;
        let animationFrameId = 0;
        let frameRequested = false;

        const palette = theme === 'light'
            ? { base: '64, 82, 100', active: '7, 116, 136', baseAlpha: 0.19, activeAlpha: 0.82 }
            : { base: '132, 151, 170', active: '213, 244, 250', baseAlpha: 0.18, activeAlpha: 0.92 };

        const resolveGrid = () => {
            const currentViewport = viewportRef.current;
            let worldSpacing = BASE_WORLD_SPACING;
            let screenSpacing = worldSpacing * currentViewport.k;

            while (screenSpacing < MIN_SCREEN_SPACING) {
                worldSpacing *= 2;
                screenSpacing = worldSpacing * currentViewport.k;
            }
            while (screenSpacing > MAX_SCREEN_SPACING) {
                worldSpacing /= 2;
                screenSpacing = worldSpacing * currentViewport.k;
            }

            return {
                spacing: screenSpacing,
                startX: positiveModulo(currentViewport.x, screenSpacing),
                startY: positiveModulo(currentViewport.y, screenSpacing),
            };
        };

        const draw = () => {
            frameRequested = false;
            context.clearRect(0, 0, width, height);
            const { spacing, startX, startY } = resolveGrid();
            const radiusSquared = HIGHLIGHT_RADIUS * HIGHLIGHT_RADIUS;

            context.save();
            context.fillStyle = `rgba(${palette.base}, ${palette.baseAlpha})`;
            context.beginPath();
            for (let y = startY; y <= height; y += spacing) {
                for (let x = startX; x <= width; x += spacing) {
                    context.moveTo(x + 0.85, y);
                    context.arc(x, y, 0.85, 0, Math.PI * 2);
                }
            }
            context.fill();

            if (pointer.strength > 0.002) {
                const minX = Math.max(startX, pointer.displayX - HIGHLIGHT_RADIUS);
                const maxX = Math.min(width, pointer.displayX + HIGHLIGHT_RADIUS);
                const minY = Math.max(startY, pointer.displayY - HIGHLIGHT_RADIUS);
                const maxY = Math.min(height, pointer.displayY + HIGHLIGHT_RADIUS);
                const firstX = startX + Math.max(0, Math.ceil((minX - startX) / spacing)) * spacing;
                const firstY = startY + Math.max(0, Math.ceil((minY - startY) / spacing)) * spacing;

                for (let y = firstY; y <= maxY; y += spacing) {
                    for (let x = firstX; x <= maxX; x += spacing) {
                        const dx = x - pointer.displayX;
                        const dy = y - pointer.displayY;
                        const distanceSquared = dx * dx + dy * dy;
                        if (distanceSquared > radiusSquared) continue;

                        const distanceRatio = Math.sqrt(distanceSquared) / HIGHLIGHT_RADIUS;
                        const influence = easeOutCubic(1 - distanceRatio) * pointer.strength;
                        const dotRadius = 0.9 + influence * 1.65;
                        const alpha = palette.baseAlpha + influence * (palette.activeAlpha - palette.baseAlpha);

                        context.fillStyle = `rgba(${palette.active}, ${alpha})`;
                        context.shadowColor = `rgba(${palette.active}, ${influence * 0.72})`;
                        context.shadowBlur = 2 + influence * 9;
                        context.beginPath();
                        context.arc(x, y, dotRadius, 0, Math.PI * 2);
                        context.fill();
                    }
                }
            }
            context.restore();
        };

        const animate = () => {
            frameRequested = false;
            const targetStrength = pointer.active ? 1 : 0;
            pointer.displayX += (pointer.targetX - pointer.displayX) * 0.24;
            pointer.displayY += (pointer.targetY - pointer.displayY) * 0.24;
            pointer.strength += (targetStrength - pointer.strength) * (pointer.active ? 0.16 : 0.1);
            draw();

            const positionDelta = Math.abs(pointer.targetX - pointer.displayX) + Math.abs(pointer.targetY - pointer.displayY);
            const strengthDelta = Math.abs(targetStrength - pointer.strength);
            if (positionDelta > 0.12 || strengthDelta > 0.003) requestDraw();
        };

        const requestDraw = () => {
            if (frameRequested) return;
            frameRequested = true;
            animationFrameId = requestAnimationFrame(animate);
        };

        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            draw();
        };

        const handlePointerMove = (event: PointerEvent) => {
            pointer.targetX = event.clientX;
            pointer.targetY = event.clientY;
            if (!pointer.active) {
                pointer.displayX = event.clientX;
                pointer.displayY = event.clientY;
            }
            pointer.active = true;
            requestDraw();
        };

        const handlePointerLeave = () => {
            pointer.active = false;
            requestDraw();
        };

        requestDrawRef.current = requestDraw;
        resize();
        window.addEventListener('resize', resize);
        window.addEventListener('pointermove', handlePointerMove, { passive: true });
        document.documentElement.addEventListener('pointerleave', handlePointerLeave);
        window.addEventListener('blur', handlePointerLeave);

        return () => {
            cancelAnimationFrame(animationFrameId);
            requestDrawRef.current = () => undefined;
            window.removeEventListener('resize', resize);
            window.removeEventListener('pointermove', handlePointerMove);
            document.documentElement.removeEventListener('pointerleave', handlePointerLeave);
            window.removeEventListener('blur', handlePointerLeave);
        };
    }, [theme]);

    return <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true" />;
};

export default ParticleCanvas;
