import React, { useState, useRef, useCallback } from 'react';
import { NodeData } from '../types';
import { AppSettings } from '../types/settings';
import { DownloadIcon, MaximizeIcon, SparklesIcon, UploadIcon, PlayIcon, TypeIcon, InfoIcon, FontSizePlusIcon, FontSizeMinusIcon, MoveIcon, AudioIcon, ScissorsIcon } from './Icons';
import MultiAngleEditor from './MultiAngleEditor';
import PromptPanel, { UpstreamImage } from './PromptPanel';

const REMOTE_IMAGE_MAX_RETRIES = 12;

interface NodeProps {
    data: NodeData;
    scale: number;
    isSelected: boolean;
    showPanel?: boolean; // New prop
    appSettings: AppSettings; // For provider/model selection
    onMouseDown: (e: React.MouseEvent, nodeId: string) => void;
    onNodeClick?: (e: React.MouseEvent, nodeId: string) => void; // Explicit click handler for logic separation
    onDoubleClick?: (nodeId: string) => void; // Double click handler for focus/zoom
    onConnectStart: (e: React.MouseEvent, nodeId: string, handleType: 'source' | 'target') => void;
    onConnectEnd: (e: React.MouseEvent, nodeId: string, handleType: 'source' | 'target') => void;
    onGenerate: (nodeId: string, prompt: string, config: any) => void;
    onMaximize?: (url: string, type: 'image' | 'video') => void;
    onUpload?: (nodeId: string, dataUrl: string) => void;
    onDownload?: (nodeId: string) => void;
    onRemoveBackground?: (nodeId: string) => void;
    onResize?: (id: string, width: number, height: number, imageSize?: { width: number; height: number }) => void;
    onContextMenu?: (e: React.MouseEvent, id: string) => void;
    onPromptChange?: (nodeId: string, prompt: string) => void;
    onParamsChange?: (nodeId: string, params: any) => void;
    onContentChange?: (nodeId: string, content: string) => void;
    onDismissError?: (nodeId: string) => void;
    onTitleChange?: (nodeId: string, title: string) => void;
    onProviderChange?: (nodeId: string, providerId: string) => void;
    onModelChange?: (nodeId: string, modelId: string) => void;
    isAutoResize?: boolean;
    getFinalPrompt?: (nodeId: string) => string;
    onImageSwitch?: (nodeId: string, imageIndex: number) => void;
    onFontSizeChange?: (nodeId: string, fontSize: number) => void;
    onMultiAngleGenerate?: (nodeId: string, prompt: string, config: any) => void;
    upstreamImages?: UpstreamImage[];
}

const Node = React.memo(({
    data,
    scale,
    isSelected,
    showPanel,
    appSettings,
    onMouseDown,
    onNodeClick,
    onDoubleClick,
    onConnectStart,
    onConnectEnd,
    onGenerate,
    onMaximize,
    onUpload,
    onDownload,
    onRemoveBackground,
    onResize,
    onContextMenu,
    onPromptChange,
    onParamsChange,
    onContentChange,
    onDismissError,
    onTitleChange,
    onProviderChange,
    onModelChange,
    isAutoResize,
    getFinalPrompt,
    onImageSwitch,
    onFontSizeChange,
    onMultiAngleGenerate,
    upstreamImages = []
}: NodeProps) => {
    const [hovered, setHovered] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInputValue, setTitleInputValue] = useState('');
    const [showFinalPrompt, setShowFinalPrompt] = useState(false);
    const [isMultiAngleOpen, setIsMultiAngleOpen] = useState(false);
    const [copiedError, setCopiedError] = useState(false);
    const [imageRetryNonce, setImageRetryNonce] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const imageRetryCountRef = useRef<Record<string, number>>({});
    const imageRetryTimerRef = useRef<number | null>(null);

    React.useEffect(() => {
        if (imageRetryTimerRef.current) {
            window.clearTimeout(imageRetryTimerRef.current);
            imageRetryTimerRef.current = null;
        }
        setImageRetryNonce(0);
        imageRetryCountRef.current = {};
    }, [data.content]);

    React.useEffect(() => {
        return () => {
            if (imageRetryTimerRef.current) {
                window.clearTimeout(imageRetryTimerRef.current);
            }
        };
    }, []);

    const imageDisplaySrc = (() => {
        const content = data.content || '';
        if (!imageRetryNonce || !/^https?:\/\//i.test(content)) return content;
        return `/api/openai-download-proxy?url=${encodeURIComponent(content)}&display=1&attempt=${imageRetryNonce}`;
    })();

    // Stop wheel propagation natively to prevent canvas zoom
    React.useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (e: WheelEvent) => {
            e.stopPropagation();
            // We don't prevent default, so scrolling still occurs
        };

        textarea.addEventListener('wheel', handleWheel, { passive: false });
        return () => textarea.removeEventListener('wheel', handleWheel);
    }, [data.type, data.content]); // Re-bind if type or content changes

    React.useEffect(() => {
        if (!isSelected) {
            setIsMultiAngleOpen(false);
        }
    }, [isSelected]);

    // Position styles
    const style: React.CSSProperties = {
        left: data.position.x,
        top: data.position.y,
        width: data.width,
        height: data.height,
        zIndex: isSelected ? 50 : 10,
        contain: 'layout style', // Optimization: Scope layout/style calculations
    };

    // ... Handlers ...

    const handleTitleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsEditingTitle(true);
        setTitleInputValue(data.title || '');
    };

    const handleTitleBlur = () => {
        setIsEditingTitle(false);
        if (titleInputValue !== data.title && onTitleChange) {
            onTitleChange(data.id, titleInputValue);
        }
    };

    const handleTitleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleTitleBlur();
        }
    };

    const handleUploadClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && onUpload) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const result = ev.target?.result as string;
                if (result) {
                    onUpload(data.id, result);
                }
            };
            reader.readAsDataURL(file);
        }
        // Reset input
        if (e.target) e.target.value = '';
    };

    const handleDownload = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (onDownload) {
            onDownload(data.id);
        }
    };

    const handleMaximize = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (data.content && onMaximize) {
            onMaximize(data.content, data.type === 'video' ? 'video' : 'image');
        }
    };

    const handleRemoveBackground = (e: React.MouseEvent) => {
        e.stopPropagation();
        onRemoveBackground?.(data.id);
    };

    const handleFontSizeChange = (e: React.MouseEvent, delta: number) => {
        e.stopPropagation();
        if (onFontSizeChange) {
            const currentSize = data.fontSize || 14; // 榛樿 14px
            const newSize = Math.max(10, Math.min(32, currentSize + delta)); // 闄愬埗鍦?10-32px 涔嬮棿
            onFontSizeChange(data.id, newSize);
        }
    };


    // Resize Handle State
    const resizeRef = useRef<{
        isResizing: boolean;
        startX: number;
        startY: number;
        startWidth: number;
        startHeight: number;
    }>({ isResizing: false, startX: 0, startY: 0, startWidth: 0, startHeight: 0 });

    const handleResizeMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();

        resizeRef.current = {
            isResizing: true,
            startX: e.clientX,
            startY: e.clientY,
            startWidth: data.width,
            startHeight: data.height
        };

        window.addEventListener('mousemove', handleResizeMove);
        window.addEventListener('mouseup', handleResizeUp);
    };

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!resizeRef.current.isResizing || !onResize) return;

        const dx = (e.clientX - resizeRef.current.startX) / scale; // Adjust for viewport scale
        const dy = (e.clientY - resizeRef.current.startY) / scale;

        const newWidth = Math.max(200, resizeRef.current.startWidth + dx); // Min 200px
        const newHeight = Math.max(150, resizeRef.current.startHeight + dy); // Min 150px

        onResize(data.id, newWidth, newHeight);
    }, [data.id, onResize, scale]);

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener('mousemove', handleResizeMove);
        window.removeEventListener('mouseup', handleResizeUp);
    }, [handleResizeMove]);

    // Cleanup listeners on unmount
    React.useEffect(() => {
        return () => {
            window.removeEventListener('mousemove', handleResizeMove);
            window.removeEventListener('mouseup', handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);


    const errorMessage = data.errorDetails || data.title?.replace('错误: ', '').replace('Error: ', '') || 'An unknown error occurred';
    const imageSizeLabel = data.type === 'image' && data.imageWidth && data.imageHeight
        ? `${Math.round(data.imageWidth)} × ${Math.round(data.imageHeight)}`
        : '';

    const handleCopyError = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(errorMessage);
            setCopiedError(true);
            window.setTimeout(() => setCopiedError(false), 1200);
        } catch (error) {
            console.error('Failed to copy error details', error);
        }
    };

    return (
        <div
            data-node-id={data.id}
            className={`node-element absolute flex flex-col group transition-shadow duration-200 ${data.type === 'text' ? '' : 'select-none'} ${isSelected ? 'z-50' : 'z-10'}`}
            style={style}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onContextMenu={(e) => onContextMenu?.(e, data.id)}
        >
            {/* Floating Label */}
            {isEditingTitle ? (
                <input
                    autoFocus
                    className="absolute -top-7 left-1 w-[220px] max-w-[60%] text-[10px] text-zinc-200 font-medium px-2 py-0.5 bg-zinc-900 border border-cyan-500 rounded-full outline-none shadow-lg z-40 pointer-events-auto"
                    value={titleInputValue}
                    onChange={(e) => setTitleInputValue(e.target.value)}
                    onBlur={handleTitleBlur}
                    onKeyDown={handleTitleKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                />
            ) : (
                <div
                    className="absolute -top-7 left-1 max-w-[60%] truncate text-[10px] text-zinc-400 font-medium px-2 py-0.5 bg-zinc-900/80 rounded-full border border-zinc-800 pointer-events-auto cursor-text whitespace-nowrap shadow-sm backdrop-blur-sm z-40"
                    onDoubleClick={handleTitleDoubleClick}
                    title="Double-click to rename"
                >
                    {data.title || 'Untitled'}
                </div>
            )}

            {isSelected && data.type === 'image' && (
                <div
                    className="absolute -top-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 pointer-events-auto"
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setIsMultiAngleOpen(prev => !prev);
                        }}
                        className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold shadow-xl backdrop-blur-md transition-all ${isMultiAngleOpen
                            ? 'bg-cyan-500/15 border-cyan-400/60 text-cyan-200'
                            : 'bg-zinc-900/95 border-zinc-700/80 text-zinc-200 hover:border-cyan-400/60 hover:text-cyan-200'
                            }`}
                        title="打开多角度编辑器"
                    >
                        <MoveIcon className="w-3.5 h-3.5" />
                        <span>多角度</span>
                    </button>
                    {data.content && (
                        <button
                            onClick={handleRemoveBackground}
                            className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/95 px-3 py-1.5 text-xs font-bold text-zinc-200 shadow-xl backdrop-blur-md transition-all hover:border-emerald-400/60 hover:text-emerald-200"
                            title="去背景"
                        >
                            <ScissorsIcon className="w-3.5 h-3.5" />
                            <span>去背景</span>
                        </button>
                    )}
                </div>
            )}
            {/* Node Visual Body */}
            <div
                className={`
                relative bg-zinc-900 rounded-3xl overflow-hidden
                border-2 ${isSelected ? 'border-cyan-500' : 'border-zinc-800 hover:border-zinc-600'}
                w-full h-full
            `}
                onMouseDown={(e) => onMouseDown(e, data.id)}
                onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (onDoubleClick) {
                        onDoubleClick(data.id);
                    }
                }}
            >
                {/* ... existing content ... */}

                {/* Resize Handle */}
                <div
                    className={`absolute bottom-0 right-0 w-6 h-6 z-50 cursor-se-resize flex items-end justify-end p-1 ${hovered || isSelected ? 'opacity-100' : 'opacity-0'} transition-opacity`}
                    onMouseDown={handleResizeMouseDown}
                >
                    <div className="w-2 h-2 bg-zinc-600 rounded-br-lg rounded-tl-sm group-hover:bg-cyan-500 transition-colors" />
                </div>

                {/* Hidden File Input */}
                <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileChange}
                />

                {/* Header / Tools (Visible on hover) */}
                <div className={`absolute top-2 left-2 flex gap-1 z-20 transition-opacity duration-200 ${hovered ? 'opacity-100' : 'opacity-0'}`}>
                    {/* Upload Button - Visible only for media */}
                    {(data.type === 'image' || data.type === 'video') && (
                        <button
                            className="p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-300"
                            onClick={handleUploadClick}
                            title="Upload / Replace Image"
                        >
                            <UploadIcon className="w-3 h-3" />
                        </button>
                    )}

                    {/* Text Icon for Text Nodes */}
                    {data.type === 'text' && (
                        <div className="p-1.5 bg-zinc-800/80 rounded-lg text-cyan-500">
                            <TypeIcon className="w-3 h-3" />
                        </div>
                    )}

                    {data.type === 'audio' && (
                        <div className="p-1.5 bg-zinc-800/80 rounded-lg text-amber-400">
                            <AudioIcon className="w-3 h-3" />
                        </div>
                    )}

                    {/* Font Size Controls - Visible only for text nodes */}
                    {data.type === 'text' && (
                        <>
                            <button
                                className="p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-300"
                                onClick={(e) => handleFontSizeChange(e, -2)}
                                title="鍑忓皬瀛椾綋"
                            >
                                <FontSizeMinusIcon className="w-3 h-3" />
                            </button>
                            <div className="px-2 py-1.5 bg-zinc-800/80 rounded-lg text-[10px] text-zinc-400 font-mono">
                                {data.fontSize || 14}px
                            </div>
                            <button
                                className="p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-300"
                                onClick={(e) => handleFontSizeChange(e, 2)}
                                title="澧炲ぇ瀛椾綋"
                            >
                                <FontSizePlusIcon className="w-3 h-3" />
                            </button>
                        </>
                    )}

                    {/* Download & Maximize - Visible only if content exists */}
                    {data.content && (
                        <>
                            <button
                                className="p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-300"
                                onClick={handleDownload}
                                title="Download Content"
                            >
                                <DownloadIcon className="w-3 h-3" />
                            </button>
                            {data.type !== 'text' && data.type !== 'audio' && (
                                <button
                                    className="p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-300"
                                    onClick={handleMaximize}
                                    title="View Full Size"
                                >
                                    <MaximizeIcon className="w-3 h-3" />
                                </button>
                            )}
                        </>
                    )}
                </div>




                {/* Content Area */}
                <div className="relative w-full h-full flex items-center justify-center bg-zinc-950/50">

                    {
                        data.status === 'loading' ? (
                            <div className="flex flex-col items-center gap-3">
                                <div className="relative flex h-16 w-16 items-center justify-center">
                                    <div className="absolute inset-0 rounded-full bg-cyan-400/10 blur-xl animate-pulse" />
                                    <div className="absolute inset-1 rounded-full border border-cyan-300/20 border-t-cyan-300/70 animate-spin" />
                                    <div className="absolute inset-2 rounded-full border border-transparent border-b-cyan-200/40 animate-spin [animation-duration:1.8s] [animation-direction:reverse]" />
                                    {/* Circular Progress Bar */}
                                    <svg className="relative z-10 w-12 h-12 -rotate-90 transform drop-shadow-[0_0_18px_rgba(34,211,238,0.28)]" viewBox="0 0 48 48">
                                        {/* Track */}
                                        <circle
                                            cx="24"
                                            cy="24"
                                            r="18"
                                            fill="none"
                                            stroke="currentColor"
                                            className="text-zinc-800/90"
                                            strokeWidth="3"
                                        />
                                        {/* Indicator */}
                                        <circle
                                            cx="24"
                                            cy="24"
                                            r="18"
                                            fill="none"
                                            stroke="currentColor"
                                            className="text-cyan-400 transition-all duration-500 ease-out"
                                            strokeWidth="3"
                                            strokeLinecap="round"
                                            // Circumference = 2 * pi * 18 鈮?113.1
                                            strokeDasharray="113.1"
                                            strokeDashoffset={113.1 - (113.1 * (data.progress || 0)) / 100}
                                        />
                                    </svg>

                                    <div className="absolute z-20 flex flex-col items-center justify-center">
                                        {/* Percentage text inside circle */}
                                        <span className="text-[10px] text-cyan-300 font-bold font-mono tabular-nums">
                                            {data.progress || 0}%
                                        </span>
                                    </div>
                                </div>
                                <div className="flex flex-col items-center gap-1">
                                    <span className="text-[11px] text-cyan-200/90 font-semibold tracking-wide animate-pulse">生成中</span>
                                    <span className="text-[10px] text-zinc-500">正在等待模型返回结果</span>
                                </div>
                            </div>
                        ) : data.status === 'error' ? (
                            <div className="flex h-full min-h-0 flex-col gap-3 p-4 text-left">
                                <div className="flex items-center gap-3">
                                    <div className="w-9 h-9 shrink-0 rounded-full bg-red-500/10 flex items-center justify-center border border-red-500/20">
                                        <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                        </svg>
                                    </div>
                                    <div className="min-w-0">
                                        <span className="block text-xs font-bold text-red-400 uppercase tracking-widest">Generation Failed</span>
                                        <span className="block truncate text-[10px] text-zinc-500">完整错误信息可在下方滚动查看</span>
                                    </div>
                                </div>
                                <div
                                    className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-red-500/20 bg-red-950/10 p-3 font-mono text-[11px] leading-relaxed text-zinc-300 custom-scrollbar whitespace-pre-wrap break-words select-text"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onWheel={(e) => e.stopPropagation()}
                                >
                                    {errorMessage}
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onGenerate(data.id, data.prompt || '', data.params);
                                        }}
                                        className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-full text-[10px] font-bold transition-colors border border-zinc-700"
                                    >
                                        Try Again
                                    </button>
                                    <button
                                        onClick={handleCopyError}
                                        className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-full text-[10px] font-bold transition-colors border border-zinc-700"
                                    >
                                        {copiedError ? 'Copied' : 'Copy Error'}
                                    </button>
                                    {data.type === 'text' && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDismissError?.(data.id);
                                            }}
                                            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-full text-[10px] font-bold transition-colors border border-zinc-700"
                                        >
                                            Confirm
                                        </button>
                                    )}
                                </div>
                            </div>
                        ) : data.type === 'text' ? (
                            <div className="w-full h-full flex flex-col pt-8 bg-zinc-900/30 overflow-hidden">
                                <textarea
                                    ref={textareaRef}
                                    className="w-full h-full px-4 pb-4 bg-transparent text-zinc-300 resize-none outline-none border-none placeholder-zinc-700 leading-relaxed font-mono select-auto overflow-y-auto custom-scrollbar"
                                    style={{ fontSize: `${data.fontSize || 14}px` }}
                                    placeholder="Start typing your content here... Use the panel below to let AI transform or extend this text."
                                    value={data.content || ''}
                                    onChange={(e) => onContentChange?.(data.id, e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onWheel={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                        // Stop propagation for certain keys so global shortcuts don't trigger
                                        if (e.key === 'Delete' || e.key === 'Backspace' || e.key === ' ') {
                                            e.stopPropagation();
                                        }
                                    }}
                                />
                            </div>
                        ) : data.type === 'audio' && data.content ? (
                            <div className="relative flex h-full w-full flex-col items-center justify-center gap-5 bg-[radial-gradient(circle_at_center,rgba(245,158,11,0.14),transparent_55%)] px-6">
                                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-400/25 bg-amber-500/10 text-amber-300 shadow-[0_0_28px_rgba(245,158,11,0.12)]">
                                    <AudioIcon className="h-8 w-8" />
                                </div>
                                <div className="flex h-14 w-full max-w-[240px] items-center justify-center gap-1.5">
                                    {Array.from({ length: 18 }).map((_, index) => (
                                        <div
                                            key={index}
                                            className="w-1.5 rounded-full bg-amber-300/70"
                                            style={{ height: `${18 + ((index * 11) % 32)}px` }}
                                        />
                                    ))}
                                </div>
                                <audio
                                    src={data.content}
                                    controls
                                    className="w-full max-w-[260px] opacity-90"
                                    onMouseDown={(e) => e.stopPropagation()}
                                />
                            </div>
                        ) : data.content ? (
                            data.type === 'video' ? (
                                <div className="relative w-full h-full group/video">
                                    <video
                                        key={data.content}
                                        ref={videoRef}
                                        src={data.content}
                                        className="w-full h-full object-cover block"
                                        controls={isPlaying}
                                        loop
                                        playsInline
                                        onPlay={() => setIsPlaying(true)}
                                        onPause={() => setIsPlaying(false)}
                                        onLoadedMetadata={(e) => {
                                            if (isAutoResize && onResize) {
                                                const vid = e.currentTarget;
                                                const aspect = vid.videoWidth / vid.videoHeight;
                                                const height = data.width / aspect;
                                                if (Math.abs(height - data.height) > 1) {
                                                    onResize(data.id, data.width, height);
                                                }
                                            }
                                        }}
                                    />
                                    {!isPlaying && (
                                        <div
                                            className="absolute inset-0 flex items-center justify-center bg-black/10 z-10 pointer-events-none"
                                        >
                                            <div
                                                className="p-3 rounded-full bg-white/20 backdrop-blur-sm border border-white/30 shadow-lg cursor-pointer pointer-events-auto transition-transform duration-200 hover:scale-110 active:scale-95"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setIsPlaying(true);
                                                    videoRef.current?.play();
                                                }}
                                                onMouseDown={(e) => e.stopPropagation()}
                                            >
                                                <PlayIcon className="w-8 h-8 text-white drop-shadow-md" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div
                                    className="relative w-full h-full"
                                    onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        if (data.content && onMaximize) {
                                            onMaximize(data.content, 'image');
                                        }
                                    }}
                                >
                                    {imageSizeLabel && (
                                        <div
                                            className="absolute right-2 top-2 z-20 rounded-md border border-white/10 bg-black/65 px-2 py-1 font-mono text-[10px] font-semibold text-white/85 shadow-lg backdrop-blur-sm"
                                            title={`图片尺寸：${imageSizeLabel}`}
                                        >
                                            {imageSizeLabel}
                                        </div>
                                    )}
                                    <img
                                        key={`${data.id}:${data.content}:${imageRetryNonce}`}
                                        src={imageDisplaySrc}
                                        alt="Node content"
                                        className="w-full h-full object-contain block select-none pointer-events-none"
                                        onError={() => {
                                            if (!data.content || !/^https?:\/\//i.test(data.content)) return;
                                            const retryCount = imageRetryCountRef.current[data.content] || 0;
                                            if (retryCount >= REMOTE_IMAGE_MAX_RETRIES) return;
                                            imageRetryCountRef.current[data.content] = retryCount + 1;
                                            if (imageRetryTimerRef.current) {
                                                window.clearTimeout(imageRetryTimerRef.current);
                                            }
                                            const delay = Math.min(600 * (retryCount + 1), 5000);
                                            imageRetryTimerRef.current = window.setTimeout(() => {
                                                imageRetryTimerRef.current = null;
                                                setImageRetryNonce(Date.now());
                                            }, delay);
                                        }}
                                        onLoad={(e) => {
                                            if (imageRetryTimerRef.current) {
                                                window.clearTimeout(imageRetryTimerRef.current);
                                                imageRetryTimerRef.current = null;
                                            }
                                            if (data.content) {
                                                imageRetryCountRef.current[data.content] = 0;
                                            }
                                            if (!onResize) return;

                                            const img = e.currentTarget;
                                            const imageWidth = img.naturalWidth || img.width;
                                            const imageHeight = img.naturalHeight || img.height;
                                            if (!imageWidth || !imageHeight) return;

                                            const hasSameImageSize = data.imageWidth === imageWidth && data.imageHeight === imageHeight;
                                            if (hasSameImageSize) return;

                                            if (isAutoResize) {
                                                const aspect = imageWidth / imageHeight;
                                                const height = data.width / aspect;
                                                if (Number.isFinite(height)) {
                                                    onResize(data.id, data.width, height, { width: imageWidth, height: imageHeight });
                                                }
                                                return;
                                            }

                                            onResize(data.id, data.width, data.height, { width: imageWidth, height: imageHeight });
                                        }}
                                    />

                                    {/* 澶氬浘鏁板瓧閫夋嫨鍣?*/}
                                    {data.allImages && data.allImages.length > 1 && (
                                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5 border border-white/10">
                                            {/* 鍥剧墖璁℃暟 */}
                                            <span className="text-[10px] text-white/70 font-medium">
                                                {(data.currentImageIndex ?? 0) + 1}/{data.allImages.length}
                                            </span>

                                            <div className="w-px h-3 bg-white/20" />

                                            {/* 鏁板瓧鎸夐挳 */}
                                            <div className="flex gap-1">
                                                {data.allImages.map((_, idx) => (
                                                    <button
                                                        key={idx}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onImageSwitch?.(data.id, idx);
                                                        }}
                                                        onMouseDown={(e) => e.stopPropagation()}
                                                        className={`
                                                            w-6 h-6 rounded-md text-[10px] font-bold transition-all
                                                            ${idx === (data.currentImageIndex ?? 0)
                                                                ? 'bg-cyan-500 text-white shadow-lg shadow-cyan-500/50 scale-110'
                                                                : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                                                            }
                                                        `}
                                                        title={`鍒囨崲鍒板浘鐗?${idx + 1}`}
                                                    >
                                                        {idx + 1}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        ) : (
                            <div className="text-zinc-600 flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-2xl bg-zinc-800/50 flex items-center justify-center">
                                    {data.type === 'audio' ? <AudioIcon className="w-5 h-5 opacity-25" /> : <SparklesIcon className="w-5 h-5 opacity-20" />}
                                </div>
                                <span className="text-[10px] uppercase tracking-widest opacity-40">{data.type === 'audio' ? 'Empty Audio' : 'Empty Canvas'}</span>
                            </div>
                        )
                    }
                </div>

                {/* Overlay Gradient for Text readability if needed */}
                <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />

                {/* Final Prompt Info Icon (Bottom Center) */}
                {(data.prompt || getFinalPrompt) && (
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-30">
                        <div
                            className="relative p-1.5 bg-zinc-800/80 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-cyan-400 cursor-help transition-all"
                            onMouseEnter={() => setShowFinalPrompt(true)}
                            onMouseLeave={() => setShowFinalPrompt(false)}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="查看最终提示词"
                        >
                            <InfoIcon className="w-3 h-3" />

                            {/* Final Prompt Tooltip */}
                            {showFinalPrompt && (
                                <div
                                    className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-80 max-w-[80vw] p-3 bg-zinc-900/95 border border-zinc-700 rounded-lg shadow-xl z-50 pointer-events-none backdrop-blur-sm"
                                    style={{ wordBreak: 'break-word' }}
                                >
                                    <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1.5">最终提示词</div>
                                    <div className="text-xs text-zinc-300 leading-relaxed max-h-60 overflow-auto custom-scrollbar whitespace-pre-wrap">
                                        {getFinalPrompt ? getFinalPrompt(data.id) : data.prompt}
                                    </div>
                                    {/* Arrow */}
                                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-zinc-900 border-r border-b border-zinc-700 rotate-45" />
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Embedded Prompt Panel (Visible when selected) - Absolute positioning to not affect height */}
            {showPanel && (
                <div className={`absolute top-full pt-4 z-50 cursor-auto ${isMultiAngleOpen && data.type === 'image' ? 'left-1/2 w-[600px] -translate-x-1/2' : 'left-0 w-full'}`}>
                    {isMultiAngleOpen && data.type === 'image' ? (
                        <MultiAngleEditor
                            imageUrl={data.content}
                            sourceTitle={data.title}
                            appSettings={appSettings}
                            providerId={data.providerId}
                            modelId={data.modelId}
                            onClose={() => setIsMultiAngleOpen(false)}
                            onGenerate={(prompt, config) => {
                                onMultiAngleGenerate?.(data.id, prompt, config);
                                setIsMultiAngleOpen(false);
                            }}
                        />
                    ) : (
                        <PromptPanel
                            initialPrompt={data.prompt}
                            initialParams={data.params}
                            status={data.status}
                            nodeType={data.type === 'video' ? 'video' : data.type === 'text' ? 'text' : data.type === 'audio' ? 'audio' : 'image'}
                            appSettings={appSettings}
                            providerId={data.providerId}
                            modelId={data.modelId}
                            onGenerate={(prompt, config) => onGenerate(data.id, prompt, config)}
                            onPromptChange={(txt) => onPromptChange?.(data.id, txt)}
                            onParamsChange={(params) => onParamsChange?.(data.id, params)}
                            onProviderChange={(id) => onProviderChange?.(data.id, id)}
                            onModelChange={(id) => onModelChange?.(data.id, id)}
                            upstreamImages={upstreamImages}
                        />
                    )}
                </div>
            )}

            {/* Connection Handles */}

            {/* Input Handle (Left) */}
            {/* Input Handle (Left) */}
            <div
                className="absolute top-1/2 -left-6 -translate-y-1/2 w-12 h-12 flex items-center justify-center cursor-crosshair z-30 group/handle"
                onMouseDown={(e) => { e.stopPropagation(); onConnectStart(e, data.id, 'target'); }}
                onMouseUp={(e) => { e.stopPropagation(); onConnectEnd(e, data.id, 'target'); }}
            >
                <div className="w-3.5 h-3.5 rounded-full bg-zinc-900 border-2 border-zinc-600 group-hover/handle:border-cyan-400 group-hover/handle:scale-125 transition-all shadow-lg flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 group-hover/handle:bg-cyan-400 transition-colors" />
                </div>
            </div>

            {/* Output Handle (Right) */}
            <div
                className="absolute top-1/2 -right-6 -translate-y-1/2 w-12 h-12 flex items-center justify-center cursor-crosshair z-30 group/handle"
                onMouseDown={(e) => { e.stopPropagation(); onConnectStart(e, data.id, 'source'); }}
                onMouseUp={(e) => { e.stopPropagation(); onConnectEnd(e, data.id, 'source'); }}
            >
                <div className="w-3.5 h-3.5 rounded-full bg-zinc-900 border-2 border-zinc-600 group-hover/handle:border-cyan-400 group-hover/handle:scale-125 transition-all shadow-lg flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 group-hover/handle:bg-cyan-400 transition-colors" />
                </div>
            </div>
        </div>
    );
});

export default Node;
