import React, { useMemo, useState } from 'react';
import { NodeData } from '../types';
import { AudioIcon, CopyIcon, DownloadIcon, FileTextIcon, ImageIcon, Trash2Icon, VideoIcon, XIcon } from './Icons';

export interface GenerationHistoryItem {
    id: string;
    nodeId?: string;
    type: 'image' | 'video' | 'audio' | 'text';
    title: string;
    content: string;
    blob?: Blob;
    prompt?: string;
    createdAt: number;
}

interface GenerationHistoryPanelProps {
    isOpen: boolean;
    onClose: () => void;
    items: GenerationHistoryItem[];
    nodes: NodeData[];
    onClear: () => void;
    onRestoreImage?: (item: GenerationHistoryItem) => void;
}

const typeLabel: Record<GenerationHistoryItem['type'], string> = {
    image: '图片',
    video: '视频',
    audio: '音频',
    text: '文本'
};

const typeIcon: Record<GenerationHistoryItem['type'], React.ReactNode> = {
    image: <ImageIcon className="h-3.5 w-3.5" />,
    video: <VideoIcon className="h-3.5 w-3.5" />,
    audio: <AudioIcon className="h-3.5 w-3.5" />,
    text: <FileTextIcon className="h-3.5 w-3.5" />
};

const formatTime = (timestamp: number) => {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
};

const nodeToHistoryItem = (node: NodeData): GenerationHistoryItem | null => {
    if (!node.content || node.status !== 'success') return null;
    if (node.isReferenceImage) return null;
    if (!['image', 'video', 'audio', 'text'].includes(node.type)) return null;

    return {
        id: `node-${node.id}`,
        nodeId: node.id,
        type: node.type as GenerationHistoryItem['type'],
        title: node.title || (node.type === 'image' ? '生成图片' : node.type === 'video' ? '生成视频' : node.type === 'audio' ? '生成音频' : '生成文本'),
        content: node.content,
        blob: node.blob,
        prompt: node.prompt,
        createdAt: node.startTime || Date.now()
    };
};

const downloadContent = async (item: GenerationHistoryItem) => {
    if (!item.content) return;

    try {
        const ext = item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : item.type === 'text' ? 'txt' : 'png';
        const blob = item.blob || (item.type === 'text'
            ? new Blob([item.content], { type: 'text/plain;charset=utf-8' })
            : await fetch(item.content).then(response => response.blob()));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `generation-${item.type}-${item.createdAt}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    } catch {
        window.open(item.content, '_blank');
    }
};

const GenerationHistoryPanel: React.FC<GenerationHistoryPanelProps> = ({ isOpen, onClose, items, nodes, onClear, onRestoreImage }) => {
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const mergedItems = useMemo(() => {
        const currentItems = nodes
            .map(nodeToHistoryItem)
            .filter(Boolean) as GenerationHistoryItem[];
        const seen = new Set<string>();
        return [...currentItems, ...items]
            .filter(item => {
                const key = `${item.type}-${item.content}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => b.createdAt - a.createdAt);
    }, [items, nodes]);

    const copyPrompt = async (item: GenerationHistoryItem) => {
        if (!item.prompt) return;
        await navigator.clipboard.writeText(item.prompt);
        setCopiedId(item.id);
        window.setTimeout(() => setCopiedId(null), 1400);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed left-24 top-24 bottom-8 z-[60] w-[420px] overflow-hidden rounded-2xl border border-zinc-800 bg-[#111114]/95 shadow-2xl shadow-black/45 backdrop-blur">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <div>
                    <h2 className="text-sm font-semibold text-white">生成历史</h2>
                    <p className="mt-0.5 text-[11px] text-zinc-500">查看当前项目和本机保存的生成作品</p>
                </div>
                <div className="flex items-center gap-1.5">
                    {items.length > 0 && (
                        <button
                            type="button"
                            onClick={onClear}
                            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-300"
                            title="清空本机历史"
                        >
                            <Trash2Icon className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        title="关闭"
                    >
                        <XIcon className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <div className="h-[calc(100%-57px)] overflow-y-auto p-3">
                {mergedItems.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-8 text-center">
                        <div className="mb-3 rounded-2xl bg-zinc-900 p-3 text-zinc-500">
                            <ImageIcon className="h-6 w-6" />
                        </div>
                        <div className="text-sm font-medium text-zinc-300">暂无生成作品</div>
                        <div className="mt-1 text-xs leading-5 text-zinc-500">图片、视频、音频或文本生成成功后，会自动出现在这里。</div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3">
                        {mergedItems.map(item => (
                            <article key={item.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/55">
                                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-cyan-300">
                                            {typeIcon[item.type]}
                                        </span>
                                        <div className="min-w-0">
                                            <div className="truncate text-xs font-semibold text-zinc-100">{item.title}</div>
                                            <div className="text-[10px] text-zinc-500">{typeLabel[item.type]} · {formatTime(item.createdAt)}</div>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {item.prompt && (
                                            <button
                                                type="button"
                                                onClick={() => copyPrompt(item)}
                                                className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-cyan-200"
                                                title={copiedId === item.id ? '已复制' : '复制提示词'}
                                            >
                                                <CopyIcon className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => downloadContent(item)}
                                            className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                                            title="下载作品"
                                        >
                                            <DownloadIcon className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>

                                <div className="bg-black/20">
                                    {item.type === 'image' && (
                                        <button
                                            type="button"
                                            onClick={() => onRestoreImage?.(item)}
                                            className="block h-48 w-full cursor-pointer bg-transparent transition-colors hover:bg-cyan-400/5 focus:outline-none focus:ring-2 focus:ring-cyan-400/40"
                                            title="点击放回画布"
                                        >
                                            <img src={item.content} alt={item.title} className="h-full w-full object-contain" />
                                        </button>
                                    )}
                                    {item.type === 'video' && (
                                        <video src={item.content} className="h-48 w-full bg-black object-contain" controls />
                                    )}
                                    {item.type === 'audio' && (
                                        <div className="p-4">
                                            <audio src={item.content} className="w-full" controls />
                                        </div>
                                    )}
                                    {item.type === 'text' && (
                                        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap p-3 text-xs leading-5 text-zinc-300">
                                            {item.content}
                                        </div>
                                    )}
                                </div>

                                {item.prompt && (
                                    <div className="border-t border-zinc-800 px-3 py-2">
                                        <p className="line-clamp-2 text-[11px] leading-5 text-zinc-500">
                                            {item.prompt}
                                        </p>
                                    </div>
                                )}
                            </article>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default GenerationHistoryPanel;
