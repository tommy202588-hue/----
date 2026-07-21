import React, { useEffect, useMemo, useState } from 'react';
import { CopyIcon, RefreshCwIcon, Wand2Icon, XIcon } from './Icons';
import { AppSettings } from '../types/settings';

type MultiAngleModelId = 'gpt-image-2' | 'nano-banana-2';

const MULTI_ANGLE_MODEL_OPTIONS: Array<{
    id: MultiAngleModelId;
    title: string;
    description: string;
}> = [
    {
        id: 'gpt-image-2',
        title: 'GPT Image 2',
        description: '适合高质量图生图、结构保持和产品细节还原'
    },
    {
        id: 'nano-banana-2',
        title: 'Nano Banana 2',
        description: '适合快速生成、多角度草案和轻量迭代'
    }
];

type ShotLevel = '全景' | '中景' | '近景' | '特写' | '大特写';

interface MultiAngleEditorProps {
    imageUrl?: string;
    sourceTitle?: string;
    appSettings: AppSettings;
    providerId?: string;
    modelId?: string;
    onClose: () => void;
    onGenerate: (prompt: string, config: any) => void;
}

type MultiAngleModelOption = {
    providerId: string;
    providerName: string;
    providerType: string;
    modelId: string;
    modelName: string;
};

const SHOT_LEVELS: ShotLevel[] = ['全景', '中景', '近景', '特写', '大特写'];

const PRESETS = [
    { label: '自定义', horizontal: 0, vertical: 90, shot: 1 },
    { label: '鱼眼视角', horizontal: 20, vertical: 96, shot: 2 },
    { label: '倾斜视角', horizontal: 35, vertical: 68, shot: 2 },
    { label: '正面俯拍', horizontal: 0, vertical: 42, shot: 1 },
    { label: '正面仰拍', horizontal: 0, vertical: 132, shot: 2 },
    { label: '全景俯拍', horizontal: 0, vertical: 38, shot: 0 },
    { label: '背面视角', horizontal: 180, vertical: 90, shot: 1 },
];

const shotScale: Record<ShotLevel, number> = {
    '全景': 0.46,
    '中景': 0.64,
    '近景': 0.82,
    '特写': 1.02,
    '大特写': 1.24,
};

const describeHorizontal = (value: number) => {
    if (value === 0) return '正面视角';
    if (value < 45) return `向右环绕 ${value} 度的三分之四正面视角`;
    if (value < 135) return `右侧 ${value} 度侧面视角`;
    if (value < 225) return `背面 ${value} 度视角`;
    if (value < 315) return `左侧 ${360 - value} 度侧面视角`;
    return `向左环绕 ${360 - value} 度的三分之四正面视角`;
};

const describeVertical = (value: number) => {
    if (value < 70) return `俯拍 ${90 - value} 度`;
    if (value > 110) return `仰拍 ${value - 90} 度`;
    return '平视视角';
};

const describeShot = (shot: ShotLevel) => {
    switch (shot) {
        case '全景': return '主体完整可见，画面留有充足环境空间';
        case '中景': return '主体占据画面中心，保留主要轮廓和关键细节';
        case '近景': return '拉近主体，突出结构、材质和品牌细节';
        case '特写': return '紧密构图，强调局部形态和表面质感';
        case '大特写': return '极近距离构图，放大关键部件与纹理细节';
    }
};

const buildPrompt = (horizontal: number, vertical: number, shot: ShotLevel, sourceTitle?: string) => {
    return [
        '基于参考图片生成新的角度画面。',
        `镜头为${describeHorizontal(horizontal)}，${describeVertical(vertical)}，景别为${shot}。`,
        describeShot(shot),
        '保持原图主体的颜色、材质、比例、结构和核心识别特征一致。',
        '产品级清晰度，真实光影，干净背景，避免新增多余部件或改变品牌标识。'
    ].join(' ');
};

type SpherePoint = {
    x: number;
    y: number;
    z: number;
};

type ProjectedSpherePoint = {
    x: number;
    y: number;
    z: number;
    scale: number;
};

type SpherePath = {
    key: string;
    d: string;
    opacity: number;
    strokeWidth: number;
    dash?: string;
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const rotateSpherePoint = (point: SpherePoint, yaw: number, pitch: number): SpherePoint => {
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);

    const x1 = point.x * cosYaw + point.z * sinYaw;
    const z1 = -point.x * sinYaw + point.z * cosYaw;
    const y1 = point.y;

    return {
        x: x1,
        y: y1 * cosPitch - z1 * sinPitch,
        z: y1 * sinPitch + z1 * cosPitch,
    };
};

const projectSpherePoint = (
    point: SpherePoint,
    yaw: number,
    pitch: number,
    radius: number,
    center: number
): ProjectedSpherePoint => {
    const rotated = rotateSpherePoint(point, yaw, pitch);
    const perspective = 270;
    const scale = perspective / (perspective - rotated.z);

    return {
        x: center + rotated.x * scale,
        y: center - rotated.y * scale,
        z: rotated.z / radius,
        scale,
    };
};

const createSpherePath = (
    key: string,
    points: SpherePoint[],
    yaw: number,
    pitch: number,
    radius: number,
    center: number,
    strokeWidth = 1,
    dash?: string
): SpherePath => {
    const projected = points.map(point => projectSpherePoint(point, yaw, pitch, radius, center));
    const d = projected.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const averageDepth = projected.reduce((sum, point) => sum + point.z, 0) / projected.length;
    const opacity = Math.max(0.18, Math.min(0.58, 0.34 + averageDepth * 0.2));

    return { key, d, opacity, strokeWidth, dash };
};

const createSphereScene = (horizontal: number, vertical: number) => {
    const center = 120;
    const radius = 70;
    const yaw = 0;
    const pitch = 0;
    const paths: SpherePath[] = [];

    for (let longitude = 0; longitude < 360; longitude += 30) {
        const lon = toRadians(longitude);
        const points: SpherePoint[] = [];

        for (let latitude = -90; latitude <= 90; latitude += 6) {
            const lat = toRadians(latitude);
            points.push({
                x: radius * Math.cos(lat) * Math.sin(lon),
                y: radius * Math.sin(lat),
                z: radius * Math.cos(lat) * Math.cos(lon),
            });
        }

        paths.push(createSpherePath(`lon-${longitude}`, points, yaw, pitch, radius, center, longitude % 90 === 0 ? 0.95 : 0.7));
    }

    for (let latitude = -60; latitude <= 60; latitude += 30) {
        const lat = toRadians(latitude);
        const points: SpherePoint[] = [];

        for (let longitude = 0; longitude <= 360; longitude += 6) {
            const lon = toRadians(longitude);
            points.push({
                x: radius * Math.cos(lat) * Math.sin(lon),
                y: radius * Math.sin(lat),
                z: radius * Math.cos(lat) * Math.cos(lon),
            });
        }

        paths.push(createSpherePath(`lat-${latitude}`, points, yaw, pitch, radius, center, latitude === 0 ? 0.95 : 0.7));
    }

    const axisPaths = [
        createSpherePath(
            'axis-vertical',
            Array.from({ length: 49 }, (_, index) => {
                const y = -radius + (index / 48) * radius * 2;
                return { x: 0, y, z: 0 };
            }),
            yaw,
            pitch,
            radius,
            center,
            0.7,
            '3 5'
        ),
        createSpherePath(
            'axis-horizontal',
            Array.from({ length: 61 }, (_, index) => {
                const angle = toRadians(index * 6);
                return { x: radius * Math.sin(angle), y: 0, z: radius * Math.cos(angle) };
            }),
            yaw,
            pitch,
            radius,
            center,
            0.7,
            '3 5'
        ),
    ];

    const cameraLatitude = 90 - vertical;
    const cameraLon = toRadians(horizontal);
    const cameraLat = toRadians(cameraLatitude);
    const highlightMeridianPoints: SpherePoint[] = [];
    const highlightLatitudePoints: SpherePoint[] = [];

    for (let latitude = -90; latitude <= 90; latitude += 3) {
        const lat = toRadians(latitude);
        highlightMeridianPoints.push({
            x: radius * Math.cos(lat) * Math.sin(cameraLon),
            y: radius * Math.sin(lat),
            z: radius * Math.cos(lat) * Math.cos(cameraLon),
        });
    }

    for (let longitude = 0; longitude <= 360; longitude += 3) {
        const lon = toRadians(longitude);
        highlightLatitudePoints.push({
            x: radius * Math.cos(cameraLat) * Math.sin(lon),
            y: radius * Math.sin(cameraLat),
            z: radius * Math.cos(cameraLat) * Math.cos(lon),
        });
    }

    const highlights = [
        createSpherePath('camera-meridian', highlightMeridianPoints, yaw, pitch, radius, center, 1.1),
        createSpherePath('camera-latitude', highlightLatitudePoints, yaw, pitch, radius, center, 1.1),
    ];

    const cameraYaw = toRadians(horizontal);
    const cameraPolar = toRadians(vertical);
    const camera = projectSpherePoint(
        {
            x: radius * Math.sin(cameraPolar) * Math.sin(cameraYaw),
            y: radius * Math.cos(cameraPolar),
            z: radius * Math.sin(cameraPolar) * Math.cos(cameraYaw),
        },
        yaw,
        pitch,
        radius,
        center
    );

    return {
        paths: [...paths, ...axisPaths].sort((a, b) => a.opacity - b.opacity),
        highlights,
        camera,
        center,
        radius,
    };
};

const MultiAngleEditor: React.FC<MultiAngleEditorProps> = ({
    imageUrl,
    sourceTitle,
    appSettings,
    providerId,
    modelId,
    onClose,
    onGenerate
}) => {
    const [activePreset, setActivePreset] = useState('自定义');
    const [horizontal, setHorizontal] = useState(0);
    const [vertical, setVertical] = useState(90);
    const [shotIndex, setShotIndex] = useState(1);
    const [showPrompt, setShowPrompt] = useState(false);
    const [generatedPrompt, setGeneratedPrompt] = useState(() => buildPrompt(0, 90, '中景', sourceTitle));
    const [copied, setCopied] = useState(false);
    const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);

    const shot = SHOT_LEVELS[shotIndex];
    const configuredModelOptions = useMemo<MultiAngleModelOption[]>(() => {
        return (appSettings.imageProviders || []).flatMap(provider =>
            provider.models.map(model => ({
                providerId: provider.id,
                providerName: provider.name,
                providerType: provider.type,
                modelId: model.id,
                modelName: model.displayName || model.id
            }))
        );
    }, [appSettings.imageProviders]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setGeneratedPrompt(buildPrompt(horizontal, vertical, shot, sourceTitle));
        }, 240);

        return () => window.clearTimeout(timer);
    }, [horizontal, vertical, shot, sourceTitle]);

    const previewStyle = useMemo<React.CSSProperties>(() => {
        return {
            transform: `scale(${shotScale[shot]})`,
        };
    }, [shot]);

    const sphereScene = useMemo(() => createSphereScene(horizontal, vertical), [horizontal, vertical]);

    const applyPreset = (preset: typeof PRESETS[number]) => {
        setActivePreset(preset.label);
        setHorizontal(preset.horizontal);
        setVertical(preset.vertical);
        setShotIndex(preset.shot);
    };

    const reset = () => {
        setActivePreset('自定义');
        setHorizontal(0);
        setVertical(90);
        setShotIndex(1);
    };

    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(generatedPrompt);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch (error) {
            console.error('Failed to copy multi-angle prompt', error);
        }
    };

    const handleGenerate = (model: MultiAngleModelOption) => {
        setIsModelPickerOpen(false);
        onGenerate(generatedPrompt, {
            providerId: model.providerId,
            model: model.modelId,
            aspectRatio: '1:1',
            aspect_ratio: '1:1',
            resolution: '2k',
            size: '2k',
            batchSize: 1
        });
    };

    const handleOpenModelPicker = () => {
        if (configuredModelOptions.length === 0) {
            onGenerate(generatedPrompt, {
                configError: '当前没有配置图像生成模型。请先到设置 > 图像生成 添加 API 和模型。',
                aspectRatio: '1:1',
                aspect_ratio: '1:1',
                resolution: '2k',
                size: '2k',
                batchSize: 1
            });
            return;
        }

        setIsModelPickerOpen(true);
    };

    const handlePanelMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
    };

    const handleModelListWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        e.stopPropagation();
        e.currentTarget.scrollTop += e.deltaY;
    };

    return (
        <div
            className="relative w-[600px] rounded-lg border border-zinc-700/80 bg-[#242424]/98 shadow-2xl text-zinc-200 overflow-hidden backdrop-blur-xl"
            onMouseDown={handlePanelMouseDown}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
        >
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
                <h3 className="text-sm font-bold text-white">多角度编辑器</h3>
                <button
                    onClick={onClose}
                    className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700/60 transition-colors"
                    title="关闭"
                >
                    <XIcon className="w-5 h-5" />
                </button>
            </div>

            <div className="flex gap-2 px-5 pb-3 overflow-x-auto custom-scrollbar">
                {PRESETS.map((preset) => (
                    <button
                        key={preset.label}
                        onClick={() => applyPreset(preset)}
                        className={`shrink-0 px-3 py-1.5 rounded-md border text-xs transition-all ${activePreset === preset.label
                            ? 'bg-zinc-100 text-zinc-900 border-zinc-100 font-bold'
                            : 'bg-zinc-900/20 border-zinc-700/70 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500'
                            }`}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>

            <div className="grid grid-cols-[240px_1fr] gap-4 px-5 pb-4">
                <div className="relative h-[240px] w-[240px] min-w-[240px] self-start rounded-lg bg-[#373737] overflow-hidden flex items-center justify-center">
                    <svg
                        className="absolute inset-0 z-10 h-full w-full text-zinc-500/70 drop-shadow-[0_14px_22px_rgba(0,0,0,0.28)]"
                        viewBox="0 0 240 240"
                    >
                        <defs>
                            <radialGradient id="multiAngleGlobeShade" cx="36%" cy="28%" r="72%">
                                <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
                                <stop offset="55%" stopColor="rgba(255,255,255,0.02)" />
                                <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
                            </radialGradient>
                        </defs>
                        <circle
                            cx={sphereScene.center}
                            cy={sphereScene.center}
                            r={sphereScene.radius}
                            fill="url(#multiAngleGlobeShade)"
                            stroke="currentColor"
                            strokeWidth="1.15"
                            opacity="0.7"
                        />
                        {sphereScene.paths.map(path => (
                            <path
                                key={path.key}
                                d={path.d}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={path.strokeWidth}
                                strokeDasharray={path.dash}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity={path.opacity}
                                className="transition-all duration-200 ease-out"
                            />
                        ))}
                        {sphereScene.highlights.map(path => (
                            <path
                                key={path.key}
                                d={path.d}
                                fill="none"
                                stroke="#22d3ee"
                                strokeWidth={path.strokeWidth}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                opacity={0.38}
                                className="transition-all duration-200 ease-out"
                            />
                        ))}
                    </svg>

                    <div className="relative z-20 w-[86px] h-[86px] flex items-center justify-center transition-transform duration-200 [transform-style:preserve-3d]" style={previewStyle}>
                        {imageUrl ? (
                            <img
                                src={imageUrl}
                                alt="多角度参考图"
                                className="max-w-full max-h-full object-contain rounded-sm border border-white/20 shadow-[0_12px_35px_rgba(0,0,0,0.45)] bg-black/20"
                            />
                        ) : (
                            <div className="w-16 h-16 rounded-md border border-dashed border-zinc-600 bg-zinc-800/50" />
                        )}
                    </div>

                    <div
                        className="absolute z-30 h-3.5 w-3.5 rounded-full border-2 border-cyan-100 bg-cyan-400 shadow-[0_0_0_4px_rgba(34,211,238,0.16),0_0_18px_rgba(34,211,238,0.9)] transition-all duration-200 ease-out"
                        style={{
                            left: `${sphereScene.camera.x}px`,
                            top: `${sphereScene.camera.y}px`,
                            opacity: 0.72 + Math.max(sphereScene.camera.z, 0) * 0.28,
                            transform: `translate(-50%, -50%) scale(${0.88 + Math.max(sphereScene.camera.z, 0) * 0.28})`,
                        }}
                        title="摄像机位置"
                    />

                </div>

                <div className="flex flex-col min-w-0">
                    <div className="space-y-5 pt-2">
                        <ControlSlider
                            label="水平环绕"
                            min={0}
                            max={359}
                            value={horizontal}
                            suffix="°"
                            onChange={(value) => {
                                setActivePreset('自定义');
                                setHorizontal(value);
                            }}
                        />
                        <ControlSlider
                            label="垂直俯仰"
                            min={0}
                            max={180}
                            value={vertical}
                            suffix="°"
                            onChange={(value) => {
                                setActivePreset('自定义');
                                setVertical(value);
                            }}
                        />
                        <ControlSlider
                            label="景别缩放"
                            min={0}
                            max={4}
                            value={shotIndex}
                            valueLabel={shot}
                            onChange={(value) => {
                                setActivePreset('自定义');
                                setShotIndex(value);
                            }}
                        />
                    </div>

                    <div className="mt-5 flex items-center gap-3">
                        <span className="text-xs text-zinc-500">提示词</span>
                        <button
                            onClick={() => setShowPrompt(!showPrompt)}
                            className={`relative h-4 w-8 rounded-full transition-colors ${showPrompt ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                            title="显示提示词"
                        >
                            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-zinc-200 shadow-sm transition-all ${showPrompt ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                    </div>

                    {showPrompt && (
                        <div className="mt-3 rounded-lg border border-zinc-700/70 bg-zinc-950/35 p-3">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] text-zinc-500">自动提示词</span>
                                <button
                                    onClick={copyPrompt}
                                    className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-cyan-300"
                                    title="复制提示词"
                                >
                                    <CopyIcon className="w-3 h-3" />
                                    <span>{copied ? '已复制' : '复制'}</span>
                                </button>
                            </div>
                            <textarea
                                value={generatedPrompt}
                                onChange={(e) => setGeneratedPrompt(e.target.value)}
                                className="w-full h-20 resize-none bg-transparent text-xs leading-relaxed text-zinc-300 outline-none custom-scrollbar"
                            />
                        </div>
                    )}

                    <div className="mt-auto flex items-end justify-between pt-4">
                        <button
                            onClick={reset}
                            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                        >
                            <RefreshCwIcon className="w-3.5 h-3.5" />
                            <span>重置参数</span>
                        </button>

                        <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1 text-xs text-zinc-500">
                                <span className="text-cyan-300">▴</span>
                                1
                            </span>
                            <button
                                onClick={handleOpenModelPicker}
                                className="flex h-8 items-center gap-2 rounded-md bg-zinc-100 px-3 text-xs font-bold text-zinc-900 hover:bg-white active:scale-95 transition-all"
                            >
                                <Wand2Icon className="w-3.5 h-3.5" />
                                <span>生成</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {isModelPickerOpen && (
                <div
                    className="absolute inset-0 z-[80] flex items-center justify-center bg-black/55 px-5 backdrop-blur-sm"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setIsModelPickerOpen(false)}
                >
                    <div
                        className="w-full max-w-[420px] rounded-lg border border-zinc-700 bg-zinc-950/95 p-4 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <div>
                                <h4 className="text-sm font-bold text-white">选择生成模型</h4>
                                <p className="mt-1 text-xs text-zinc-500">请选择本次多角度生成使用的模型配置</p>
                            </div>
                            <button
                                onClick={() => setIsModelPickerOpen(false)}
                                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
                                title="关闭"
                            >
                                <XIcon className="h-4 w-4" />
                            </button>
                        </div>

                        <div
                            className="max-h-[300px] overflow-y-auto overscroll-contain pr-1 custom-scrollbar grid gap-2"
                            onWheel={handleModelListWheel}
                        >
                            {configuredModelOptions.length === 0 ? (
                                <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">
                                    当前设置里还没有图像生成模型。请先到设置 &gt; 图像生成 添加 API 和模型。
                                </div>
                            ) : configuredModelOptions.map((model) => {
                                const isCurrent = model.providerId === providerId && model.modelId === modelId;
                                return (
                                    <button
                                        key={`${model.providerId}:${model.modelId}`}
                                        onClick={() => handleGenerate(model)}
                                        className={`rounded-lg border p-3 text-left transition-all ${isCurrent
                                            ? 'border-cyan-400/70 bg-cyan-500/15'
                                            : 'border-zinc-700 bg-zinc-900/80 hover:border-cyan-400/70 hover:bg-cyan-500/10'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-sm font-bold text-zinc-100">{model.modelName}</span>
                                            <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">
                                                {model.providerType}
                                            </span>
                                        </div>
                                        <p className="mt-1 truncate text-[11px] text-zinc-500">{model.modelId}</p>
                                        <p className="mt-1 text-xs leading-5 text-zinc-400">{model.providerName}</p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

interface ControlSliderProps {
    label: string;
    min: number;
    max: number;
    value: number;
    suffix?: string;
    valueLabel?: string;
    onChange: (value: number) => void;
}

const ControlSlider: React.FC<ControlSliderProps> = ({
    label,
    min,
    max,
    value,
    suffix = '',
    valueLabel,
    onChange
}) => {
    const percent = ((value - min) / (max - min)) * 100;

    return (
        <label className="grid grid-cols-[64px_1fr_48px] items-center gap-3 text-xs">
            <span className="text-zinc-500">{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                step={1}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-500 accent-cyan-400"
                style={{ background: `linear-gradient(to right, #22d3ee 0%, #22d3ee ${percent}%, #9ca3af ${percent}%, #9ca3af 100%)` }}
            />
            <span className="text-right text-zinc-100">{valueLabel || `${value}${suffix}`}</span>
        </label>
    );
};

export default MultiAngleEditor;
