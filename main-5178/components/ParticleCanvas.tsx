import React, { useEffect, useRef } from 'react';

const PARTICLE_DENSITY = 11200;
const MIN_PARTICLES = 230;
const MAX_PARTICLES = 720;
const ATTRACTION_RADIUS = 285;
const COLLISION_CELL_SIZE = 28;
const MAX_SPEED = 2.35;

interface ParticleCanvasProps {
    theme?: 'dark' | 'light';
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    mass: number;
    seed: number;
    alpha: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const ParticleCanvas: React.FC<ParticleCanvasProps> = ({ theme = 'dark' }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouseRef = useRef({ x: -9999, y: -9999, active: false });
    const smoothMouseRef = useRef({ x: -9999, y: -9999 });
    const particlesRef = useRef<Particle[]>([]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId = 0;
        let width = 0;
        let height = 0;
        let dpr = 1;
        let lastTime = performance.now();
        const isLight = theme === 'light';
        const palette = isLight
            ? {
                star: '57, 78, 112',
                active: '38, 112, 154',
                line: '79, 129, 164',
                glowStart: 'rgba(96, 172, 210, ',
                glowMid: 'rgba(117, 126, 214, ',
                mouseStart: 'rgba(86, 160, 208, 0.085)',
                mouseMid: 'rgba(118, 112, 220, 0.032)',
                mouseEnd: 'rgba(118, 112, 220, 0)'
            }
            : {
                star: '168, 204, 255',
                active: '237, 250, 255',
                line: '91, 151, 220',
                glowStart: 'rgba(218, 242, 255, ',
                glowMid: 'rgba(94, 170, 255, ',
                mouseStart: 'rgba(95, 164, 255, 0.095)',
                mouseMid: 'rgba(145, 96, 255, 0.038)',
                mouseEnd: 'rgba(145, 96, 255, 0)'
            };

        const createParticle = (): Particle => {
            const seed = Math.random();
            const radius = 0.75 + Math.random() * 1.45;
            return {
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.35,
                vy: (Math.random() - 0.5) * 0.35,
                radius,
                mass: radius * radius,
                seed,
                alpha: 0.34 + Math.random() * 0.42
            };
        };

        const seedParticles = () => {
            const targetCount = clamp(Math.round((width * height) / PARTICLE_DENSITY), MIN_PARTICLES, MAX_PARTICLES);
            const particles = particlesRef.current;

            while (particles.length < targetCount) {
                particles.push(createParticle());
            }

            if (particles.length > targetCount) {
                particles.length = targetCount;
            }

            for (const particle of particles) {
                particle.x = clamp(particle.x, particle.radius, width - particle.radius);
                particle.y = clamp(particle.y, particle.radius, height - particle.radius);
            }
        };

        const resize = () => {
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            seedParticles();
        };

        const handlePointerMove = (event: PointerEvent) => {
            mouseRef.current = { x: event.clientX, y: event.clientY, active: true };
        };

        const handlePointerLeave = () => {
            mouseRef.current.active = false;
        };

        const drawParticle = (particle: Particle, influence: number, timestamp: number) => {
            const twinkle = 0.78 + Math.sin(timestamp * 0.0012 + particle.seed * 18) * 0.22;
            const glowRadius = particle.radius * (2.8 + influence * 4.8);
            const coreAlpha = (particle.alpha * (isLight ? 0.42 : 0.55) + influence * 0.34) * twinkle;
            const outerAlpha = (isLight ? 0.025 : 0.04) * twinkle + influence * 0.075;
            const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
            gradient.addColorStop(0, `rgba(${influence > 0.2 ? palette.active : palette.star}, ${coreAlpha})`);
            gradient.addColorStop(0.34, `${palette.glowStart}${outerAlpha})`);
            gradient.addColorStop(1, `${palette.glowMid}0)`);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
            ctx.fill();
        };

        const resolveCollisions = (grid: Map<string, Particle[]>) => {
            for (const particle of particlesRef.current) {
                const cellX = Math.floor(particle.x / COLLISION_CELL_SIZE);
                const cellY = Math.floor(particle.y / COLLISION_CELL_SIZE);

                for (let oy = -1; oy <= 1; oy += 1) {
                    for (let ox = -1; ox <= 1; ox += 1) {
                        const neighbors = grid.get(`${cellX + ox}:${cellY + oy}`);
                        if (!neighbors) continue;

                        for (const other of neighbors) {
                            if (particle === other || particle.seed > other.seed) continue;

                            const dx = other.x - particle.x;
                            const dy = other.y - particle.y;
                            const distSq = dx * dx + dy * dy;
                            const minDist = particle.radius + other.radius + 8;

                            if (distSq <= 0 || distSq > minDist * minDist) continue;

                            const dist = Math.sqrt(distSq);
                            const nx = dx / dist;
                            const ny = dy / dist;
                            const overlap = minDist - dist;
                            const push = overlap * 0.018;
                            const totalMass = particle.mass + other.mass;
                            const particleShare = other.mass / totalMass;
                            const otherShare = particle.mass / totalMass;

                            particle.x -= nx * push * particleShare;
                            particle.y -= ny * push * particleShare;
                            other.x += nx * push * otherShare;
                            other.y += ny * push * otherShare;

                            const rvx = other.vx - particle.vx;
                            const rvy = other.vy - particle.vy;
                            const velocityAlongNormal = rvx * nx + rvy * ny;
                            if (velocityAlongNormal > 0) continue;

                            const impulse = (-velocityAlongNormal * 0.62) / (1 / particle.mass + 1 / other.mass);
                            particle.vx -= (impulse * nx) / particle.mass;
                            particle.vy -= (impulse * ny) / particle.mass;
                            other.vx += (impulse * nx) / other.mass;
                            other.vy += (impulse * ny) / other.mass;
                        }
                    }
                }
            }
        };

        const draw = (timestamp = 0) => {
            const delta = clamp((timestamp - lastTime) / 16.67, 0.4, 1.8);
            lastTime = timestamp;
            ctx.clearRect(0, 0, width, height);

            const target = mouseRef.current.active
                ? mouseRef.current
                : { x: width * 0.5, y: height * 0.5 };
            const smooth = smoothMouseRef.current;
            smooth.x += (target.x - smooth.x) * 0.32;
            smooth.y += (target.y - smooth.y) * 0.32;

            const grid = new Map<string, Particle[]>();

            ctx.save();
            ctx.globalCompositeOperation = isLight ? 'multiply' : 'screen';

            if (mouseRef.current.active) {
                const mouseGlow = ctx.createRadialGradient(smooth.x, smooth.y, 0, smooth.x, smooth.y, ATTRACTION_RADIUS);
                mouseGlow.addColorStop(0, palette.mouseStart);
                mouseGlow.addColorStop(0.5, palette.mouseMid);
                mouseGlow.addColorStop(1, palette.mouseEnd);
                ctx.fillStyle = mouseGlow;
                ctx.beginPath();
                ctx.arc(smooth.x, smooth.y, ATTRACTION_RADIUS, 0, Math.PI * 2);
                ctx.fill();
            }

            for (const particle of particlesRef.current) {
                const dx = smooth.x - particle.x;
                const dy = smooth.y - particle.y;
                const distSq = dx * dx + dy * dy;
                const distance = Math.sqrt(distSq) || 1;
                const influence = mouseRef.current.active && distance < ATTRACTION_RADIUS
                    ? Math.pow(1 - distance / ATTRACTION_RADIUS, 1.7)
                    : 0;

                if (influence > 0) {
                    const pull = 0.07 * influence * delta;
                    particle.vx += (dx / distance) * pull;
                    particle.vy += (dy / distance) * pull;

                    const swirl = 0.008 * influence * delta;
                    particle.vx += (-dy / distance) * swirl;
                    particle.vy += (dx / distance) * swirl;
                }

                particle.vx += (Math.sin(timestamp * 0.00026 + particle.seed * 15) * 0.0022) * delta;
                particle.vy += (Math.cos(timestamp * 0.00022 + particle.seed * 17) * 0.0022) * delta;
                particle.vx *= 0.988;
                particle.vy *= 0.988;

                const speed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
                if (speed > MAX_SPEED) {
                    particle.vx = (particle.vx / speed) * MAX_SPEED;
                    particle.vy = (particle.vy / speed) * MAX_SPEED;
                }

                particle.x += particle.vx * delta;
                particle.y += particle.vy * delta;

                if (particle.x < particle.radius) {
                    particle.x = particle.radius;
                    particle.vx = Math.abs(particle.vx) * 0.86;
                } else if (particle.x > width - particle.radius) {
                    particle.x = width - particle.radius;
                    particle.vx = -Math.abs(particle.vx) * 0.86;
                }

                if (particle.y < particle.radius) {
                    particle.y = particle.radius;
                    particle.vy = Math.abs(particle.vy) * 0.86;
                } else if (particle.y > height - particle.radius) {
                    particle.y = height - particle.radius;
                    particle.vy = -Math.abs(particle.vy) * 0.86;
                }

                const cellX = Math.floor(particle.x / COLLISION_CELL_SIZE);
                const cellY = Math.floor(particle.y / COLLISION_CELL_SIZE);
                const key = `${cellX}:${cellY}`;
                const bucket = grid.get(key);
                if (bucket) {
                    bucket.push(particle);
                } else {
                    grid.set(key, [particle]);
                }
            }

            resolveCollisions(grid);

            for (const particle of particlesRef.current) {
                const dx = smooth.x - particle.x;
                const dy = smooth.y - particle.y;
                const distSq = dx * dx + dy * dy;
                const influence = mouseRef.current.active && distSq < ATTRACTION_RADIUS * ATTRACTION_RADIUS
                    ? Math.pow(1 - Math.sqrt(distSq) / ATTRACTION_RADIUS, 1.9)
                    : 0;
                drawParticle(particle, influence, timestamp);
            }

            for (const particle of particlesRef.current) {
                const cellX = Math.floor(particle.x / COLLISION_CELL_SIZE);
                const cellY = Math.floor(particle.y / COLLISION_CELL_SIZE);

                for (let oy = -1; oy <= 1; oy += 1) {
                    for (let ox = -1; ox <= 1; ox += 1) {
                        const neighbors = grid.get(`${cellX + ox}:${cellY + oy}`);
                        if (!neighbors) continue;

                        for (const other of neighbors) {
                            if (particle.seed >= other.seed) continue;

                            const dx = other.x - particle.x;
                            const dy = other.y - particle.y;
                            const distSq = dx * dx + dy * dy;
                            if (distSq > 42 * 42) continue;

                            const alpha = (1 - Math.sqrt(distSq) / 42) * (isLight ? 0.07 : 0.11);
                            ctx.strokeStyle = `rgba(${palette.line}, ${alpha})`;
                            ctx.lineWidth = 0.45;
                            ctx.beginPath();
                            ctx.moveTo(particle.x, particle.y);
                            ctx.lineTo(other.x, other.y);
                            ctx.stroke();
                        }
                    }
                }
            }

            ctx.restore();
            animationFrameId = requestAnimationFrame(draw);
        };

        resize();
        draw();

        window.addEventListener('resize', resize);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerleave', handlePointerLeave);
        window.addEventListener('blur', handlePointerLeave);

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', resize);
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerleave', handlePointerLeave);
            window.removeEventListener('blur', handlePointerLeave);
        };
    }, [theme]);

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 z-0 pointer-events-none"
            aria-hidden="true"
        />
    );
};

export default ParticleCanvas;
