import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';
import './index.css';
import Node from './components/Node';
import Sidebar from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import ImagePreviewModal from './components/ImagePreviewModal';
import GenerationHistoryPanel, { GenerationHistoryItem } from './components/GenerationHistoryPanel';
import { NodeData, Connection, ViewportTransform, Position, GroupData } from './types';
import ParticleCanvas from './components/ParticleCanvas';
import InfiniteCanvas from './components/InfiniteCanvas';
import Group from './components/Group';
import { generateAudio, generateImage, generateText } from './services/geminiService';
import { createSoraTask, pollSoraTask, remixSoraVideo, generateOpenAIVideo } from './services/soraService';
import { removeImageBackground } from './services/backgroundRemovalService';
import { GridModeView } from './components/GridModeView';
import {
    MaximizeIcon,
    Wand2Icon,
    UploadIcon,
    DownloadIcon,
    ImageIcon,
    VideoIcon,
    AudioIcon,
    FileTextIcon,
    LayersIcon,
    GridIcon,
    MoveIcon,
    FileIcon,
    CopyIcon,
    CheckIcon,
    PlusIcon,
    SearchIcon,
    Trash2Icon,
    ScissorsIcon,
    EditIcon,
    FolderIcon,
    ScanIcon,
    CornerUpLeftIcon,
    PaletteIcon,
    BookOpenIcon
} from './components/Icons';
import ContextMenu from './components/ContextMenu';
import ConfirmDialog from './components/ConfirmDialog';
import WelcomeNotice from './components/WelcomeNotice';
import Minimap from './components/Minimap';
import {
    saveProjectToIndexedDB,
    loadProjectFromIndexedDB,
    exportProjectToJson,
    importProjectFromJson,
    exportWorkflowToJson,
    WorkflowEntry,
    initializeSettings,
    saveSettings,
    removeLegacyCredentialsOnce
} from './services/storageService';
import { AppSettings } from './types/settings';
import WorkflowLibraryPanel from './components/WorkflowLibraryPanel';
import ImageComposerModal from './components/ImageComposerModal';
import NewProjectModal from './components/NewProjectModal';
import { Shot } from './services/scriptAnalyzerService';
import {
    buildPreparedPortableNodeClipboardData,
    preparePortableNodeAssets,
    PreparedPortableNodeAssets,
    restorePortableNodeClipboardData
} from './services/nodeClipboardService';

// Initial dummy data
const INITIAL_NODES: NodeData[] = [];
removeLegacyCredentialsOnce();

const INITIAL_CONNECTIONS: Connection[] = [];
const CONNECTION_SNAP_DISTANCE_PX = 200;

const GENERATION_HISTORY_KEY = 'X-tapnow_generation_history';
const GENERATION_HISTORY_IDB_KEY = 'X-tapnow_generation_history_v2';
const TOP_PROMPT_STORAGE_KEY = 'X-tapnow_top_prompt_presets';
const LEGACY_PROMPT_STORAGE_KEY = 'prompt_presets';
const MAX_CANVAS_UNDO_STEPS = 20;
const AUTO_SAVE_DIRECTORY_HANDLE_KEY = 'X-tapnow_auto_save_directory_handle';

type CanvasAutoSavePermissionMode = 'read' | 'readwrite';
type CanvasAutoSaveDirectoryHandle = {
    name: string;
    // Browser-download fallback for insecure LAN HTTP and unsupported browsers.
    __download?: boolean;
    getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
        createWritable: () => Promise<{
            write: (data: Blob | BufferSource | string) => Promise<void>;
            close: () => Promise<void>;
        }>;
    }>;
    queryPermission?: (descriptor?: { mode?: CanvasAutoSavePermissionMode }) => Promise<PermissionState>;
    requestPermission?: (descriptor?: { mode?: CanvasAutoSavePermissionMode }) => Promise<PermissionState>;
};

type WindowWithDirectoryPicker = Window & {
    showDirectoryPicker?: (options?: { id?: string; mode?: CanvasAutoSavePermissionMode }) => Promise<CanvasAutoSaveDirectoryHandle>;
    desktopRuntime?: {
        isElectron?: boolean;
        chooseDirectory?: () => Promise<{ path: string; name: string } | null>;
        saveGeneratedImage?: (payload: { directoryPath: string; filename: string; data: ArrayBuffer }) => Promise<{ saved: boolean }>;
    };
};

type DesktopDirectoryHandle = CanvasAutoSaveDirectoryHandle & {
    __desktopPath: string;
};

type DesktopDirectoryRecord = {
    __desktopPath: string;
    name: string;
};

const createDesktopDirectoryHandle = (record: DesktopDirectoryRecord): DesktopDirectoryHandle => ({
    name: record.name || '已选择文件夹',
    __desktopPath: record.__desktopPath,
    getFileHandle: async () => {
        throw new Error('桌面版使用原生文件保存通道。');
    },
});

const getDesktopRuntime = () => (window as WindowWithDirectoryPicker).desktopRuntime;

const supportsDesktopDirectoryPicker = () => Boolean(
    getDesktopRuntime()?.isElectron && getDesktopRuntime()?.chooseDirectory
);

const supportsDirectoryPicker = () => {
    if (supportsDesktopDirectoryPicker()) return true;
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    return typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
        && (window.isSecureContext || localHost);
};

const getDirectoryPickerSupportMessage = () => {
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (!window.isSecureContext && !localHost) {
        return `当前页面是 ${window.location.origin}。局域网 HTTP 不能选择固定本地文件夹，将改用当前用户电脑的浏览器下载目录；使用 HTTPS 可选择固定目录。`;
    }
    return '当前浏览器不支持固定文件夹写入，将改用当前用户电脑的浏览器下载目录。';
};

const requestDirectoryWritePermission = async (
    handle: CanvasAutoSaveDirectoryHandle,
    shouldRequest = false
) => {
    if (handle.__download || '__desktopPath' in handle) return true;
    if (!handle.queryPermission) return true;

    const descriptor = { mode: 'readwrite' as CanvasAutoSavePermissionMode };
    const current = await handle.queryPermission(descriptor);
    if (current === 'granted') return true;
    if (!shouldRequest || !handle.requestPermission) return false;

    return await handle.requestPermission(descriptor) === 'granted';
};

const getBlobExtension = (blob: Blob) => {
    if (blob.type.includes('jpeg') || blob.type.includes('jpg')) return 'jpg';
    if (blob.type.includes('webp')) return 'webp';
    return 'png';
};

const sanitizeGeneratedImageFilenamePart = (value: string) => {
    const sanitized = value
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);

    return sanitized || 'generated-image';
};

const buildGeneratedImageFilename = (
    nodeId: string,
    prompt: string,
    blob: Blob,
    index: number,
    total: number
) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const nodeSlug = sanitizeGeneratedImageFilenamePart(nodeId).slice(0, 24);
    const promptSlug = sanitizeGeneratedImageFilenamePart(prompt);
    const batchSuffix = total > 1 ? `-${String(index + 1).padStart(2, '0')}` : '';

    return `${timestamp}-${nodeSlug}-${promptSlug}${batchSuffix}.${getBlobExtension(blob)}`;
};

type TopPromptCategory = '收藏' | '角色' | '产品' | '品牌';

type TopPromptPreset = {
    id: string;
    title: string;
    content: string;
    category: TopPromptCategory;
    createdAt?: number;
};

const TOP_PROMPT_PRESETS: TopPromptPreset[] = [
    {
        id: 'industrial-cad-drill',
        title: '工业 CAD 图',
        category: '产品',
        content: '保持产品特征不变，将这张手电钻产品渲染图改为工业CAD图，去除颜色，去除材质，仅保留可见的结构线，纯白的背景，黑色的线条'
    },
    {
        id: 'previs-storyboard',
        title: 'PREVIS 分镜故事板',
        category: '收藏',
        content: '创建一个PREVIS导演分镜故事板。使用参考图像作为角色。16:9 故事板纸，12 个电影式面板。专注于构图和动作，实际故事板绘画必须仅使用黑色和白色：粗铅笔线条，细节最少，快速手势绘画能量，简单解剖结构构建和强烈的轮廓可读性。保持艺术作品轻量、动态和未完成，像早期分镜绘画。注释颜色系统：\n红色箭头 = 身体运动\n蓝色箭头 = 摄像机运动\n绿色标记 = 构图/构图笔记\n橙色标记 = 光线方向\n紫色标记 = 歌声/情感强调\n黑色文字 = 短焦镜头笔记和面板标签'
    }
];

const TOP_PROMPT_CATEGORIES: Array<'全部' | TopPromptCategory> = ['全部', '收藏', '角色', '产品', '品牌'];

const isTopPromptCategory = (value: unknown): value is TopPromptCategory =>
    value === '收藏' || value === '角色' || value === '产品' || value === '品牌';

const normalizeTopPromptPreset = (raw: any, index: number): TopPromptPreset | null => {
    if (!raw || typeof raw !== 'object') return null;

    const title = String(raw.title ?? raw.name ?? '').trim();
    const content = String(raw.content ?? raw.prompt ?? raw.value ?? '').trim();
    if (!title || !content) return null;

    const category = isTopPromptCategory(raw.category) ? raw.category : '收藏';
    return {
        id: typeof raw.id === 'string' && raw.id.trim()
            ? raw.id
            : `custom-prompt-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        category,
        content,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
    };
};

const dedupeTopPromptPresets = (presets: TopPromptPreset[]) => {
    const seen = new Set<string>();
    return presets.filter(preset => {
        const key = `${preset.title.trim().toLowerCase()}\n${preset.content.trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const extractTopPromptPresets = (raw: any): TopPromptPreset[] => {
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.prompts)
            ? raw.prompts
            : Array.isArray(raw?.presets)
                ? raw.presets
                : Array.isArray(raw?.customTopPrompts)
                    ? raw.customTopPrompts
                    : [];

    return dedupeTopPromptPresets(
        list
            .map((item: any, index: number) => normalizeTopPromptPreset(item, index))
            .filter((item: TopPromptPreset | null): item is TopPromptPreset => !!item)
    );
};

const loadCustomTopPromptPresets = (): TopPromptPreset[] => {
    try {
        const stored = localStorage.getItem(TOP_PROMPT_STORAGE_KEY);
        const current = stored ? extractTopPromptPresets(JSON.parse(stored)) : [];

        const legacyStored = localStorage.getItem(LEGACY_PROMPT_STORAGE_KEY);
        const legacy = legacyStored ? extractTopPromptPresets(JSON.parse(legacyStored)) : [];
        const merged = dedupeTopPromptPresets([...current, ...legacy]);

        if (merged.length !== current.length || (legacy.length > 0 && !stored)) {
            localStorage.setItem(TOP_PROMPT_STORAGE_KEY, JSON.stringify(merged));
        }

        return merged;
    } catch (error) {
        console.error('Failed to load top prompt presets:', error);
        return [];
    }
};

const getImageNodeDisplaySize = (imageWidth: number, imageHeight: number) => {
    const maxSide = 512;
    const minSide = 180;
    const ratio = Math.min(1, maxSide / Math.max(imageWidth, imageHeight));
    let width = Math.round(imageWidth * ratio);
    let height = Math.round(imageHeight * ratio);

    if (Math.min(width, height) < minSide) {
        const upRatio = minSide / Math.min(width, height);
        width = Math.round(width * upRatio);
        height = Math.round(height * upRatio);
    }

    return { width, height };
};

const SUPPORTED_IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const;

const getClosestImageAspectRatio = (imageWidth?: number, imageHeight?: number) => {
    const width = imageWidth && imageWidth > 0 ? imageWidth : 1;
    const height = imageHeight && imageHeight > 0 ? imageHeight : 1;
    const ratio = width / height;

    return SUPPORTED_IMAGE_ASPECT_RATIOS.reduce((closest, current) => {
        const [currentWidth, currentHeight] = current.split(':').map(Number);
        const [closestWidth, closestHeight] = closest.split(':').map(Number);
        const currentDistance = Math.abs(ratio - currentWidth / currentHeight);
        const closestDistance = Math.abs(ratio - closestWidth / closestHeight);
        return currentDistance < closestDistance ? current : closest;
    }, '1:1' as typeof SUPPORTED_IMAGE_ASPECT_RATIOS[number]);
};

const getGeneratedNodeSizeForAspectRatio = (aspectRatio: string) => {
    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
    if (!ratioWidth || !ratioHeight) return { width: 340, height: 340 };

    const aspect = ratioWidth / ratioHeight;
    const maxSide = 340;
    const minSide = 190;
    let width = aspect >= 1 ? maxSide : Math.round(maxSide * aspect);
    let height = aspect >= 1 ? Math.round(maxSide / aspect) : maxSide;

    if (Math.min(width, height) < minSide) {
        const scale = minSide / Math.min(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
    }

    return { width, height };
};

const VARIANT_MODEL_PATTERN = /^(.*)-((?:1|2|4)k)(?:-(\d+)x(\d+))?$/i;

const getBaseModelId = (id: string) => {
    const match = id.match(VARIANT_MODEL_PATTERN);
    return match ? match[1] : id;
};

const normalizeRatioForModelId = (ratio?: string) => {
    if ((ratio || '').trim().toLowerCase() === 'auto') return '';
    const match = (ratio || '').match(/^(\d+)\s*:\s*(\d+)$/);
    return match ? `${match[1]}x${match[2]}` : '';
};

const normalizeResolutionForModelId = (resolution?: string) => {
    const normalized = (resolution || '').trim().toLowerCase();
    if (normalized === '1k' || normalized === '2k' || normalized === '4k') return normalized;
    return '';
};

const getPixelSizeForModelId = (resolution?: string, aspectRatio?: string) => {
    const targetResolution = normalizeResolutionForModelId(resolution);
    const targetRatio = normalizeRatioForModelId(aspectRatio);
    if (!targetResolution || !targetRatio) return '';

    const sizes: Record<string, Record<string, string>> = {
        '1k': {
            '1x1': '1024x1024',
            '16x9': '1536x864',
            '9x16': '864x1536',
            '4x3': '1024x768',
            '3x4': '768x1024',
            '3x2': '1536x1024',
            '2x3': '1024x1536',
            '21x9': '1536x656'
        },
        '2k': {
            '1x1': '2048x2048',
            '16x9': '2048x1152',
            '9x16': '1152x2048',
            '4x3': '2048x1536',
            '3x4': '1536x2048',
            '3x2': '2048x1360',
            '2x3': '1360x2048',
            '21x9': '2048x880'
        },
        '4k': {
            '1x1': '4096x4096',
            '16x9': '3840x2160',
            '9x16': '2160x3840',
            '4x3': '4096x3072',
            '3x4': '3072x4096',
            '3x2': '4096x2730',
            '2x3': '2730x4096',
            '21x9': '4096x1756'
        }
    };

    return sizes[targetResolution]?.[targetRatio] || '';
};

const normalizeImageModelForRequest = (modelId: string) => {
    const trimmed = modelId.trim();
    const normalized = trimmed.toLowerCase();
    if (normalized === 'gpt-image-2-all' || /^gpt-image-2-(?:1|2|4)k-\d+x\d+$/i.test(trimmed)) {
        return 'gpt-image-2';
    }
    return trimmed;
};

const resolveVariantModelId = (
    modelId: string,
    providerModels: Array<{ id: string }>,
    resolution?: string,
    aspectRatio?: string
) => {
    const requestModelId = normalizeImageModelForRequest(modelId);
    const baseId = getBaseModelId(requestModelId);
    const targetResolution = normalizeResolutionForModelId(resolution);
    const targetRatio = normalizeRatioForModelId(aspectRatio);
    const targetPixelSize = getPixelSizeForModelId(resolution, aspectRatio);
    if (!targetResolution) return requestModelId;

    const candidateIds = [
        targetPixelSize ? `${baseId}-${targetResolution}-${targetPixelSize}` : '',
        targetRatio ? `${baseId}-${targetResolution}-${targetRatio}` : '',
        `${baseId}-${targetResolution}`
    ].filter(Boolean);

    const exact = providerModels.find(model => candidateIds.some(candidate => model.id.toLowerCase() === candidate.toLowerCase()));
    if (exact) return exact.id;

    return providerModels.find(model => {
        const modelId = model.id.toLowerCase();
        return getBaseModelId(model.id).toLowerCase() === baseId.toLowerCase()
            && (modelId.includes(`-${targetResolution}-`) || modelId.endsWith(`-${targetResolution}`));
    })?.id
        || providerModels.find(model => getBaseModelId(model.id).toLowerCase() === baseId.toLowerCase())?.id
        || requestModelId;
};

const getImageSizeFromUrl = (url: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            resolve({
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height
            });
        };
        img.onerror = reject;
        img.src = url;
    });
};

const parseTargetImageSize = (resolution?: string, aspectRatio?: string) => {
    const size = getPixelSizeForModelId(resolution, aspectRatio);
    const match = size.match(/^(\d+)x(\d+)$/);
    if (!match) return null;
    return {
        width: Number(match[1]),
        height: Number(match[2])
    };
};

const blobToDisplayUrl = (blob: Blob) => URL.createObjectURL(blob);

const loadBitmapFromBlob = async (blob: Blob): Promise<ImageBitmap | HTMLImageElement> => {
    if ('createImageBitmap' in window) {
        return await createImageBitmap(blob);
    }

    return await new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = (error) => {
            URL.revokeObjectURL(objectUrl);
            reject(error);
        };
        image.src = objectUrl;
    });
};

const fetchGeneratedImageBlob = async (url: string) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(window.location.origin)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`读取生成图片失败：HTTP ${response.status}`);
        return response.blob();
    }

    if (/^https?:\/\//i.test(url)) {
        const proxiedUrl = `/api/openai-download-proxy?url=${encodeURIComponent(url)}`;
        const response = await fetch(proxiedUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`读取远程生成图片失败：HTTP ${response.status}`);
        return response.blob();
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取生成图片失败：HTTP ${response.status}`);
    return response.blob();
};

const normalizeGeneratedImageSize = async (
    url: string,
    resolution?: string,
    aspectRatio?: string
): Promise<{ url: string; blob?: Blob; width?: number; height?: number; normalized: boolean }> => {
    const target = parseTargetImageSize(resolution, aspectRatio);
    if (!target) {
        const sourceBlob = await fetchGeneratedImageBlob(url).catch(() => null);
        const displayUrl = sourceBlob ? blobToDisplayUrl(sourceBlob) : url;
        const actual = await getImageSizeFromUrl(displayUrl).catch(() => null);
        return {
            url: displayUrl,
            blob: sourceBlob || undefined,
            width: actual?.width,
            height: actual?.height,
            normalized: false
        };
    }

    try {
        const sourceBlob = await fetchGeneratedImageBlob(url);
        const bitmap = await loadBitmapFromBlob(sourceBlob);
        const sourceWidth = 'width' in bitmap ? bitmap.width : target.width;
        const sourceHeight = 'height' in bitmap ? bitmap.height : target.height;

        if (sourceWidth === target.width && sourceHeight === target.height) {
            return {
                url: blobToDisplayUrl(sourceBlob),
                blob: sourceBlob,
                width: target.width,
                height: target.height,
                normalized: false
            };
        }

        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建图片尺寸标准化画布。');

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, target.width, target.height);

        const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight);
        const drawWidth = Math.round(sourceWidth * scale);
        const drawHeight = Math.round(sourceHeight * scale);
        const drawX = Math.round((target.width - drawWidth) / 2);
        const drawY = Math.round((target.height - drawHeight) / 2);

        ctx.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight);
        if ('close' in bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }

        const normalizedBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('图片尺寸标准化失败。'));
            }, 'image/png', 1);
        });

        return {
            url: blobToDisplayUrl(normalizedBlob),
            blob: normalizedBlob,
            width: target.width,
            height: target.height,
            normalized: true
        };
    } catch (error) {
        console.warn('[App] Failed to normalize generated image size, using original image.', error);
        const actual = await getImageSizeFromUrl(url).catch(() => null);
        return {
            url,
            width: actual?.width,
            height: actual?.height,
            normalized: false
        };
    }
};

type ConnectionSource = {
    nodeId: string;
    nodeIds?: string[];
    handleType: 'source' | 'target';
};

type CanvasUndoSnapshot = {
    nodes: NodeData[];
    connections: Connection[];
    groups: GroupData[];
    selectedNodeIds: string[];
    selectedGroupId: string | null;
    selectedConnectionId: string | null;
};

type UpstreamReferenceImage = {
    node: NodeData;
    index: number;
    label: string;
    value: string | Blob;
};

const cloneCanvasNode = (node: NodeData): NodeData => ({
    ...node,
    position: { ...node.position },
    params: node.params ? { ...node.params } : node.params
});

const cloneCanvasSnapshot = (
    nodes: NodeData[],
    connections: Connection[],
    groups: GroupData[],
    selectedNodeIds: Set<string>,
    selectedGroupId: string | null,
    selectedConnectionId: string | null
): CanvasUndoSnapshot => ({
    nodes: nodes.map(cloneCanvasNode),
    connections: connections.map(connection => ({ ...connection })),
    groups: groups.map(group => ({
        ...group,
        position: { ...group.position }
    })),
    selectedNodeIds: Array.from(selectedNodeIds),
    selectedGroupId,
    selectedConnectionId
});

const getImageReferenceValue = (node: NodeData): string | Blob | null => {
    if (!node.content) return null;
    if (node.blob) return node.blob;
    if (/^(data:image|blob:|https?:\/\/)/i.test(node.content)) return node.content;
    return null;
};

const getMentionedImageIndexes = (prompt: string): Set<number> => {
    const indexes = new Set<number>();
    const mentionRegex = /@图(\d+)/g;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(prompt || '')) !== null) {
        const oneBasedIndex = Number(match[1]);
        if (Number.isInteger(oneBasedIndex) && oneBasedIndex > 0) {
            indexes.add(oneBasedIndex - 1);
        }
    }

    return indexes;
};

const getUpstreamReferenceImages = (
    nodeId: string,
    currentNodes: NodeData[],
    currentConnections: Connection[]
): UpstreamReferenceImage[] => currentConnections
    .filter(conn => conn.toNodeId === nodeId)
    .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
    .filter((node): node is NodeData => !!node && node.type === 'image')
    .map((node, index) => {
        const value = getImageReferenceValue(node);
        if (!value) return null;
        return {
            node,
            index,
            label: `图${index + 1}`,
            value
        };
    })
    .filter((item): item is UpstreamReferenceImage => item !== null);

const selectReferenceImagesForPrompt = (
    prompt: string,
    upstreamImages: UpstreamReferenceImage[]
): UpstreamReferenceImage[] => {
    const mentionedIndexes = getMentionedImageIndexes(prompt);
    if (mentionedIndexes.size === 0) {
        return upstreamImages.length === 1 ? upstreamImages : [];
    }

    return upstreamImages.filter(image => mentionedIndexes.has(image.index));
};

const resolveAutoAspectRatioForGeneration = (
    aspectRatio: string | undefined,
    selectedReferenceImages: UpstreamReferenceImage[],
    currentNode?: NodeData
) => {
    const normalized = (aspectRatio || '').trim().toLowerCase();
    if (normalized && normalized !== 'auto') return aspectRatio;

    const referenceNode = selectedReferenceImages[0]?.node;
    if (referenceNode?.imageWidth && referenceNode?.imageHeight) {
        return getClosestImageAspectRatio(referenceNode.imageWidth, referenceNode.imageHeight);
    }

    if (currentNode?.imageWidth && currentNode?.imageHeight) {
        return getClosestImageAspectRatio(currentNode.imageWidth, currentNode.imageHeight);
    }

    return '1:1';
};

const resolveImageResolutionForGeneration = (resolution?: string, fallback = '2k') => {
    const normalized = (resolution || '').trim();
    return normalized || fallback;
};

const hasStrongImageConstraint = (prompt: string) => {
    return /(不要|不能|禁止|去除|移除|删除|仅保留|只保留|改为|变成|保持|必须|避免|不得|without|remove|only|must|keep|avoid|no\s+)/i.test(prompt || '');
};

const buildImageInstructionPrompt = (
    userPrompt: string,
    options: {
        systemPrompt?: string;
        selectedReferenceLabels?: string[];
        upstreamReferenceCount?: number;
    } = {}
) => {
    const rawPrompt = (userPrompt || '').trim();
    const systemPrompt = (options.systemPrompt || '').trim();
    const selectedReferenceLabels = options.selectedReferenceLabels || [];
    const referenceLine = selectedReferenceLabels.length > 0
        ? `本次实际使用的参考图：${selectedReferenceLabels.join('、')}。`
        : '本次没有使用参考图。';
    const multiReferenceLine = (options.upstreamReferenceCount || 0) > 1
        ? '存在多张参考图时，参考图只用于主体、结构、构图或风格辅助，不得削弱、覆盖或替换用户文字指令。'
        : '参考图只作为辅助信息，用户文字指令拥有最高优先级。';
    const strongConstraintLine = hasStrongImageConstraint(rawPrompt)
        ? '用户提示词中包含强约束、否定或变更要求，必须严格执行这些要求；不得保留用户要求去除的颜色、材质、元素、背景或风格。'
        : '';

    return [
        '你是图像生成提示词执行器。请严格按照以下用户文字指令生成图像，文字指令优先级高于参考图和模型默认风格。',
        systemPrompt ? `附加系统要求：${systemPrompt}` : '',
        referenceLine,
        multiReferenceLine,
        strongConstraintLine,
        '不要自行添加与用户指令冲突的元素、颜色、材质、结构、品牌标识或背景。若参考图与用户指令冲突，以用户指令为准。',
        '',
        '用户原始提示词：',
        rawPrompt || '生成一张清晰、干净、符合参考信息的图片。'
    ].filter(Boolean).join('\n');
};

const isDesktopRuntime = () =>
    typeof window !== 'undefined' && !!(window as any).desktopRuntime?.isElectron;

const isEditableEventTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    const isFormControl = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement;

    if (isFormControl) return true;
    if (!isDesktopRuntime()) return false;

    return target.isContentEditable
        || !!target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]');
};

const App: React.FC = () => {
    // --- State ---
    const [nodes, setNodes] = useState<NodeData[]>(INITIAL_NODES);
    const [connections, setConnections] = useState<Connection[]>(INITIAL_CONNECTIONS);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [groups, setGroups] = useState<GroupData[]>([]); // Moved before refs

    // Refs moved down


    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{
        x: number,
        y: number,
        type: 'node' | 'canvas' | 'group',
        nodeId?: string,
        groupId?: string,
        canvasX?: number,
        canvasY?: number,
        connectionSource?: ConnectionSource
    } | null>(null);

    // Connection state: Tracks which node/handle started the drag
    const [connectingParams, setConnectingParams] = useState<ConnectionSource | null>(null);

    // Group Dragging State (for UI sync)
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [resizingGroup, setResizingGroup] = useState<{
        groupId: string;
        startX: number;
        startY: number;
        initialX: number;
        initialY: number;
        initialW: number;
        initialH: number;
        direction: string;
    } | null>(null);

    // Confirm Dialog State
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean;
        title: string;
        message: string;
        onConfirm: () => void;
        isDanger?: boolean;
    }>({ isOpen: false, title: '', message: '', onConfirm: () => { } });

    // Box Selection State
    const [selectionBox, setSelectionBox] = useState<{ startWorldX: number; startWorldY: number; currentWorldX: number; currentWorldY: number } | null>(null);
    const selectionBaseIdsRef = useRef<Set<string>>(new Set());
    const selectionRafRef = useRef<number>();
    const [isSpacePressed, setIsSpacePressed] = useState(false);

    // Feature Flags / Toggles
    const [isAutoResize, setIsAutoResize] = useState(false);
    const [canvasTheme, setCanvasTheme] = useState<'dark' | 'light'>('dark');

    // Settings State - New Multi-API System
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [appSettings, setAppSettings] = useState<AppSettings>(() => {
        return initializeSettings();
    });
    // View Mode State
    const [viewMode, setViewMode] = useState<'canvas' | 'grid'>('canvas');

    // Media Preview State (Image / Video)
    const [previewMedia, setPreviewMedia] = useState<{ url: string; type: 'image' | 'video' } | null>(null);

    // Workflow Library State
    const [isWorkflowLibraryOpen, setIsWorkflowLibraryOpen] = useState(false);

    // Generation History State
    const [isPromptPresetsOpen, setIsPromptPresetsOpen] = useState(false);
    const [generationHistory, setGenerationHistory] = useState<GenerationHistoryItem[]>(() => {
        try {
            const stored = localStorage.getItem(GENERATION_HISTORY_KEY);
            const parsed = stored ? JSON.parse(stored) : [];
            if (!Array.isArray(parsed)) return [];
            const lightweight = parsed.filter(item =>
                item?.content && !/^(blob:|data:image)/i.test(item.content)
            );
            if (lightweight.length !== parsed.length) {
                localStorage.setItem(GENERATION_HISTORY_KEY, JSON.stringify(lightweight));
            }
            return lightweight;
        } catch {
            return [];
        }
    });
    useEffect(() => {
        let isCancelled = false;

        idbGet(GENERATION_HISTORY_IDB_KEY)
            .then(async (stored) => {
                if (isCancelled || !Array.isArray(stored)) return;
                const restoredItems: GenerationHistoryItem[] = [];
                let migrated = false;
                for (const item of stored as GenerationHistoryItem[]) {
                    if (!item?.content) continue;
                    if (item.blob) {
                        restoredItems.push({ ...item, content: blobToDisplayUrl(item.blob) });
                    } else if (item.type === 'image' && item.content.startsWith('data:image')) {
                        const blob = await fetch(item.content).then(response => response.blob()).catch(() => null);
                        if (blob) {
                            restoredItems.push({ ...item, blob, content: blobToDisplayUrl(blob) });
                            migrated = true;
                        }
                    } else if (!item.content.startsWith('blob:')) {
                        restoredItems.push(item);
                    } else {
                        migrated = true;
                    }
                }
                if (migrated) {
                    void idbSet(GENERATION_HISTORY_IDB_KEY, restoredItems)
                        .catch(error => console.warn('Failed to migrate generation history:', error));
                }
                if (isCancelled) return;
                setGenerationHistory(prev => {
                    const seen = new Set<string>();
                    return [...prev, ...restoredItems]
                        .filter((item): item is GenerationHistoryItem => !!item?.content)
                        .filter(item => {
                            const key = `${item.type}-${item.content}`;
                            if (seen.has(key)) return false;
                            seen.add(key);
                            return true;
                        })
                        .sort((a, b) => b.createdAt - a.createdAt)
                        .slice(0, 80);
                });
            })
            .catch(error => console.warn('Failed to load generation history from IndexedDB:', error));

        return () => {
            isCancelled = true;
        };
    }, []);
    const [isTopPromptWindowOpen, setIsTopPromptWindowOpen] = useState(false);
    const [copiedTopPromptId, setCopiedTopPromptId] = useState<string | null>(null);
    const [activeTopPromptCategory, setActiveTopPromptCategory] = useState<'全部' | TopPromptCategory>('全部');
    const [topPromptSearch, setTopPromptSearch] = useState('');
    const [isAddingTopPrompt, setIsAddingTopPrompt] = useState(false);
    const [newTopPromptTitle, setNewTopPromptTitle] = useState('');
    const [newTopPromptCategory, setNewTopPromptCategory] = useState<TopPromptCategory>('产品');
    const [newTopPromptContent, setNewTopPromptContent] = useState('');
    const [customTopPrompts, setCustomTopPrompts] = useState<TopPromptPreset[]>(loadCustomTopPromptPresets);

    const allTopPromptPresets = React.useMemo(() => [...TOP_PROMPT_PRESETS, ...customTopPrompts], [customTopPrompts]);
    const visibleTopPromptPresets = React.useMemo(() => {
        const keyword = topPromptSearch.trim().toLowerCase();
        return allTopPromptPresets.filter(preset => {
            const matchCategory = activeTopPromptCategory === '全部' || preset.category === activeTopPromptCategory;
            const matchSearch = !keyword || preset.title.toLowerCase().includes(keyword) || preset.content.toLowerCase().includes(keyword);
            return matchCategory && matchSearch;
        });
    }, [activeTopPromptCategory, allTopPromptPresets, topPromptSearch]);

    // Lifted Grid Mode State (Persists across view switches)
    const [gridState, setGridState] = useState<any>({ // Using 'any' briefly to match types.ts interface structure manually or import it
        prompt: '',
        duration: '15s',
        aspectRatio: '16:9',
        resolution: '720p',
        count: 1,
        uploadedImage: null,
        providerId: '',
        modelId: ''
    });

    // Welcome Notice State
    const [showWelcomeNotice, setShowWelcomeNotice] = useState(() => {
        return !supportsDesktopDirectoryPicker() && !localStorage.getItem('welcome_notice_seen');
    });

    // Image Composer State
    const [isImageComposerOpen, setIsImageComposerOpen] = useState(false);
    const [composerInitialImages, setComposerInitialImages] = useState<string[]>([]);
    const [autoSaveDirectoryHandle, setAutoSaveDirectoryHandle] = useState<CanvasAutoSaveDirectoryHandle | null>(null);
    const [autoSaveDirectoryName, setAutoSaveDirectoryName] = useState('');
    const [isAutoSaveDirectoryRestoring, setIsAutoSaveDirectoryRestoring] = useState(true);
    const [isAutoSavePromptOpen, setIsAutoSavePromptOpen] = useState(false);
    const [autoSaveStatusMessage, setAutoSaveStatusMessage] = useState('选择一个本地文件夹后，生成图片会自动保存到那里。');
    const [isAutoSavingImages, setIsAutoSavingImages] = useState(false);
    const [autoSavedImageCount, setAutoSavedImageCount] = useState(0);

    // New Project Modal State
    const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);

    // Connection state: Tracks which node/handle started the drag


    // File Input Ref
    const fileInputRef = useRef<HTMLInputElement>(null);
    const topPromptImportInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadPosRef = useRef<{ x: number, y: number } | null>(null);
    const autoSaveDirectoryHandleRef = useRef<CanvasAutoSaveDirectoryHandle | null>(null);
    const choosingAutoSaveDirectoryRef = useRef(false);
    const portableNodeAssetsRef = useRef<Map<string, {
        sourceContent?: string;
        sourceBlob?: Blob;
        sourceAllImages?: string[];
        sourceAllBlobs?: Blob[];
        sourceImageIndex?: number;
        assets?: PreparedPortableNodeAssets;
    }>>(new Map());

    // Task Abort Controllers
    const taskControllersRef = useRef<Map<string, AbortController>>(new Map());
    const generationProgressTimersRef = useRef<Map<string, number>>(new Map());

    // Refs for stable callbacks (Moved here to have access to all state variables)
    const nodesRef = useRef(nodes);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const groupsRef = useRef(groups);
    const connectionsRef = useRef(connections);
    const appSettingsRef = useRef(appSettings);
    const isAutoResizeRef = useRef(isAutoResize);
    const viewportRef = useRef(viewport);
    const resizingGroupRef = useRef(resizingGroup);
    const connectingParamsRef = useRef(connectingParams);
    const selectionBoxRef = useRef(selectionBox);
    const selectedGroupIdRef = useRef(selectedGroupId);
    const selectedConnectionIdRef = useRef(selectedConnectionId);
    const canvasUndoStackRef = useRef<CanvasUndoSnapshot[]>([]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        selectedNodeIdsRef.current = selectedNodeIds;
        groupsRef.current = groups;
        connectionsRef.current = connections;
        appSettingsRef.current = appSettings;
        isAutoResizeRef.current = isAutoResize;
        viewportRef.current = viewport;
        resizingGroupRef.current = resizingGroup;
        connectingParamsRef.current = connectingParams;
        selectionBoxRef.current = selectionBox;
        selectedGroupIdRef.current = selectedGroupId;
        selectedConnectionIdRef.current = selectedConnectionId;
    }, [nodes, selectedNodeIds, groups, connections, appSettings, isAutoResize, viewport, resizingGroup, connectingParams, selectionBox, selectedGroupId, selectedConnectionId]);

    useEffect(() => {
        autoSaveDirectoryHandleRef.current = autoSaveDirectoryHandle;
    }, [autoSaveDirectoryHandle]);

    useEffect(() => {
        const liveNodeIds = new Set(nodes.map(node => node.id));
        portableNodeAssetsRef.current.forEach((_entry, nodeId) => {
            if (!liveNodeIds.has(nodeId)) portableNodeAssetsRef.current.delete(nodeId);
        });

        selectedNodeIds.forEach(nodeId => {
            const node = nodes.find(candidate => candidate.id === nodeId);
            if (!node || node.type !== 'image') return;

            const existing = portableNodeAssetsRef.current.get(nodeId);
            const isCurrent = existing
                && existing.sourceContent === node.content
                && existing.sourceBlob === node.blob
                && existing.sourceAllImages === node.allImages
                && existing.sourceAllBlobs === node.allBlobs
                && existing.sourceImageIndex === node.currentImageIndex;
            if (isCurrent) return;

            const entry: {
                sourceContent?: string;
                sourceBlob?: Blob;
                sourceAllImages?: string[];
                sourceAllBlobs?: Blob[];
                sourceImageIndex?: number;
                assets?: PreparedPortableNodeAssets;
            } = {
                sourceContent: node.content,
                sourceBlob: node.blob,
                sourceAllImages: node.allImages,
                sourceAllBlobs: node.allBlobs,
                sourceImageIndex: node.currentImageIndex
            };
            portableNodeAssetsRef.current.set(nodeId, entry);
            void preparePortableNodeAssets(node)
                .then(assets => {
                    if (portableNodeAssetsRef.current.get(nodeId) === entry) entry.assets = assets;
                })
                .catch(error => console.warn('[Clipboard] Failed to prepare node image:', error));
        });
    }, [nodes, selectedNodeIds]);

    useEffect(() => {
        let isCancelled = false;

        const restoreAutoSaveDirectory = async () => {
            if (supportsDesktopDirectoryPicker()) {
                try {
                    const storedRecord = await idbGet(AUTO_SAVE_DIRECTORY_HANDLE_KEY) as DesktopDirectoryRecord | null;
                    if (isCancelled || !storedRecord?.__desktopPath) return;

                    const desktopHandle = createDesktopDirectoryHandle(storedRecord);
                    autoSaveDirectoryHandleRef.current = desktopHandle;
                    setAutoSaveDirectoryHandle(desktopHandle);
                    setAutoSaveDirectoryName(desktopHandle.name);
                    setAutoSaveStatusMessage(`生成图片将自动保存到「${desktopHandle.name}」。`);
                } catch (error) {
                    console.warn('[AutoSave] Failed to restore desktop directory.', error);
                    await idbDel(AUTO_SAVE_DIRECTORY_HANDLE_KEY).catch(() => undefined);
                }
                if (!isCancelled) setIsAutoSaveDirectoryRestoring(false);
                return;
            }

            if (!supportsDirectoryPicker()) {
                setAutoSaveStatusMessage(getDirectoryPickerSupportMessage());
                if (!isCancelled) setIsAutoSaveDirectoryRestoring(false);
                return;
            }

            try {
                const storedHandle = await idbGet(AUTO_SAVE_DIRECTORY_HANDLE_KEY) as CanvasAutoSaveDirectoryHandle | null;
                if (!storedHandle || isCancelled) return;

                const hasPermission = await requestDirectoryWritePermission(storedHandle, false);
                if (isCancelled) return;

                if (hasPermission) {
                    autoSaveDirectoryHandleRef.current = storedHandle;
                    setAutoSaveDirectoryHandle(storedHandle);
                    setAutoSaveDirectoryName(storedHandle.name || '已选择文件夹');
                    setAutoSaveStatusMessage(`生成图片将自动保存到「${storedHandle.name || '已选择文件夹'}」。`);
                } else {
                    setAutoSaveStatusMessage('浏览器需要重新授权上次的保存文件夹，请重新选择。');
                }
            } catch (error) {
                console.warn('[AutoSave] Failed to restore directory handle.', error);
                setAutoSaveStatusMessage('未能恢复上次选择的保存文件夹，请重新选择。');
            }
            if (!isCancelled) setIsAutoSaveDirectoryRestoring(false);
        };

        restoreAutoSaveDirectory();

        return () => {
            isCancelled = true;
        };
    }, []);

    useEffect(() => {
        if (isAutoSaveDirectoryRestoring) return;
        if (viewMode !== 'canvas') {
            setIsAutoSavePromptOpen(false);
            return;
        }

        if (supportsDesktopDirectoryPicker()) {
            setIsAutoSavePromptOpen(false);
            return;
        }

        setIsAutoSavePromptOpen(!autoSaveDirectoryHandle);
    }, [autoSaveDirectoryHandle, isAutoSaveDirectoryRestoring, viewMode]);

    const handleChooseAutoSaveDirectory = useCallback(async () => {
        if (supportsDesktopDirectoryPicker()) {
            if (choosingAutoSaveDirectoryRef.current) return;
            choosingAutoSaveDirectoryRef.current = true;
            try {
                const selected = await getDesktopRuntime()?.chooseDirectory?.();
                if (!selected?.path) {
                    setAutoSaveStatusMessage('未选择保存文件夹，可再次点击重新选择。');
                    setIsAutoSavePromptOpen(true);
                    return;
                }

                const desktopRecord: DesktopDirectoryRecord = {
                    __desktopPath: selected.path,
                    name: selected.name || '已选择文件夹',
                };
                const desktopHandle = createDesktopDirectoryHandle(desktopRecord);
                await idbSet(AUTO_SAVE_DIRECTORY_HANDLE_KEY, desktopRecord);
                autoSaveDirectoryHandleRef.current = desktopHandle;
                setAutoSaveDirectoryHandle(desktopHandle);
                setAutoSaveDirectoryName(desktopHandle.name);
                setAutoSaveStatusMessage(`生成图片将自动保存到「${desktopHandle.name}」。`);
                setIsAutoSavePromptOpen(false);
            } catch (error: any) {
                console.warn('[AutoSave] Failed to choose desktop directory.', error);
                setAutoSaveStatusMessage(error?.message || '选择保存文件夹失败，请重试。');
                setIsAutoSavePromptOpen(true);
            } finally {
                choosingAutoSaveDirectoryRef.current = false;
            }
            return;
        }

        if (!supportsDirectoryPicker()) {
            const downloadHandle: CanvasAutoSaveDirectoryHandle = {
                name: '当前用户的浏览器下载目录',
                __download: true,
                getFileHandle: async () => {
                    throw new Error('当前使用浏览器下载模式。');
                }
            };

            autoSaveDirectoryHandleRef.current = downloadHandle;
            setAutoSaveDirectoryHandle(downloadHandle);
            setAutoSaveDirectoryName(downloadHandle.name);
            setAutoSaveStatusMessage('生成图片将下载到当前访问用户电脑的浏览器下载目录，并保留在生成历史中。');
            setIsAutoSavePromptOpen(false);
            return;
        }

        try {
            const directoryHandle = await (window as WindowWithDirectoryPicker).showDirectoryPicker?.({
                id: 'x-tapnow-generated-images',
                mode: 'readwrite'
            });
            if (!directoryHandle) return;

            const hasPermission = await requestDirectoryWritePermission(directoryHandle, true);
            if (!hasPermission) {
                setAutoSaveStatusMessage('没有获得写入权限，请重新选择并允许保存图片。');
                setIsAutoSavePromptOpen(true);
                return;
            }

            await idbSet(AUTO_SAVE_DIRECTORY_HANDLE_KEY, directoryHandle);
            autoSaveDirectoryHandleRef.current = directoryHandle;
            setAutoSaveDirectoryHandle(directoryHandle);
            setAutoSaveDirectoryName(directoryHandle.name || '已选择文件夹');
            setAutoSaveStatusMessage(`生成图片将自动保存到「${directoryHandle.name || '已选择文件夹'}」。`);
            setIsAutoSavePromptOpen(false);
        } catch (error: any) {
            if (error?.name === 'AbortError') {
                setAutoSaveStatusMessage('需要先选择保存文件夹，之后生成的图片才会自动保存。');
                setIsAutoSavePromptOpen(true);
                return;
            }

            console.warn('[AutoSave] Failed to choose directory.', error);
            setAutoSaveStatusMessage(error?.message || '选择保存文件夹失败，请重试。');
            setIsAutoSavePromptOpen(true);
        }
    }, []);

    const writeGeneratedImageToDirectory = useCallback(async (
        directoryHandle: CanvasAutoSaveDirectoryHandle,
        filename: string,
        blob: Blob
    ) => {
        if ('__desktopPath' in directoryHandle) {
            const desktopHandle = directoryHandle as DesktopDirectoryHandle;
            const runtime = getDesktopRuntime();
            if (!runtime?.saveGeneratedImage) throw new Error('桌面版保存通道不可用，请重启应用后重试。');
            await runtime.saveGeneratedImage({
                directoryPath: desktopHandle.__desktopPath,
                filename,
                data: await blob.arrayBuffer(),
            });
            return;
        }

        if (directoryHandle.__download) {
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = filename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
            return;
        }

        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(blob);
        } finally {
            await writable.close();
        }
    }, []);

    const saveGeneratedImagesToDirectory = useCallback(async (
        nodeId: string,
        prompt: string,
        images: Array<{ url: string; blob?: Blob }>
    ) => {
        const directoryHandle = autoSaveDirectoryHandleRef.current;

        if (!directoryHandle) {
            setAutoSaveStatusMessage('请先选择保存文件夹，生成图片才会自动保存。');
            setIsAutoSavePromptOpen(true);
            return;
        }

        try {
            setIsAutoSavingImages(true);
            const hasPermission = await requestDirectoryWritePermission(directoryHandle, true);
            if (!hasPermission) {
                autoSaveDirectoryHandleRef.current = null;
                setAutoSaveDirectoryHandle(null);
                setAutoSaveDirectoryName('');
                setAutoSaveStatusMessage('保存文件夹权限已失效，请重新选择。');
                setIsAutoSavePromptOpen(true);
                return;
            }

            let savedCount = 0;
            for (let index = 0; index < images.length; index += 1) {
                const image = images[index];
                const blob = image.blob || await fetchGeneratedImageBlob(image.url);
                const filename = buildGeneratedImageFilename(nodeId, prompt, blob, index, images.length);
                await writeGeneratedImageToDirectory(directoryHandle, filename, blob);
                savedCount += 1;
            }

            setAutoSavedImageCount(prev => prev + savedCount);
            setAutoSaveStatusMessage(`已自动保存 ${savedCount} 张图片到「${directoryHandle.name || autoSaveDirectoryName || '已选择文件夹'}」。`);
        } catch (error: any) {
            console.warn('[AutoSave] Failed to save generated images.', error);
            setAutoSaveStatusMessage(error?.message || '自动保存图片失败，请检查文件夹权限后重试。');
            setIsAutoSavePromptOpen(true);
        } finally {
            setIsAutoSavingImages(false);
        }
    }, [autoSaveDirectoryName, writeGeneratedImageToDirectory]);

    const recordCanvasUndoSnapshot = useCallback(() => {
        const snapshot = cloneCanvasSnapshot(
            nodesRef.current,
            connectionsRef.current,
            groupsRef.current,
            selectedNodeIdsRef.current,
            selectedGroupIdRef.current,
            selectedConnectionIdRef.current
        );

        canvasUndoStackRef.current = [...canvasUndoStackRef.current, snapshot].slice(-MAX_CANVAS_UNDO_STEPS);
    }, []);

    const handleUndoCanvasStep = useCallback(() => {
        const snapshot = canvasUndoStackRef.current.pop();
        if (!snapshot) return;

        setNodes(snapshot.nodes.map(cloneCanvasNode));
        setConnections(snapshot.connections.map(connection => ({ ...connection })));
        setGroups(snapshot.groups.map(group => ({ ...group, position: { ...group.position } })));
        setSelectedNodeIds(new Set(snapshot.selectedNodeIds));
        setSelectedGroupId(snapshot.selectedGroupId);
        setSelectedConnectionId(snapshot.selectedConnectionId);
        setContextMenu(null);
        setSelectionBox(null);
    }, []);

    const screenToCanvas = useCallback((sx: number, sy: number) => {
        const currentViewport = viewportRef.current;
        return {
            x: (sx - currentViewport.x) / currentViewport.k,
            y: (sy - currentViewport.y) / currentViewport.k
        };
    }, []);

    const stopSimulatedProgress = useCallback((nodeId: string) => {
        const timer = generationProgressTimersRef.current.get(nodeId);
        if (timer) {
            window.clearInterval(timer);
            generationProgressTimersRef.current.delete(nodeId);
        }
    }, []);

    const startSimulatedProgress = useCallback((nodeId: string) => {
        stopSimulatedProgress(nodeId);

        const startedAt = Date.now();
        const stages = [
            { time: 0, progress: 4 },
            { time: 5000, progress: 35 },
            { time: 14000, progress: 68 },
            { time: 26000, progress: 88 },
            { time: 42000, progress: 94 }
        ];

        const tick = () => {
            const elapsed = Date.now() - startedAt;
            let nextProgress = stages[0].progress;

            for (let i = 0; i < stages.length - 1; i += 1) {
                const current = stages[i];
                const next = stages[i + 1];
                if (elapsed >= current.time && elapsed < next.time) {
                    const ratio = (elapsed - current.time) / (next.time - current.time);
                    const eased = 1 - Math.pow(1 - ratio, 2);
                    nextProgress = current.progress + (next.progress - current.progress) * eased;
                    break;
                }
                if (elapsed >= next.time) {
                    nextProgress = next.progress;
                }
            }

            const boundedProgress = Math.min(94, Math.max(4, Math.round(nextProgress)));
            setNodes(prev => prev.map(n => {
                if (n.id !== nodeId || n.status !== 'loading') return n;
                const currentProgress = typeof n.progress === 'number' ? n.progress : 0;
                return { ...n, progress: Math.max(currentProgress, boundedProgress) };
            }));
        };

        tick();
        const timer = window.setInterval(tick, 700);
        generationProgressTimersRef.current.set(nodeId, timer);
    }, [stopSimulatedProgress]);

    useEffect(() => {
        return () => {
            generationProgressTimersRef.current.forEach(timer => window.clearInterval(timer));
            generationProgressTimersRef.current.clear();
        };
    }, []);

    const [mousePos, setMousePos] = useState<Position>({ x: 0, y: 0 }); // Screen coordinates

    // Context Menu Handlers
    const handleNodeContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
        e.preventDefault();
        e.stopPropagation(); // Stop propagation to canvas
        setContextMenu({ x: e.clientX, y: e.clientY, type: 'node', nodeId });
    }, []);

    const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        // Convert screen coordinates to canvas coordinates for node creation
        const canvasPos = screenToCanvas(e.clientX, e.clientY);
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            type: 'canvas',
            canvasX: canvasPos.x,
            canvasY: canvasPos.y
        });
    }, [viewport]);

    const handleCloseContextMenu = useCallback(() => {
        setContextMenu(null);
    }, []);

    // Deletion Logic
    const handleDeleteNode = useCallback((targetId?: string) => {
        // Determine which IDs to delete
        const idsToDelete = targetId ? new Set([targetId]) : selectedNodeIds;

        if (idsToDelete.size === 0) return;
        recordCanvasUndoSnapshot();

        // Abort ongoing tasks
        idsToDelete.forEach(id => {
            taskControllersRef.current.get(id)?.abort();
            taskControllersRef.current.delete(id);
            stopSimulatedProgress(id);
        });

        // Update Nodes
        setNodes(prev => prev.filter(n => !idsToDelete.has(n.id)));

        // Update Connections
        setConnections(prev => prev.filter(c => !idsToDelete.has(c.fromNodeId) && !idsToDelete.has(c.toNodeId)));

        // Clear selection if necessary
        if (!targetId) {
            setSelectedNodeIds(new Set());
        } else {
            // If we deleted specific node that was selected, remove it from selection
            if (selectedNodeIds.has(targetId)) {
                setSelectedNodeIds(prev => {
                    const next = new Set(prev);
                    next.delete(targetId);
                    return next;
                });
            }
        }
    }, [selectedNodeIds, recordCanvasUndoSnapshot, stopSimulatedProgress]);

    const handleDeleteConnection = useCallback((connId: string) => {
        recordCanvasUndoSnapshot();
        setConnections(prev => prev.filter(c => c.id !== connId));
        if (selectedConnectionId === connId) setSelectedConnectionId(null);
    }, [selectedConnectionId, recordCanvasUndoSnapshot]);

    const writeClipboardText = useCallback(async (text: string) => {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (error) {
                console.warn('navigator.clipboard.writeText failed, falling back to execCommand:', error);
            }
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        try {
            return document.execCommand('copy');
        } finally {
            document.body.removeChild(textarea);
        }
    }, []);

    const writeClipboardTextSynchronously = useCallback((text: string) => {
        const textarea = document.createElement('textarea');
        textarea.value = ' ';
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        const handleCopy = (event: ClipboardEvent) => {
            event.clipboardData?.setData('text/plain', text);
            event.preventDefault();
        };
        document.addEventListener('copy', handleCopy, { once: true });

        try {
            return document.execCommand('copy');
        } finally {
            document.removeEventListener('copy', handleCopy);
            textarea.remove();
        }
    }, []);

    const copyNodesToClipboard = useCallback((nodeIds: Iterable<string>) => {
        try {
            const nodeIdList = Array.from(nodeIds);
            const clipboardData = buildPreparedPortableNodeClipboardData(
                nodes,
                connections,
                nodeIdList,
                new Map(Array.from(portableNodeAssetsRef.current.entries()).flatMap(([nodeId, entry]) =>
                    entry.assets ? [[nodeId, entry.assets] as const] : []
                ))
            );
            if (clipboardData.nodes.length === 0) return;

            const text = JSON.stringify(clipboardData);
            if (writeClipboardTextSynchronously(text)) return;

            if (navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(text).catch(error => {
                    console.error('[Clipboard] Async clipboard fallback failed:', error);
                    window.alert('浏览器拒绝写入剪贴板，请检查剪贴板权限。');
                });
                return;
            }
            throw new Error('浏览器拒绝写入剪贴板。');
        } catch (error: any) {
            console.error('[Clipboard] Failed to copy portable nodes:', error);
            window.alert(error?.message || '复制节点失败，请重试。');
        }
    }, [connections, nodes, writeClipboardTextSynchronously]);

    // Keyboard Shortcuts (Delete)
    // Keyboard Shortcuts (Delete & Space)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isEditingText = isEditableEventTarget(e.target);

            if (e.code === 'Space' && !e.repeat && !isEditingText) {
                setIsSpacePressed(true);
            }

            // Ignore canvas shortcuts while typing in inputs or contenteditable prompt boxes.
            if (isEditingText) return;

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                handleUndoCanvasStep();
                return;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                if (selectedGroupId) {
                    const groupId = selectedGroupId;
                    recordCanvasUndoSnapshot();
                    setGroups(prev => prev.filter(g => g.id !== groupId));
                    setNodes(prev => prev.map(n => n.groupId === groupId ? { ...n, groupId: undefined } : n));
                    setSelectedGroupId(null);
                    return;
                }
                if (selectedNodeIds.size > 0) {
                    handleDeleteNode();
                }
                if (selectedConnectionId) {
                    handleDeleteConnection(selectedConnectionId);
                }
            }

            if (e.key === 'Escape') {
                setSelectedNodeIds(new Set());
                setSelectedGroupId(null);
                setSelectedConnectionId(null);
                setConnectingParams(null);
                setSelectionBox(null);
            }


            // Group (Ctrl+G)
            if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
                e.preventDefault();
                if (selectedNodeIds.size > 0) {
                    handleCreateGroup(Array.from(selectedNodeIds));
                }
            }

            // Copy (Ctrl+C)
            if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
                if (selectedNodeIds.size > 0) {
                    e.preventDefault();
                    copyNodesToClipboard(selectedNodeIds);
                }
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                setIsSpacePressed(false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [selectedNodeIds, selectedGroupId, selectedConnectionId, handleDeleteNode, handleDeleteConnection, copyNodesToClipboard, handleUndoCanvasStep, recordCanvasUndoSnapshot]);

    // Clear selection on background click (only if not panning or selecting)
    const handleBackgroundClick = useCallback(() => {
        // Handled in MouseUp if no drag occurred
        // But keeping this for safety if called explicitly
        // Update: Logic moved to MouseDown/Up handling
    }, []);

    const recordGenerationHistory = useCallback((item: Omit<GenerationHistoryItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) => {
        if (!item.content) return;

        setGenerationHistory(prev => {
            const entry: GenerationHistoryItem = {
                id: item.id || `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                nodeId: item.nodeId,
                type: item.type,
                title: item.title,
                content: item.content,
                blob: item.blob,
                prompt: item.prompt,
                createdAt: item.createdAt || Date.now()
            };
            let blobImageCount = 0;
            const next = [entry, ...prev.filter(historyItem => historyItem.content !== entry.content)]
                .filter(historyItem => {
                    if (historyItem.type !== 'image' || !historyItem.blob) return true;
                    blobImageCount += 1;
                    return blobImageCount <= 16;
                })
                .slice(0, 80);
            void idbSet(GENERATION_HISTORY_IDB_KEY, next)
                .catch(error => console.warn('Failed to save generation history to IndexedDB:', error));
            try {
                const lightweightHistory = next.filter(historyItem =>
                    !historyItem.blob && !/^(blob:|data:image)/i.test(historyItem.content)
                );
                localStorage.setItem(GENERATION_HISTORY_KEY, JSON.stringify(lightweightHistory));
            } catch (error) {
                console.warn('Failed to save generation history:', error);
            }
            return next;
        });
    }, []);

    const handleClearGenerationHistory = useCallback(() => {
        setGenerationHistory([]);
        localStorage.removeItem(GENERATION_HISTORY_KEY);
        void idbDel(GENERATION_HISTORY_IDB_KEY)
            .catch(error => console.warn('Failed to clear generation history from IndexedDB:', error));
    }, []);

    const handleRestoreHistoryImage = useCallback((item: GenerationHistoryItem) => {
        if (item.type !== 'image' || !item.content) return;

        const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        const createNode = (width: number, height: number, imageWidth?: number, imageHeight?: number) => {
            const newNode: NodeData = {
                id: `history-img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                type: 'image',
                position: { x: center.x - width / 2, y: center.y - height / 2 },
                width,
                height,
                title: item.title || '历史图片',
                content: item.content,
                blob: item.blob,
                prompt: item.prompt,
                status: 'success',
                imageWidth,
                imageHeight,
                isReferenceImage: false,
                params: {
                    model: '',
                    aspectRatio: imageWidth && imageHeight ? getClosestImageAspectRatio(imageWidth, imageHeight) : 'auto',
                    resolution: '',
                    batchSize: 1
                }
            };

            setNodes(prev => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setIsPromptPresetsOpen(false);
        };

        const image = new Image();
        image.onload = () => {
            const imageWidth = image.naturalWidth || image.width;
            const imageHeight = image.naturalHeight || image.height;
            const size = getImageNodeDisplaySize(imageWidth, imageHeight);
            createNode(size.width, size.height, imageWidth, imageHeight);
        };
        image.onerror = () => createNode(340, 240);
        image.src = item.content;
    }, [screenToCanvas]);

    // Sora Polling Helper
    const monitorSoraTask = useCallback(async (nodeId: string, taskId: string, providerId?: string) => {
        // Create AbortController for this node
        const controller = new AbortController();
        taskControllersRef.current.set(nodeId, controller);

        try {
            // Get video provider config from settings
            const currentSettings = appSettingsRef.current;
            const videoProvider = (providerId
                ? currentSettings.videoProviders.find(p => p.id === providerId)
                : currentSettings.videoProviders.find(p => p.isDefault))
                || currentSettings.videoProviders[0];

            if (!videoProvider) {
                throw new Error('No video provider configured');
            }
            const config = {
                apiKey: videoProvider.apiKey,
                baseUrl: videoProvider.baseUrl,
                type: videoProvider.type,
                endpointMode: videoProvider.endpointMode,
                customEndpoint: videoProvider.customEndpoint
            };
            const videoUrl = await pollSoraTask(taskId, config, (status, progress) => {
                setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, title: `Generating... ${progress}%`, progress: progress } : n));
            }, controller.signal);

            // console.log("[Sora] Monitor success, video URL:", videoUrl);

            // Directly use the returned video URL instead of downloading it as a blob
            setNodes(prev => prev.map(n => {
                if (n.id === nodeId) {
                    return {
                        ...n,
                        type: 'video',
                        status: 'success',
                        content: videoUrl, // Use direct URL
                        blob: undefined,   // No local blob
                        title: 'Generated Video',
                        progress: 100,
                        executionTime: n.startTime ? Date.now() - n.startTime : undefined
                    };
                }
                return n;
            }));
            const node = nodesRef.current.find(n => n.id === nodeId);
            recordGenerationHistory({
                nodeId,
                type: 'video',
                title: 'Generated Video',
                content: videoUrl,
                prompt: node?.prompt
            });
        } catch (error: any) {
            if (error.message === "Task aborted") {
                console.log(`[Sora] Polling aborted for node ${nodeId}`);
                return;
            }

            console.error("[Sora] Monitor failed:", error);

            // 濡傛灉閿欒瀵硅薄涓寘鍚玹askData锛屼篃鎵撳嵃鍑烘潵甯姪璋冭瘯
            if (error.taskData) {
                console.error("[Sora] Task data from error:", error.taskData);
            }

            // 鎻愬彇璇︾粏鐨勯敊璇俊鎭敤浜庢樉绀?            let displayError = error.message || 'Generation failed';

            // 闄愬埗閿欒淇℃伅闀垮害锛岄伩鍏峌I鏄剧ず杩囬暱
            const maxErrorLength = 100;
            if (displayError.length > maxErrorLength) {
                displayError = displayError.substring(0, maxErrorLength) + '...';
            }

            setNodes(prev => prev.map(n =>
                n.id === nodeId
                    ? {
                        ...n,
                        status: 'error',
                        title: '閿欒: ' + displayError,
                        // 淇濈暀瀹屾暣閿欒淇℃伅鍦ㄨ妭鐐规暟鎹腑锛屽彲浠ュ湪鎺у埗鍙版煡鐪?                        errorDetails: error.message
                    }
                    : n
            ));
        } finally {
            taskControllersRef.current.delete(nodeId);
        }
    }, []);

    // --- Storage Logic ---

    // Auto-load on startup
    useEffect(() => {
        const load = async () => {
            const data = await loadProjectFromIndexedDB();
            if (data) {
                setNodes(data.nodes);
                setConnections(data.connections);
                if (data.viewport) setViewport(data.viewport);
                if ((data as any).groups) setGroups((data as any).groups);

                // Resume pending Sora tasks
                data.nodes.forEach(n => {
                    if (n.type === 'video' && n.status === 'loading' && n.taskId) {
                        monitorSoraTask(n.id, n.taskId, n.providerId);
                    }
                });
            }
        };
        load();
    }, []);

    // Auto-save on change (debounced)
    const saveToDB = useCallback(() => {
        // @ts-ignore - storage service update pending
        saveProjectToIndexedDB(nodes, connections, viewport, groups);
    }, [nodes, connections, viewport, groups]);

    useEffect(() => {
        const timeoutId = setTimeout(() => {
            saveToDB();
        }, 5000); // Save after 5 seconds of inactivity to reduce stutter

        return () => clearTimeout(timeoutId);
    }, [saveToDB]);

    // Export Handler
    const handleExport = async () => {
        // @ts-ignore - storage service update pending
        await exportProjectToJson(nodes, connections, viewport, groups);
    };

    // Toggle Workflow Library
    const handleToggleLibrary = () => {
        setIsWorkflowLibraryOpen(prev => !prev);
    };

    const handleLoadWorkflow = (workflow: WorkflowEntry) => {
        // 1. Calculate offset to center new nodes in the current viewport
        if (workflow.nodes.length === 0) return;

        // Calculate Workflow Bounding Box
        const wfMinX = Math.min(...workflow.nodes.map(n => n.position.x));
        const wfMaxX = Math.max(...workflow.nodes.map(n => n.position.x + n.width));
        const wfMinY = Math.min(...workflow.nodes.map(n => n.position.y));
        const wfMaxY = Math.max(...workflow.nodes.map(n => n.position.y + n.height));

        const wfWidth = wfMaxX - wfMinX;
        const wfHeight = wfMaxY - wfMinY;
        const wfCenterX = wfMinX + wfWidth / 2;
        const wfCenterY = wfMinY + wfHeight / 2;

        // Calculate Viewport Center in Canvas Coordinates
        // Screen Center: (window.innerWidth / 2, window.innerHeight / 2)
        // Canvas X = (Screen X - viewport.x) / viewport.k
        const canvasCenterX = (window.innerWidth / 2 - viewport.x) / viewport.k;
        const canvasCenterY = (window.innerHeight / 2 - viewport.y) / viewport.k;

        // Offset = Target Center - Workflow Center
        const offsetX = canvasCenterX - wfCenterX;
        const offsetY = canvasCenterY - wfCenterY;

        // 2. Generate ID Map to avoid conflicts
        const nodeIdMap = new Map<string, string>();
        workflow.nodes.forEach(n => {
            nodeIdMap.set(n.id, `n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
        });

        // Generate Group ID Map
        const groupIdMap = new Map<string, string>();
        if (workflow.groups) {
            workflow.groups.forEach(g => {
                groupIdMap.set(g.id, `g-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
            });
        }

        // 3. Prepare new nodes with new IDs and Positions
        const newNodes = workflow.nodes.map(n => ({
            ...n,
            id: nodeIdMap.get(n.id)!,
            position: {
                x: n.position.x + offsetX,
                y: n.position.y + offsetY
            },
            groupId: n.groupId ? groupIdMap.get(n.groupId) : undefined, // 鏇存柊groupId寮曠敤
            selected: false // Ensure imported nodes aren't auto-selected immediately in a confusing way (or maybe they should be?)
            // status is already 'idle' from save logic
        }));

        // 4. Prepare new connections with new IDs
        const newConnections = workflow.connections.map(c => ({
            ...c,
            id: `c-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            fromNodeId: nodeIdMap.get(c.fromNodeId)!,
            toNodeId: nodeIdMap.get(c.toNodeId)!
        })).filter(c => c.fromNodeId && c.toNodeId); // Safety check

        // 5. Prepare new groups with new IDs and Positions
        const newGroups = workflow.groups ? workflow.groups.map(g => ({
            ...g,
            id: groupIdMap.get(g.id)!,
            position: {
                x: g.position.x + offsetX,
                y: g.position.y + offsetY
            }
        })) : [];

        // 6. Merge and Save
        const updatedNodes = [...nodes, ...newNodes];
        const updatedConnections = [...connections, ...newConnections];
        const updatedGroups = [...groups, ...newGroups];

        setNodes(updatedNodes);
        setConnections(updatedConnections);
        setGroups(updatedGroups);

        // Optional: Select the new nodes to highlight what was added
        // setSelectedNodeId(null); 

        // Persist - 鍖呭惈groups鏁版嵁
        saveProjectToIndexedDB(updatedNodes, updatedConnections, viewport, updatedGroups);
    };

    // Import Handler
    const handleImportClick = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const data = await importProjectFromJson(file);
            setNodes(data.nodes);
            setConnections(data.connections);
            if (data.viewport) setViewport(data.viewport);
            if (data.groups) setGroups(data.groups); // 鎭㈠鍒嗙粍鏁版嵁

            // Handle Full Backup Data (Settings & Characters)
            let extrasRestored = false;
            const restoredItems: string[] = [];

            if (data.characters && Array.isArray(data.characters)) {
                console.log(`[Import] 恢复 ${data.characters.length} 个角色`);
                localStorage.setItem('sora_characters', JSON.stringify(data.characters));
                // Dispatch event so PromptPanel and Modal update immediately
                window.dispatchEvent(new Event('sora_characters_updated'));
                extrasRestored = true;
                restoredItems.push(`${data.characters.length} 个角色`);
            } else {
                console.log('[Import] 瀵煎叆鏂囦欢涓湭鍖呭惈瑙掕壊鏁版嵁');
            }

            if (data.settings) {
                console.log('[Import] 鎭㈠搴旂敤璁剧疆');
                setAppSettings(data.settings);
                saveSettings(data.settings);
                extrasRestored = true;
                restoredItems.push('搴旂敤璁剧疆');
            }

            if (data.extraConfig) {
                console.log('[Import] 鎭㈠棰濆閰嶇疆:', Object.keys(data.extraConfig));
                Object.entries(data.extraConfig).forEach(([key, value]) => {
                    localStorage.setItem(key, value as string);
                });
                extrasRestored = true;
                restoredItems.push('API 配置');
            }

            if (extrasRestored) {
                alert(`导入成功\n已恢复：${restoredItems.join('、')}`);
            }

            // Also update DB immediately - 鍖呭惈groups鏁版嵁
            saveProjectToIndexedDB(data.nodes, data.connections, data.viewport, data.groups || []);
        } catch (err) {
            console.error('Failed to load project:', err);
            // Error will be shown in console, no modal needed
        }

        // Reset input
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // Refs for Dragging
    // Refs for Dragging
    // canvasRef is now inside InfiniteCanvas, but we still use refs for logic
    const dragRef = useRef<{
        isDraggingNode: boolean;
        isDraggingGroup: boolean;
        nodeId: string | null;
        groupId: string | null;
        startX: number;
        startY: number;
        currentX: number;
        currentY: number;
        initialNodePos?: Position;
    }>({
        isDraggingNode: false,
        isDraggingGroup: false,
        nodeId: null,
        groupId: null,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0
    });

    const rafRef = useRef<number>();

    // --- Handlers ---

    const handleSaveSettings = (settings: AppSettings) => {
        setAppSettings(settings);
        saveSettings(settings);
    };

    const handleWelcomeNoticeConfirm = () => {
        localStorage.setItem('welcome_notice_seen', 'true');
        setShowWelcomeNotice(false);
    };

    const handleProviderChange = useCallback((nodeId: string, providerId: string) => {
        setNodes(prev => prev.map(n =>
            n.id === nodeId ? { ...n, providerId, modelId: undefined } : n
        ));
        // 切换提供商时清空 modelId，让 UI 自动选择该提供商的第一个模型。
    }, []);

    const handleModelChange = useCallback((nodeId: string, modelId: string) => {
        setNodes(prev => prev.map(n =>
            n.id === nodeId ? {
                ...n,
                modelId,
                params: n.params ? { ...n.params, model: modelId } : n.params
            } : n
        ));
    }, []);

    const handleComposeSelected = useCallback((nodeIds?: Set<string>) => {
        const ids = nodeIds || selectedNodeIds;
        const imagesToCompose = nodes
            .filter(n => ids.has(n.id) && n.content && (n.type === 'image' || n.type === 'video'))
            .map(n => n.content!);

        if (imagesToCompose.length === 0) {
            alert('请先选择包含图片的节点');
            return;
        }

        setComposerInitialImages(imagesToCompose);
        setIsImageComposerOpen(true);
        setContextMenu(null);
    }, [nodes, selectedNodeIds]);

    const selectedImageCount = nodes.filter(n => selectedNodeIds.has(n.id) && n.type === 'image' && n.source !== 'grid').length;

    const handleArrangeSelectedImages = useCallback((mode: 'horizontal' | 'vertical' | 'grid' = 'grid') => {
        const selectedImages = nodes
            .filter(n => selectedNodeIds.has(n.id) && n.type === 'image' && n.source !== 'grid')
            .sort((a, b) => {
                const rowDelta = a.position.y - b.position.y;
                if (Math.abs(rowDelta) > 24) return rowDelta;
                return a.position.x - b.position.x;
            });

        if (selectedImages.length < 2) return;

        const minX = Math.min(...selectedImages.map(n => n.position.x));
        const minY = Math.min(...selectedImages.map(n => n.position.y));
        const maxWidth = Math.max(...selectedImages.map(n => n.width));
        const maxHeight = Math.max(...selectedImages.map(n => n.height));
        const gap = 36;
        const columns = Math.ceil(Math.sqrt(selectedImages.length));
        const cellWidth = maxWidth + gap;
        const cellHeight = maxHeight + gap;
        const arrangedIds = new Set(selectedImages.map(n => n.id));
        const nextPositions = new Map(
            selectedImages.map((node, index) => {
                const col = mode === 'vertical' ? 0 : mode === 'horizontal' ? index : index % columns;
                const row = mode === 'horizontal' ? 0 : mode === 'vertical' ? index : Math.floor(index / columns);
                return [
                    node.id,
                    {
                        x: minX + col * cellWidth + (maxWidth - node.width) / 2,
                        y: minY + row * cellHeight + (maxHeight - node.height) / 2
                    }
                ];
            })
        );

        setNodes(prev => prev.map(node => {
            if (!arrangedIds.has(node.id)) return node;
            const position = nextPositions.get(node.id);
            return position ? { ...node, position } : node;
        }));
        setSelectedNodeIds(new Set(selectedImages.map(n => n.id)));
        setSelectedGroupId(null);
        setSelectedConnectionId(null);
        setContextMenu(null);
    }, [nodes, selectedNodeIds]);

    const handleComposerSendToCard = useCallback(async (blob: Blob) => {
        const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        // Create a File object from the Blob to match createImageNodeAt's signature
        const file = new File([blob], `composition_${Date.now()}.png`, { type: 'image/png' });
        await createImageNodeAt(file, center.x - 170, center.y - 120);
        setIsImageComposerOpen(false);
        // Optionally clear composer state? User said "close and clear" for X button, 
        // for this action we also probably want to close it.
    }, [screenToCanvas, isAutoResize]);

    const handleCopyTopPrompt = useCallback(async (promptId: string, content: string) => {
        try {
            const copied = await writeClipboardText(content);
            if (!copied) throw new Error('Browser rejected clipboard copy');
            setCopiedTopPromptId(promptId);
            window.setTimeout(() => setCopiedTopPromptId(null), 1600);
        } catch (error) {
            console.error('Failed to copy prompt:', error);
        }
    }, [writeClipboardText]);

    const saveCustomTopPrompts = useCallback((prompts: TopPromptPreset[]) => {
        const next = dedupeTopPromptPresets(prompts);
        setCustomTopPrompts(next);
        localStorage.setItem(TOP_PROMPT_STORAGE_KEY, JSON.stringify(next));
    }, []);

    const handleExportTopPrompts = useCallback(() => {
        const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            prompts: customTopPrompts
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `X-tapnow-prompt-presets-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, [customTopPrompts]);

    const handleImportTopPromptsClick = useCallback(() => {
        topPromptImportInputRef.current?.click();
    }, []);

    const handleTopPromptImportFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result || 'null'));
                const imported = extractTopPromptPresets(parsed);
                if (imported.length === 0) {
                    alert('未找到可导入的提示词预设');
                    return;
                }

                const next = dedupeTopPromptPresets([...imported, ...customTopPrompts]);
                saveCustomTopPrompts(next);
                alert(`导入成功：${next.length - customTopPrompts.length} 条新提示词`);
            } catch (error) {
                console.error('Failed to import top prompt presets:', error);
                alert('导入失败：JSON 格式不正确');
            } finally {
                if (topPromptImportInputRef.current) {
                    topPromptImportInputRef.current.value = '';
                }
            }
        };
        reader.onerror = () => {
            alert('导入失败：无法读取文件');
            if (topPromptImportInputRef.current) {
                topPromptImportInputRef.current.value = '';
            }
        };
        reader.readAsText(file);
    }, [customTopPrompts, saveCustomTopPrompts]);

    const handleAddTopPrompt = useCallback(() => {
        const title = newTopPromptTitle.trim();
        const content = newTopPromptContent.trim();
        if (!title || !content) return;

        const nextPrompt: TopPromptPreset = {
            id: `custom-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title,
            category: newTopPromptCategory,
            content,
            createdAt: Date.now()
        };

        saveCustomTopPrompts([nextPrompt, ...customTopPrompts]);
        setNewTopPromptTitle('');
        setNewTopPromptContent('');
        setNewTopPromptCategory('产品');
        setIsAddingTopPrompt(false);
        setActiveTopPromptCategory(nextPrompt.category);
    }, [customTopPrompts, newTopPromptCategory, newTopPromptContent, newTopPromptTitle, saveCustomTopPrompts]);

    // 澶勭悊鏂板缓宸ョ▼鍒嗛暅缁撴灉 - 灏嗗垎闀滆浆鎹负鑺傜偣
    // 澶勭悊鏂板缓宸ョ▼鍒嗛暅缁撴灉 - 灏嗗垎闀滆浆鎹负鑺傜偣
    const handleCreateProjectFromShots = useCallback((projectName: string, shots: Shot[]) => {
        if (shots.length === 0) return;

        // 鏍囧噯鑺傜偣灏哄 (鍙傝€?addNewTextNode 鍜?addNewVideoNode)
        const TEXT_NODE_WIDTH = 340;
        const TEXT_NODE_HEIGHT = 240;
        const VIDEO_NODE_WIDTH = 480;
        const VIDEO_NODE_HEIGHT = 320;

        const GAP_X = 100;

        // 鍒嗙粍閰嶇疆
        const GROUP_PADDING = 30;
        const GROUP_HEADER = 40;

        // 璁＄畻鍒嗙粍鎬诲楂?        // 甯冨眬: [Text] --gap-- [Text] --gap-- [Video]
        const GROUP_WIDTH = TEXT_NODE_WIDTH + GAP_X + TEXT_NODE_WIDTH + GAP_X + VIDEO_NODE_WIDTH + GROUP_PADDING * 2;
        const GROUP_HEIGHT = Math.max(TEXT_NODE_HEIGHT, VIDEO_NODE_HEIGHT) + GROUP_PADDING * 2 + GROUP_HEADER;
        const ROW_SPACING = GROUP_HEIGHT + 60; // 缁勯棿璺?
        // Starting Position (Centered roughly)
        const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        const startX = center.x - GROUP_WIDTH / 2; // Center the group horizontally
        const startY = center.y - (shots.length * ROW_SPACING) / 2;

        const newNodes: NodeData[] = [];
        const newConnections: Connection[] = [];
        const newGroups: GroupData[] = [];

        shots.forEach((shot, index) => {
            const rowY = startY + index * ROW_SPACING;

            // 鍒涘缓鍒嗙粍
            const groupId = `g-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 9)}`;
            const group: GroupData = {
                id: groupId,
                title: `${projectName} - 闀滃ご ${index + 1}`,
                position: { x: startX, y: rowY },
                width: GROUP_WIDTH,
                height: GROUP_HEIGHT,
                // color: '#1e1e24' // Optional: default group color
            };
            newGroups.push(group);

            // 鑺傜偣璧峰鍧愭爣 (鐩稿浜庝笘鐣屽潗鏍?
            const nodesStartX = startX + GROUP_PADDING;
            const nodesStartY = rowY + GROUP_HEADER + GROUP_PADDING;

            // 鍨傜洿灞呬腑鍋忕Щ (浠ユ渶楂樼殑鑺傜偣涓哄熀鍑?
            const maxHeight = Math.max(TEXT_NODE_HEIGHT, VIDEO_NODE_HEIGHT);
            const textCenterOffsetY = (maxHeight - TEXT_NODE_HEIGHT) / 2;
            const videoCenterOffsetY = (maxHeight - VIDEO_NODE_HEIGHT) / 2;

            // 1. Text Node (Script)
            const textNodeId = `n-${Date.now()}-${index}-text-${Math.random().toString(36).substr(2, 9)}`;
            const textNode: NodeData = {
                id: textNodeId,
                type: 'text',
                title: `${projectName} - 闀滃ご ${index + 1} (鍓ф湰)`,
                content: shot.text,
                position: { x: nodesStartX, y: nodesStartY + textCenterOffsetY },
                width: TEXT_NODE_WIDTH,
                height: TEXT_NODE_HEIGHT,
                status: 'idle',
                progress: 0,
                groupId: groupId
            };

            // 2. Text Node (Prompt)
            const promptNodeId = `n-${Date.now()}-${index}-prompt-${Math.random().toString(36).substr(2, 9)}`;
            const promptNode: NodeData = {
                id: promptNodeId,
                type: 'text',
                title: `镜头 ${index + 1} 提示词`,
                content: '', // Empty content
                position: { x: nodesStartX + TEXT_NODE_WIDTH + GAP_X, y: nodesStartY + textCenterOffsetY },
                width: TEXT_NODE_WIDTH,
                height: TEXT_NODE_HEIGHT,
                status: 'idle',
                progress: 0,
                groupId: groupId
            };

            // 3. Video Node (Output)
            const videoNodeId = `n-${Date.now()}-${index}-video-${Math.random().toString(36).substr(2, 9)}`;
            const videoNode: NodeData = {
                id: videoNodeId,
                type: 'video',
                title: `闀滃ご ${index + 1} 瑙嗛`,
                position: { x: nodesStartX + (TEXT_NODE_WIDTH + GAP_X) * 2, y: nodesStartY + videoCenterOffsetY },
                width: VIDEO_NODE_WIDTH,
                height: VIDEO_NODE_HEIGHT,
                status: 'idle',
                progress: 0,
                groupId: groupId,
                // Default video params
                params: {
                    model: 'sora-2',
                    aspectRatio: '16:9',
                    resolution: '1280x720',
                    batchSize: 1
                }
            };

            // Add Nodes
            newNodes.push(textNode, promptNode, videoNode);

            // Add Connections
            newConnections.push(
                {
                    id: `c-${Date.now()}-${index}-1-${Math.random().toString(36).substr(2, 9)}`,
                    fromNodeId: textNodeId,
                    toNodeId: promptNodeId
                },
                {
                    id: `c-${Date.now()}-${index}-2-${Math.random().toString(36).substr(2, 9)}`,
                    fromNodeId: promptNodeId,
                    toNodeId: videoNodeId
                }
            );
        });

        // Update State
        setNodes(prev => [...prev, ...newNodes]);
        setConnections(prev => [...prev, ...newConnections]);
        setGroups(prev => [...prev, ...newGroups]);

        // Close Modal
        setIsNewProjectModalOpen(false);

        // Center Viewport on the first group
        setViewport({
            x: window.innerWidth / 2 - (startX + GROUP_WIDTH / 2),
            y: window.innerHeight / 2 - startY,
            k: 0.6 // Zoom out a bit to see more
        });
    }, [screenToCanvas]);

    // Handle Mouse Down only for Selection (Pan is handled by InfiniteCanvas)
    const handleCanvasMouseDown = (e: React.MouseEvent) => {
        setContextMenu(null); // Close context menu
        // InfiniteCanvas captures Space+Click and Middle Click for Panning.
        // This callback is only fired for other clicks (e.g. Left Click on background).

        if (e.button === 0) {
            setSelectedGroupId(null); // Clear group selection
            // Start Box Selection in World Coordinates
            const worldPos = screenToCanvas(e.clientX, e.clientY);
            selectionBaseIdsRef.current = e.shiftKey ? new Set(selectedNodeIdsRef.current) : new Set();
            const nextSelectionBox = {
                startWorldX: worldPos.x,
                startWorldY: worldPos.y,
                currentWorldX: worldPos.x,
                currentWorldY: worldPos.y
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!e.shiftKey) {
                setSelectedNodeIds(new Set()); // Clear if not adding
            }
        }
    };

    const handleNodeMouseDown = useCallback((e: React.MouseEvent, id: string) => {
        setContextMenu(null); // Close context menu
        e.stopPropagation(); // Prevent canvas pan/select logic
        if (e.button === 0) {
            setSelectedConnectionId(null);

            // Access latest state via refs
            const currentSelected = selectedNodeIdsRef.current;
            const currentNodes = nodesRef.current;

            // Selection Logic
            let newSelected = new Set(currentSelected);

            if (e.shiftKey || e.ctrlKey || e.metaKey) {
                // Toggle
                if (newSelected.has(id)) {
                    newSelected.delete(id);
                } else {
                    newSelected.add(id);
                }
            } else {
                // If clicking an unselected node without modifiers, select ONLY it
                // If clicking a selected node without modifiers, KEEP selection (to allow dragging group)
                if (!newSelected.has(id)) {
                    newSelected.clear();
                    newSelected.add(id);
                }
            }
            setSelectedNodeIds(newSelected);

            const node = currentNodes.find(n => n.id === id);
            if (!node) return;

            dragRef.current.isDraggingNode = true;
            dragRef.current.nodeId = id; // Primary drag node
            dragRef.current.startX = e.clientX;
            dragRef.current.startY = e.clientY;

            // Store initial positions of ALL selected nodes for group drag
            // We can re-use 'initialNodePos' but we need it for all selected nodes.
            // Let's modify dragRef to support multiple.
            // But 'types' is hard to change in dragRef without refactor.
            // Let's just assume we calculate deltas in MouseMove using 'startX'.
            dragRef.current.initialNodePos = { ...node.position }; // Used for single delta bounds check if needed

            // We need to capture the initial positions of ALL nodes to drag them correctly
            // Let's verify we can do this without complex state.
            // In MouseMove, we calculate dx, dy. We apply this dx,dy to specific node's initial pos.
            // So we need initial positions.
            // Let's add a temporary property to nodes? No.
            // Custom Ref property
            (dragRef.current as any).initialSelectedNodes = currentNodes.filter(n => newSelected.has(n.id)).map(n => ({ id: n.id, x: n.position.x, y: n.position.y }));
        }
    }, []);

    const handleNodeClick = useCallback((e: React.MouseEvent, id: string) => {
        // Pure selection toggle, no drag initiation
        e.stopPropagation();

        const currentSelected = selectedNodeIdsRef.current;
        let newSelected = new Set(currentSelected);
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            // Toggle
            if (newSelected.has(id)) {
                newSelected.delete(id);
            } else {
                newSelected.add(id);
            }
        } else {
            // Select Only
            newSelected.clear();
            newSelected.add(id);
        }
        setSelectedNodeIds(newSelected);
        setSelectedConnectionId(null);
    }, []);

    const handleNodeDoubleClick = useCallback((nodeId: string) => {
        const node = nodesRef.current.find(n => n.id === nodeId);
        if (!node) return;

        // Calculate node center in world coordinates.
        const nodeCenterX = node.position.x + node.width / 2;
        const nodeCenterY = node.position.y + node.height / 2;

        // 璁＄畻灞忓箷涓績
        const screenCenterX = window.innerWidth / 2;
        const screenCenterY = window.innerHeight / 2;

        // 鐩爣缂╂斁姣斾緥锛氶€備腑鐨勬斁澶э紝鏃㈣兘鐪嬫竻鍗＄墖鍙堜笉浼氳繃浜庢斁澶?        const targetScale = 1.2;

        // 璁＄畻鏂扮殑 viewport 鍋忕Щ閲忥紝浣胯妭鐐逛腑蹇冨榻愬埌灞忓箷涓績
        // 灞忓箷鍧愭爣 = viewport.x + 涓栫晫鍧愭爣 * scale
        // 鎴戜滑甯屾湜锛歴creenCenterX = newX + nodeCenterX * targetScale
        // 鍥犳锛歯ewX = screenCenterX - nodeCenterX * targetScale
        const newX = screenCenterX - nodeCenterX * targetScale;
        const newY = screenCenterY - nodeCenterY * targetScale;

        // 浣跨敤鍔ㄧ敾骞虫粦杩囨浮
        const currentViewport = viewportRef.current;
        const startX = currentViewport.x;
        const startY = currentViewport.y;
        const startK = currentViewport.k;

        const duration = 300; // 鍔ㄧ敾鎸佺画鏃堕棿锛堟绉掞級
        const startTime = performance.now();

        const animate = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // 浣跨敤缂撳姩鍑芥暟 (easeInOutCubic)
            const eased = progress < 0.5
                ? 4 * progress * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            setViewport({
                x: startX + (newX - startX) * eased,
                y: startY + (newY - startY) * eased,
                k: startK + (targetScale - startK) * eased
            });

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        requestAnimationFrame(animate);
    }, []);

    // --- Group Handlers ---

    const handleCreateGroup = (nodeIds?: string[], position?: Position) => {
        let x = 0, y = 0, w = 300, h = 200;
        let includedNodeIds: string[] = [];

        if (nodeIds && nodeIds.length > 0) {
            includedNodeIds = nodeIds;
            const selectedNodes = nodes.filter(n => nodeIds.includes(n.id));
            if (selectedNodes.length > 0) {
                const minX = Math.min(...selectedNodes.map(n => n.position.x));
                const minY = Math.min(...selectedNodes.map(n => n.position.y));
                const maxX = Math.max(...selectedNodes.map(n => n.position.x + n.width));
                const maxY = Math.max(...selectedNodes.map(n => n.position.y + n.height));

                const padding = 20;
                x = minX - padding;
                y = minY - padding - 40;
                w = maxX - minX + padding * 2;
                h = maxY - minY + padding * 2 + 40;
            }
        } else if (position) {
            x = position.x;
            y = position.y;
        } else {
            const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
            x = center.x - 150;
            y = center.y - 100;
        }

        const newGroup: GroupData = {
            id: `g-${Date.now()}`,
            title: 'New Group',
            position: { x, y },
            width: w,
            height: h
        };

        setGroups(prev => [...prev, newGroup]);
        if (includedNodeIds.length > 0) {
            setNodes(prev => prev.map(n => includedNodeIds.includes(n.id) ? { ...n, groupId: newGroup.id } : n));
        }
    };

    const handleGroupTitleChange = (groupId: string, newTitle: string) => {
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, title: newTitle } : g));
    };

    const handleGroupColorChange = (groupId: string, colorClass: string) => {
        setGroups(prev => prev.map(g => g.id === groupId ? { ...g, color: colorClass } : g));
    };

    const handleGroupResizeStart = (e: React.MouseEvent, groupId: string, direction: 'nw' | 'ne' | 'sw' | 'se') => {
        e.stopPropagation();
        e.preventDefault();
        const group = groups.find(g => g.id === groupId);
        if (!group) return;

        setResizingGroup({
            groupId,
            direction,
            startX: e.clientX,
            startY: e.clientY,
            initialX: group.position.x,
            initialY: group.position.y,
            initialW: group.width,
            initialH: group.height
        });
    };

    const handleDeleteGroup = (groupId: string, deleteContent: boolean) => {
        recordCanvasUndoSnapshot();
        setGroups(prev => prev.filter(g => g.id !== groupId));
        if (deleteContent) {
            setNodes(prev => prev.filter(n => n.groupId !== groupId));
            // Also cleanup connections
            setConnections(prev => prev.filter(c => {
                const nodeIds = nodes.filter(n => n.groupId === groupId).map(n => n.id);
                return !nodeIds.includes(c.fromNodeId) && !nodeIds.includes(c.toNodeId);
            }));
        } else {
            setNodes(prev => prev.map(n => n.groupId === groupId ? { ...n, groupId: undefined } : n));
        }
    };

    const handleGroupContextMenu = (e: React.MouseEvent, groupId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            type: 'group',
            groupId
        });
    };

    const handleGroupMouseDown = useCallback((e: React.MouseEvent, groupId: string) => {
        e.stopPropagation();
        setContextMenu(null);
        setSelectedGroupId(groupId);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setDraggingGroupId(groupId);

        dragRef.current.isDraggingGroup = true;
        dragRef.current.groupId = groupId;
        dragRef.current.startX = e.clientX;
        dragRef.current.startY = e.clientY;

        const currentGroups = groupsRef.current;
        const currentNodes = nodesRef.current;

        const group = currentGroups.find(g => g.id === groupId);
        const children = group
            ? currentNodes.filter(n => {
                if (n.source === 'grid') return false;
                if (n.groupId === groupId) return true;
                const nodeCenterX = n.position.x + n.width / 2;
                const nodeCenterY = n.position.y + n.height / 2;
                return (
                    nodeCenterX >= group.position.x &&
                    nodeCenterX <= group.position.x + group.width &&
                    nodeCenterY >= group.position.y &&
                    nodeCenterY <= group.position.y + group.height
                );
            })
            : [];

        if (group) {
            (dragRef.current as any).initialGroupState = { ...group };
            (dragRef.current as any).initialGroupChildren = children.map(n => ({ id: n.id, x: n.position.x, y: n.position.y }));
        }
    }, []);

    const handleGlobalMouseMove = useCallback((e: MouseEvent | PointerEvent) => {
        const viewport = viewportRef.current;
        const resizingGroup = resizingGroupRef.current;
        const selectionBox = selectionBoxRef.current;
        const connectingParams = connectingParamsRef.current;

        // Group Resizing
        if (resizingGroup) {
            const dx = (e.clientX - resizingGroup.startX) / viewport.k;
            const dy = (e.clientY - resizingGroup.startY) / viewport.k;

            let newX = resizingGroup.initialX;
            let newY = resizingGroup.initialY;
            let newW = resizingGroup.initialW;
            let newH = resizingGroup.initialH;

            if (resizingGroup.direction.includes('e')) newW = Math.max(100, resizingGroup.initialW + dx);
            if (resizingGroup.direction.includes('s')) newH = Math.max(60, resizingGroup.initialH + dy);
            if (resizingGroup.direction.includes('w')) {
                const w = Math.max(100, resizingGroup.initialW - dx);
                newX = resizingGroup.initialX + (resizingGroup.initialW - w);
                newW = w;
            }
            if (resizingGroup.direction.includes('n')) {
                const h = Math.max(60, resizingGroup.initialH - dy);
                newY = resizingGroup.initialY + (resizingGroup.initialH - h);
                newH = h;
            }

            // Direct DOM manipulation for smooth resizing
            const groupEl = document.querySelector(`[data-group-id="${resizingGroup.groupId}"]`) as HTMLElement;
            if (groupEl) {
                groupEl.style.width = `${newW}px`;
                groupEl.style.height = `${newH}px`;
                groupEl.style.transform = `translate(${newX}px, ${newY}px)`;
            }
            return;
        }

        // Group Dragging (React State with RAF throttling)
        if (dragRef.current.isDraggingGroup && dragRef.current.groupId) {
            const dx = (e.clientX - dragRef.current.startX) / viewport.k;
            const dy = (e.clientY - dragRef.current.startY) / viewport.k;

            const initialGroup = (dragRef.current as any).initialGroupState;
            const children = (dragRef.current as any).initialGroupChildren;

            // Use RAF to throttle state updates for smooth performance
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }

            rafRef.current = requestAnimationFrame(() => {
                // Update Group Position
                setGroups(prev => prev.map(g =>
                    g.id === dragRef.current.groupId
                        ? { ...g, position: { x: initialGroup.position.x + dx, y: initialGroup.position.y + dy } }
                        : g
                ));

                // Update Children Positions
                if (children && children.length > 0) {
                    setNodes(prev => prev.map(n => {
                        const child = children.find((c: any) => c.id === n.id);
                        if (child) {
                            return { ...n, position: { x: child.x + dx, y: child.y + dy } };
                        }
                        return n;
                    }));
                }
            });
            return;
        }

        // Node Dragging (React State with RAF throttling)
        if (dragRef.current.isDraggingNode && (dragRef.current as any).initialSelectedNodes) {
            const dx = (e.clientX - dragRef.current.startX) / viewport.k;
            const dy = (e.clientY - dragRef.current.startY) / viewport.k;

            const initialPositions = (dragRef.current as any).initialSelectedNodes as { id: string, x: number, y: number }[];

            // Use RAF to throttle state updates
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }

            rafRef.current = requestAnimationFrame(() => {
                setNodes(prev => prev.map(n => {
                    const init = initialPositions.find(p => p.id === n.id);
                    if (init) {
                        return { ...n, position: { x: init.x + dx, y: init.y + dy } };
                    }
                    return n;
                }));
            });
            return;
        }

        // Only update mouse position state if it's visually needed (e.g. drawing connection line)
        if (connectingParams) {
            setMousePos({ x: e.clientX, y: e.clientY });
        }

        // Box Selection
        if (selectionBox) {
            const worldPos = screenToCanvas(e.clientX, e.clientY);
            if (selectionRafRef.current) {
                cancelAnimationFrame(selectionRafRef.current);
            }
            selectionRafRef.current = requestAnimationFrame(() => {
                setSelectionBox(prev => {
                    if (!prev) return null;
                    const nextSelectionBox = { ...prev, currentWorldX: worldPos.x, currentWorldY: worldPos.y };
                    selectionBoxRef.current = nextSelectionBox;
                    return nextSelectionBox;
                });
                selectionRafRef.current = undefined;
            });
        }
    }, [screenToCanvas, nodesRef]);

    const handleGlobalMouseUp = useCallback((e: MouseEvent | PointerEvent) => {
        const viewport = viewportRef.current;
        const resizingGroup = resizingGroupRef.current;
        const connectingParams = connectingParamsRef.current;
        const groups = groupsRef.current;
        const activeSelectionBox = selectionBoxRef.current;

        // Group Resizing End
        if (resizingGroup) {
            const dx = (e.clientX - resizingGroup.startX) / viewport.k;
            const dy = (e.clientY - resizingGroup.startY) / viewport.k;

            setGroups(prev => prev.map(g => {
                if (g.id === resizingGroup.groupId) {
                    let newX = resizingGroup.initialX;
                    let newY = resizingGroup.initialY;
                    let newW = resizingGroup.initialW;
                    let newH = resizingGroup.initialH;

                    if (resizingGroup.direction.includes('e')) newW = Math.max(100, resizingGroup.initialW + dx);
                    if (resizingGroup.direction.includes('s')) newH = Math.max(60, resizingGroup.initialH + dy);
                    if (resizingGroup.direction.includes('w')) {
                        const w = Math.max(100, resizingGroup.initialW - dx);
                        newX = resizingGroup.initialX + (resizingGroup.initialW - w);
                        newW = w;
                    }
                    if (resizingGroup.direction.includes('n')) {
                        const h = Math.max(60, resizingGroup.initialH - dy);
                        newY = resizingGroup.initialY + (resizingGroup.initialH - h);
                        newH = h;
                    }

                    return { ...g, position: { x: newX, y: newY }, width: newW, height: newH };
                }
                return g;
            }));
            setResizingGroup(null);
            return;
        }

        // Group Dragging End - Clean up and ensure final position sync
        if (dragRef.current.isDraggingGroup && dragRef.current.groupId) {
            // Cancel any pending RAF
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = undefined;
            }

            // Final position update to ensure accuracy
            const dx = (e.clientX - dragRef.current.startX) / viewport.k;
            const dy = (e.clientY - dragRef.current.startY) / viewport.k;
            const initialGroup = (dragRef.current as any).initialGroupState;
            const children = (dragRef.current as any).initialGroupChildren;

            setGroups(prev => prev.map(g =>
                g.id === dragRef.current.groupId
                    ? { ...g, position: { x: initialGroup.position.x + dx, y: initialGroup.position.y + dy } }
                    : g
            ));

            if (children && children.length > 0) {
                setNodes(prev => prev.map(n => {
                    const child = children.find((c: any) => c.id === n.id);
                    if (child) {
                        return { ...n, position: { x: child.x + dx, y: child.y + dy } };
                    }
                    return n;
                }));
            }

            // Clean up
            setDraggingGroupId(null);
            dragRef.current.isDraggingGroup = false;
            dragRef.current.groupId = null;
            (dragRef.current as any).initialGroupState = null;
            (dragRef.current as any).initialGroupChildren = null;
            return;
        }

        // Node Dragging End - Clean up and apply grouping logic
        if (dragRef.current.isDraggingNode && (dragRef.current as any).initialSelectedNodes) {
            // Cancel any pending RAF
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = undefined;
            }

            const dx = (e.clientX - dragRef.current.startX) / viewport.k;
            const dy = (e.clientY - dragRef.current.startY) / viewport.k;

            const initialPositions = (dragRef.current as any).initialSelectedNodes as { id: string, x: number, y: number }[];
            const affectedIds = new Set(initialPositions.map(p => p.id));

            // Final position update with sticky grouping logic
            setNodes(prev => prev.map(n => {
                if (affectedIds.has(n.id)) {
                    const init = initialPositions.find(p => p.id === n.id);
                    if (init) {
                        const newX = init.x + dx;
                        const newY = init.y + dy;

                        // Sticky Grouping Logic
                        let newGroupId = n.groupId;
                        const cx = newX + n.width / 2;
                        const cy = newY + n.height / 2;

                        // Check if dropped into a group
                        const targetGroup = groups.find(g =>
                            !g.collapsed &&
                            cx >= g.position.x && cx <= g.position.x + g.width &&
                            cy >= g.position.y && cy <= g.position.y + g.height
                        );

                        if (targetGroup) {
                            newGroupId = targetGroup.id;
                        } else {
                            // Check if moved out of current group
                            if (n.groupId) {
                                const currentGroup = groups.find(g => g.id === n.groupId);
                                if (currentGroup) {
                                    const inGroup =
                                        cx >= currentGroup.position.x && cx <= currentGroup.position.x + currentGroup.width &&
                                        cy >= currentGroup.position.y && cy <= currentGroup.position.y + currentGroup.height;
                                    if (!inGroup) {
                                        newGroupId = undefined;
                                    }
                                } else {
                                    newGroupId = undefined;
                                }
                            }
                        }
                        return { ...n, position: { x: newX, y: newY }, groupId: newGroupId };
                    }
                }
                return n;
            }));

            // Clean up
            dragRef.current.isDraggingNode = false;
            dragRef.current.nodeId = null;
            (dragRef.current as any).initialSelectedNodes = null;
        }

        if (activeSelectionBox) {
            if (selectionRafRef.current) {
                cancelAnimationFrame(selectionRafRef.current);
                selectionRafRef.current = undefined;
            }

            const worldPos = screenToCanvas(e.clientX, e.clientY);
            const rectX = Math.min(activeSelectionBox.startWorldX, worldPos.x);
            const rectY = Math.min(activeSelectionBox.startWorldY, worldPos.y);
            const rectW = Math.abs(worldPos.x - activeSelectionBox.startWorldX);
            const rectH = Math.abs(worldPos.y - activeSelectionBox.startWorldY);

            const newSelection = new Set(selectionBaseIdsRef.current);
            nodesRef.current.forEach(n => {
                if (
                    n.source !== 'grid' &&
                    rectX < n.position.x + n.width &&
                    rectX + rectW > n.position.x &&
                    rectY < n.position.y + n.height &&
                    rectY + rectH > n.position.y
                ) {
                    newSelection.add(n.id);
                }
            });

            setSelectedNodeIds(newSelection);
            selectionBaseIdsRef.current = new Set();
        }

        setSelectionBox(null);
        selectionBoxRef.current = null;

        // Handle dropped connection on canvas
        if (connectingParams) {
            const targetHandleType = connectingParams.handleType === 'source' ? 'target' : 'source';
            const sourceIds = connectingParams.nodeIds && connectingParams.nodeIds.length > 0
                ? connectingParams.nodeIds
                : [connectingParams.nodeId];
            const sourceIdSet = new Set(sourceIds);
            let nearestTarget: NodeData | null = null;
            let nearestDistance = CONNECTION_SNAP_DISTANCE_PX;

            nodesRef.current.forEach(node => {
                if (node.source === 'grid' || sourceIdSet.has(node.id)) return;

                const handleCanvasX = targetHandleType === 'target'
                    ? node.position.x
                    : node.position.x + node.width;
                const handleCanvasY = node.position.y + node.height / 2;
                const handleScreenX = viewport.x + handleCanvasX * viewport.k;
                const handleScreenY = viewport.y + handleCanvasY * viewport.k;
                const distance = Math.hypot(e.clientX - handleScreenX, e.clientY - handleScreenY);

                if (distance <= nearestDistance) {
                    nearestDistance = distance;
                    nearestTarget = node;
                }
            });

            if (nearestTarget) {
                const targetNodeId = nearestTarget.id;
                const existing = new Set(connectionsRef.current.map(connection => `${connection.fromNodeId}->${connection.toNodeId}`));
                const nextConnections: Connection[] = [];

                sourceIds.forEach((sourceId, index) => {
                    const fromNodeId = connectingParams.handleType === 'source' ? sourceId : targetNodeId;
                    const toNodeId = connectingParams.handleType === 'source' ? targetNodeId : sourceId;
                    const key = `${fromNodeId}->${toNodeId}`;
                    if (fromNodeId === toNodeId || existing.has(key)) return;

                    existing.add(key);
                    nextConnections.push({
                        id: `c-snap-${Date.now()}-${index}`,
                        fromNodeId,
                        toNodeId
                    });
                });

                if (nextConnections.length > 0) {
                    setConnections(previous => [...previous, ...nextConnections]);
                }
                setContextMenu(null);
                setConnectingParams(null);
                return;
            }

            const canvasX = (e.clientX - viewport.x) / viewport.k;
            const canvasY = (e.clientY - viewport.y) / viewport.k;

            setContextMenu({
                x: e.clientX,
                y: e.clientY,
                type: 'canvas',
                canvasX,
                canvasY,
                connectionSource: connectingParams
            });
        }

        setConnectingParams(null);
    }, [screenToCanvas]);

    const handleGlobalPointerMove = useCallback((e: PointerEvent) => {
        if (selectionBoxRef.current) {
            handleGlobalMouseMove(e);
        }
    }, [handleGlobalMouseMove]);

    const handleGlobalPointerUp = useCallback((e: PointerEvent) => {
        if (selectionBoxRef.current) {
            handleGlobalMouseUp(e);
        }
    }, [handleGlobalMouseUp]);

    useEffect(() => {
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        window.addEventListener('pointermove', handleGlobalPointerMove);
        window.addEventListener('pointerup', handleGlobalPointerUp);
        return () => {
            window.removeEventListener('mousemove', handleGlobalMouseMove);
            window.removeEventListener('mouseup', handleGlobalMouseUp);
            window.removeEventListener('pointermove', handleGlobalPointerMove);
            window.removeEventListener('pointerup', handleGlobalPointerUp);
        };
    }, [handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove, handleGlobalPointerUp]);


    // --- Connection Logic ---

    const handleConnectStart = (e: React.MouseEvent, nodeId: string, handleType: 'source' | 'target') => {
        // Start connection dragging from either input or output
        e.stopPropagation();
        setMousePos({ x: e.clientX, y: e.clientY });
        setConnectingParams({ nodeId, handleType });
    };

    const handleUnifiedConnectStart = (e: React.MouseEvent, nodeIds: string[]) => {
        e.stopPropagation();
        e.preventDefault();
        if (nodeIds.length === 0) return;

        setConnectingParams({
            nodeId: nodeIds[0],
            nodeIds,
            handleType: 'source'
        });
        setMousePos({ x: e.clientX, y: e.clientY });
    };

    const handleConnectEnd = (e: React.MouseEvent, targetNodeId: string, targetHandleType: 'source' | 'target') => {
        if (!connectingParams) return;

        e.stopPropagation();

        const sourceIds = connectingParams.nodeIds && connectingParams.nodeIds.length > 0
            ? connectingParams.nodeIds
            : [connectingParams.nodeId];

        const nextConnections: Connection[] = [];
        const existing = new Set(connections.map(c => `${c.fromNodeId}->${c.toNodeId}`));

        if (
            !(
                (connectingParams.handleType === 'source' && targetHandleType === 'target') ||
                (connectingParams.handleType === 'target' && targetHandleType === 'source')
            )
        ) {
            // Incompatible handles (Input->Input or Output->Output)
            setConnectingParams(null);
            return;
        }

        sourceIds.forEach((sourceId, index) => {
            const fromNodeId = connectingParams.handleType === 'source' ? sourceId : targetNodeId;
            const toNodeId = connectingParams.handleType === 'source' ? targetNodeId : sourceId;
            const key = `${fromNodeId}->${toNodeId}`;

            if (fromNodeId === toNodeId || existing.has(key)) return;
            existing.add(key);
            nextConnections.push({
                id: `c-${Date.now()}-${index}`,
                fromNodeId,
                toNodeId
            });
        });

        if (nextConnections.length > 0) {
            setConnections(prev => [...prev, ...nextConnections]);
        }

        setConnectingParams(null);
    };


    // --- Actions ---

    const createImageNodeAt = async (file: File, x: number, y: number) => {
        const url = blobToDisplayUrl(file);

        const create = (w: number, h: number, imageWidth?: number, imageHeight?: number) => {
            const newNode: NodeData = {
                id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'image',
                position: { x, y },
                width: w,
                height: h,
                title: file.name,
                content: url,
                blob: file,
                isReferenceImage: true,
                imageWidth,
                imageHeight,
                status: 'success'
            };
            setNodes(prev => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
        };

        const img = new Image();
        img.onload = () => {
            const imageWidth = img.naturalWidth || img.width;
            const imageHeight = img.naturalHeight || img.height;
            const size = getImageNodeDisplaySize(imageWidth, imageHeight);
            create(size.width, size.height, imageWidth, imageHeight);
        };
        img.onerror = () => create(340, 240);
        img.src = url;
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        for (const f of files) {
            const file = f as File;
            if (file.type.startsWith('image/')) {
                const pos = screenToCanvas(e.clientX, e.clientY);
                await createImageNodeAt(file, pos.x - 170, pos.y - 120);
            }
        }
    };

    const handleImageInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.type.startsWith('image/')) {
            let x, y;
            if (uploadPosRef.current) {
                x = uploadPosRef.current.x - 170;
                y = uploadPosRef.current.y - 120;
                uploadPosRef.current = null;
            } else {
                const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
                x = center.x - 170;
                y = center.y - 120;
            }
            await createImageNodeAt(file, x, y);
        }

        // Reset input
        if (imageInputRef.current) {
            imageInputRef.current.value = '';
        }
    };

    // Paste Handling
    useEffect(() => {
        const handlePaste = (e: ClipboardEvent) => {
            if (isImageComposerOpen) return;
            if (isEditableEventTarget(e.target)) return;
            if (!e.clipboardData) return;
            // 1. Try Image Paste
            const items = e.clipboardData.items;
            let imageFound = false;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                    const file = items[i].getAsFile();
                    if (file) {
                        e.preventDefault();
                        const pos = screenToCanvas(mousePos.x, mousePos.y);
                        createImageNodeAt(file, pos.x - 170, pos.y - 120);
                        imageFound = true;
                    }
                }
            }

            if (imageFound) return;

            // 2. Try Node Paste (Text/JSON)
            const text = e.clipboardData.getData('text');
            if (text) {
                try {
                    const data = JSON.parse(text);
                    if (data.type === 'X-tapnow-nodes' && Array.isArray(data.nodes)) {
                        e.preventDefault();
                        const restoredClipboardData = restorePortableNodeClipboardData(data);
                        const nodesToPaste = restoredClipboardData.nodes;
                        if (nodesToPaste.length === 0) return;
                        const idMap = new Map<string, string>();

                        // Calculate bounds top-left
                        let minX = Infinity, minY = Infinity;
                        nodesToPaste.forEach(n => {
                            if (n.position.x < minX) minX = n.position.x;
                            if (n.position.y < minY) minY = n.position.y;
                        });

                        const targetPos = screenToCanvas(mousePos.x, mousePos.y);

                        const newNodes = nodesToPaste.map((n, index) => {
                            const offsetX = n.position.x - minX;
                            const offsetY = n.position.y - minY;
                            const newId = `${n.type}-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 5)}`;
                            idMap.set(n.id, newId);
                            return {
                                ...n,
                                id: newId,
                                position: {
                                    x: targetPos.x + offsetX,
                                    y: targetPos.y + offsetY
                                },
                                selected: true
                            };
                        });

                        setNodes(prev => {
                            const unselected = prev.map(n => ({ ...n, selected: false }));
                            return [...unselected, ...newNodes];
                        });
                        setSelectedNodeIds(new Set(newNodes.map(n => n.id)));

                        if (Array.isArray(restoredClipboardData.connections)) {
                            const existingNodeIds = new Set(nodes.map(n => n.id));
                            const newConnections = restoredClipboardData.connections
                                .map((c: Connection, index: number) => {
                                    const fromNodeId = idMap.get(c.fromNodeId)
                                        ?? (existingNodeIds.has(c.fromNodeId) ? c.fromNodeId : undefined);
                                    const toNodeId = idMap.get(c.toNodeId)
                                        ?? (existingNodeIds.has(c.toNodeId) ? c.toNodeId : undefined);
                                    if (!fromNodeId || !toNodeId) return null;

                                    return {
                                        ...c,
                                        id: `c-paste-${Date.now()}-${index}-${Math.random().toString(36).substr(2, 5)}`,
                                        fromNodeId,
                                        toNodeId
                                    };
                                })
                                .filter((c: Connection | null): c is Connection => c !== null);

                            if (newConnections.length > 0) {
                                setConnections(prev => [...prev, ...newConnections]);
                            }
                        }
                    }
                } catch (err) {
                    // Ignore
                }
            }
        };
        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, [mousePos, viewport, isImageComposerOpen]); // Added isImageComposerOpen to dependencies

    const addAutoConnectionsForNewNode = useCallback((newNodeId: string) => {
        const source = contextMenu?.connectionSource;
        if (!source) return;

        const sourceIds = source.nodeIds && source.nodeIds.length > 0 ? source.nodeIds : [source.nodeId];
        const isFromSource = source.handleType === 'source';

        setConnections(prev => {
            const existing = new Set(prev.map(c => `${c.fromNodeId}->${c.toNodeId}`));
            const nextConnections: Connection[] = [];

            sourceIds.forEach((sourceId, index) => {
                const fromNodeId = isFromSource ? sourceId : newNodeId;
                const toNodeId = isFromSource ? newNodeId : sourceId;
                const key = `${fromNodeId}->${toNodeId}`;

                if (fromNodeId === toNodeId || existing.has(key)) return;
                existing.add(key);
                nextConnections.push({
                    id: `c-auto-${Date.now()}-${index}`,
                    fromNodeId,
                    toNodeId
                });
            });

            return nextConnections.length > 0 ? [...prev, ...nextConnections] : prev;
        });
    }, [contextMenu]);

    const addNewNode = (x?: number, y?: number) => {
        let pos;
        if (x !== undefined && y !== undefined) {
            // x, y are already canvas coordinates from context menu
            pos = { x, y };
        } else {
            // Default to screen center
            pos = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        }

        const newNode: NodeData = {
            id: `n-${Date.now()}`,
            type: 'image',
            position: { x: pos.x - 170, y: pos.y - 120 }, // Center offset
            width: 340,
            height: 240,
            title: 'New Generation',
            content: '', // Empty initially
            status: 'idle'
        };
        setNodes(prev => [...prev, newNode]);
        setSelectedNodeIds(new Set([newNode.id]));

        addAutoConnectionsForNewNode(newNode.id);
    };

    const addNewVideoNode = (x?: number, y?: number) => {
        let pos;
        if (x !== undefined && y !== undefined) {
            pos = { x, y };
        } else {
            pos = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        }

        const newNode: NodeData = {
            id: `v-${Date.now()}`,
            type: 'video',
            position: { x: pos.x - 240, y: pos.y - 160 }, // Center offset (480/2, 320/2)
            width: 480, // Video might need wider aspect
            height: 320,
            title: 'New Video',
            content: '',
            status: 'idle',
            params: {
                model: 'sora-2', // Default params for video
                aspectRatio: '16:9',
                resolution: '1280x720',
                batchSize: 1
            }
        };
        setNodes(prev => [...prev, newNode]);
        setSelectedNodeIds(new Set([newNode.id]));

        addAutoConnectionsForNewNode(newNode.id);
    };

    const addNewTextNode = (x?: number, y?: number) => {
        let pos;
        if (x !== undefined && y !== undefined) {
            pos = { x, y };
        } else {
            pos = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        }

        const newNode: NodeData = {
            id: `t-${Date.now()}`,
            type: 'text',
            position: { x: pos.x - 170, y: pos.y - 120 }, // Center offset
            width: 340,
            height: 240,
            title: 'Note',
            content: '',
            status: 'idle'
        };
        setNodes(prev => [...prev, newNode]);
        setSelectedNodeIds(new Set([newNode.id]));

        addAutoConnectionsForNewNode(newNode.id);
    };

    const addNewAudioNode = (x?: number, y?: number) => {
        let pos;
        if (x !== undefined && y !== undefined) {
            pos = { x, y };
        } else {
            pos = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        }

        const defaultProvider = appSettings.audioProviders?.find(p => p.isDefault) || appSettings.audioProviders?.[0];
        const newNode: NodeData = {
            id: `a-${Date.now()}`,
            type: 'audio',
            position: { x: pos.x - 170, y: pos.y - 110 },
            width: 340,
            height: 220,
            title: 'New Audio',
            content: '',
            status: 'idle',
            providerId: defaultProvider?.id,
            modelId: defaultProvider?.models?.[0]?.id,
            params: {
                model: defaultProvider?.models?.[0]?.id || 'gpt-4o-mini-tts',
                aspectRatio: '',
                resolution: '',
                batchSize: 1,
                seconds: '15',
                voice: 'alloy',
                format: 'mp3'
            }
        };
        setNodes(prev => [...prev, newNode]);
        setSelectedNodeIds(new Set([newNode.id]));

        addAutoConnectionsForNewNode(newNode.id);
    };

    const handlePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, prompt } : n));
    }, []);

    const handleContentChange = useCallback((nodeId: string, content: string) => {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, content } : n));
    }, []);

    const handleParamsChange = useCallback((nodeId: string, params: any) => {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, params } : n));
    }, []);

    const handleDismissError = useCallback((nodeId: string) => {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, status: 'idle' } : n));
    }, []);

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, fontSize } : n));
    }, []);


    const handleBatchGenerate = async () => {
        const nodesToGen = nodes.filter(n => selectedNodeIds.has(n.id));
        const CONCURRENCY_LIMIT = appSettings.concurrencyLimit || 15; // 浣跨敤鐢ㄦ埛璁剧疆鐨勫苟鍙戞暟

        // Queue wrapper
        const queue: (() => Promise<void>)[] = nodesToGen.map(node => async () => {
            if (node.prompt) {
                const config = node.params || {
                    model: 'gemini-2.0-flash-exp',
                    aspectRatio: '16:9',
                    resolution: '2k',
                    batchSize: 1
                };
                try {
                    await handleGenerate(node.id, node.prompt, config, true); // silent = true
                } catch (e) {
                    console.error(`Failed to generate node ${node.id}`, e);
                    // Error is already handled inside handleGenerate to update node status
                }
            }
        });

        // Worker function
        const worker = async () => {
            while (queue.length > 0) {
                const task = queue.shift();
                if (task) await task();
            }
        };

        // Start workers
        const workers = Array(Math.min(nodesToGen.length, CONCURRENCY_LIMIT)).fill(null).map(() => worker());
        await Promise.all(workers);

        // Force save after batch complete
        saveToDB();
    };

    // Helper function to get the final prompt for a node after connection processing
    const getFinalPromptForNode = useCallback((nodeId: string): string => {
        const currentNodes = nodesRef.current;
        const currentConnections = connectionsRef.current;
        const node = currentNodes.find(n => n.id === nodeId);
        if (!node) return '';

        const inputConnections = currentConnections.filter(c => c.toNodeId === nodeId);

        if (node.type === 'video') {
            // For video nodes: combine upstream text content with prompt
            const connectedTextContent = inputConnections
                .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                .filter(n => n && n.type === 'text' && n.content)
                .map(n => n!.content)
                .join(' ');

            const nodePrompt = node.prompt || '';
            let finalPrompt = connectedTextContent ? `${connectedTextContent} ${nodePrompt}` : nodePrompt;

            return finalPrompt;
        } else if (node.type === 'text') {
            // For text nodes: combine instruction (prompt) with upstream content
            const upstreamContent = inputConnections
                .map(conn => {
                    const sourceNode = currentNodes.find(n => n.id === conn.fromNodeId);
                    if (!sourceNode) return '';
                    return sourceNode.content || sourceNode.prompt || '';
                })
                .filter(Boolean)
                .join('\n\n');

            const nodePrompt = node.prompt || '';

            // Don't show system prompt in the tooltip, only the actual user input
            if (upstreamContent) {
                // Processing mode: instruction + content to process
                if (nodePrompt) {
                    return `${nodePrompt}\n\n${upstreamContent}`;
                } else {
                    return upstreamContent;
                }
            } else {
                // Creation mode: show the card's prompt
                return nodePrompt;
            }
        } else {
            const nodePrompt = node.prompt || '';
            const upstreamImages = getUpstreamReferenceImages(nodeId, currentNodes, currentConnections);
            const selectedImages = selectReferenceImagesForPrompt(nodePrompt, upstreamImages);
            const labels = selectedImages.map(image => image.label);
            const finalPrompt = buildImageInstructionPrompt(nodePrompt, {
                systemPrompt: node.params?.systemPrompt,
                selectedReferenceLabels: labels,
                upstreamReferenceCount: upstreamImages.length
            });

            return [
                '原始提示词：',
                nodePrompt || '(空)',
                '',
                `使用参考图数量：${selectedImages.length}`,
                labels.length > 0 ? `使用参考图：${labels.join('、')}` : '使用参考图：无',
                '',
                '最终发送提示词：',
                finalPrompt
            ].join('\n');
        }
    }, []);

    const getUpstreamImagesForNode = useCallback((nodeId: string) => {
        const currentNodes = nodesRef.current;
        const currentConnections = connectionsRef.current;

        return currentConnections
            .filter(conn => conn.toNodeId === nodeId)
            .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
            .filter((node): node is NodeData => !!node && node.type === 'image' && !!node.content)
            .map((node, index) => {
                const label = `图${index + 1}`;
                return {
                    id: node.id,
                    url: node.content!,
                    title: node.title,
                    label,
                    mention: label
                };
            });
    }, []);

    const handleGenerate = useCallback(async (
        nodeId: string,
        prompt: string,
        config: any,
        silent: boolean = false,
        overrideNodes?: NodeData[],
        overrideConnections?: Connection[],
        forceInPlace: boolean = false
    ) => {
        const currentNodes = overrideNodes || nodesRef.current;
        const currentConnections = overrideConnections || connectionsRef.current;
        const currentSettings = appSettingsRef.current;
        const isAutoResize = isAutoResizeRef.current;

        // Fetch latest node state to ensure params (like systemPrompt) are fresh
        const currentNode = currentNodes.find(n => n.id === nodeId);
        const latestConfig = currentNode?.params || config;

        if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    const portableMessage = 'HTML 编辑版仅支持画布编辑、媒体查看和工程导入导出。API 生成请使用 3004 服务或 Windows EXE 完整版。';
            setNodes(prev => prev.map(n => n.id === nodeId ? {
                ...n,
                status: 'error',
                title: 'HTML 编辑版不支持生成',
                errorDetails: portableMessage,
                progress: 0
            } : n));
            return;
        }

        const isReferenceImageNode = !!(
            currentNode?.isReferenceImage ||
            (currentNode?.type === 'image' && currentNode.blob && !currentNode.allImages?.length)
        );

        if (
            !forceInPlace &&
            currentNode?.type === 'image' &&
            isReferenceImageNode &&
            currentNode.content &&
            prompt.trim()
        ) {
            const generatedNodeId = `img-gen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const generatedNode: NodeData = {
                id: generatedNodeId,
                type: 'image',
                position: {
                    x: currentNode.position.x + currentNode.width + 90,
                    y: currentNode.position.y
                },
                width: 340,
                height: 340,
                title: 'Generated Image',
                prompt,
                content: '',
                status: 'idle',
                providerId: currentNode.providerId,
                modelId: currentNode.modelId,
                params: {
                    ...latestConfig,
                    model: latestConfig?.model || currentNode.modelId || config?.model || 'gemini-2.0-flash-exp',
                    aspectRatio: latestConfig?.aspectRatio || latestConfig?.aspect_ratio || config?.aspectRatio || config?.aspect_ratio || 'auto',
                    resolution: latestConfig?.resolution || latestConfig?.size || config?.resolution || config?.size || '2k',
                    batchSize: latestConfig?.batchSize || config?.batchSize || 1
                }
            };

            const connection: Connection = {
                id: `c-ref-${Date.now()}`,
                fromNodeId: currentNode.id,
                toNodeId: generatedNodeId
            };

            const mergedNodes = [...currentNodes, generatedNode];
            const mergedConnections = [...currentConnections, connection];

            setNodes(prev => [...prev, generatedNode]);
            setConnections(prev => {
                const exists = prev.some(c => c.fromNodeId === connection.fromNodeId && c.toNodeId === connection.toNodeId);
                return exists ? prev : [...prev, connection];
            });
            setSelectedNodeIds(new Set([generatedNodeId]));

            await handleGenerate(generatedNodeId, prompt, generatedNode.params, silent, mergedNodes, mergedConnections, true);
            return;
        }

        const nodeType = currentNode?.type || 'image';
        const shouldSimulateProgress = nodeType === 'image' || nodeType === 'text' || nodeType === 'audio';

        // Update node to loading
        setNodes(prev => prev.map(n => n.id === nodeId ? {
            ...n,
            status: 'loading',
            title: prompt.slice(0, 30) + '...',
            prompt: prompt,
            progress: shouldSimulateProgress ? 4 : 0,
            startTime: Date.now(),
            errorDetails: undefined
        } : n));

        if (shouldSimulateProgress) {
            startSimulatedProgress(nodeId);
        }

        // Collect Reference Images from Input Nodes
        const inputConnections = currentConnections.filter(c => c.toNodeId === nodeId);
        const referenceImages: (string | Blob)[] = [];
        const upstreamReferenceImages = getUpstreamReferenceImages(nodeId, currentNodes, currentConnections);
        const selectedReferenceImages = currentNode?.type === 'image'
            ? selectReferenceImagesForPrompt(prompt, upstreamReferenceImages)
            : upstreamReferenceImages;
        referenceImages.push(...selectedReferenceImages.map(image => image.value));

        try {
            if (currentNodes.find(n => n.id === nodeId)?.type === 'video') {
                // SORA VIDEO GENERATION

                // Get video provider config from node or default
                const node = currentNodes.find(n => n.id === nodeId)!;
                const videoProvider = (node.providerId
                    ? currentSettings.videoProviders.find(p => p.id === node.providerId)
                    : currentSettings.videoProviders.find(p => p.isDefault))
                    || currentSettings.videoProviders[0];

                if (!videoProvider) {
                    throw new Error('No video provider configured. Please add one in Settings.');
                }

                // Check for connected video nodes (for remix mode)
                const connectedVideoNode = inputConnections
                    .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                    .find(n => n && n.type === 'video' && n.taskId);

                let taskId: string;

                // Use node's modelId if specified, otherwise use default
                const modelId = node.modelId || config.model || videoProvider.models[0]?.id || 'sora2-landscape-10s';

                // Calculate actual size string from resolution/aspect-ratio
                let sizeStr = '1280x720';
                const res = (config.resolution || config.size || '720p').toLowerCase();
                const ar = config.aspectRatio || config.aspect_ratio || '16:9';

                if (res && res.includes('x')) {
                    sizeStr = res;
                } else if (res === '1080p') {
                    if (ar === '16:9') sizeStr = '1920x1080';
                    else if (ar === '9:16') sizeStr = '1080x1920';
                    else if (ar === '1:1') sizeStr = '1080x1080';
                    else if (ar === '21:9') sizeStr = '2560x1098';
                    else if (ar === '2:3') sizeStr = '1080x1620';
                    else if (ar === '3:2') sizeStr = '1620x1080';
                    else sizeStr = '1920x1080'; // Fallback
                } else {
                    // 720p default
                    if (ar === '16:9') sizeStr = '1280x720';
                    else if (ar === '9:16') sizeStr = '720x1280';
                    else if (ar === '1:1') sizeStr = '768x768';
                    else if (ar === '21:9') sizeStr = '1680x720';
                    else if (ar === '2:3') sizeStr = '720x1080';
                    else if (ar === '3:2') sizeStr = '1080x720';
                    else sizeStr = '1280x720'; // Fallback
                }

                if (videoProvider.type === 'openai' || videoProvider.type === 'veo' && videoProvider.endpointMode === 'chat') {
                    // --- OPENAI / STREAMING MODE ---
                    // This handles Text-to-Video, Image-to-Video, and Remix (if prompt contains URL)
                    // Note: We group "veo" here if endpointMode is 'chat' to allow flexible config, though logic below is specific to OpenAI stream format. 
                    // Strictly speaking the user asked for "OpenAI default mode".

                    // 1. Prepare Prompt just like Normal Mode
                    const connectedTextContent = inputConnections
                        .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                        .filter(n => n && n.type === 'text' && n.content)
                        .map(n => n!.content)
                        .join(' ');
                    let finalPrompt = prompt;
                    if (connectedTextContent) finalPrompt = `${connectedTextContent} ${prompt}`;
                    // Check for connected video nodes (Remix Helper) - Append URL to prompt if not present
                    const connectedVideoNode = inputConnections
                        .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                        .find(n => n && n.type === 'video' && n.content);

                    if (connectedVideoNode && connectedVideoNode.content && !finalPrompt.includes(connectedVideoNode.content)) {
                        // Only append if it looks like a URL
                        if (connectedVideoNode.content.startsWith('http')) {
                            finalPrompt = `${connectedVideoNode.content} ${finalPrompt}`;
                        }
                    }



                    // Prepare AbortController
                    const controller = new AbortController();
                    taskControllersRef.current.set(nodeId, controller);

                    setNodes(prev => prev.map(n => n.id === nodeId ? {
                        ...n,
                        status: 'loading',
                        title: 'Starting Stream...',
                        progress: 0,
                        taskId: undefined // No polling task ID
                    } : n));

                    try {
                        const videoUrl = await generateOpenAIVideo(
                            {
                                prompt: finalPrompt,
                                image: referenceImages[0],
                                images: referenceImages,
                                model: modelId,
                                seconds: config.seconds || (config.duration ? config.duration.replace('s', '') : '10'), // Pass seconds
                                size: sizeStr, // Pass calculated size
                                aspect_ratio: config.aspect_ratio || config.aspectRatio // Pass aspect_ratio (handle UI/API mismatch)
                            },
                            {
                                apiKey: videoProvider.apiKey,
                                baseUrl: videoProvider.baseUrl,
                                type: videoProvider.type,
                                endpointMode: videoProvider.endpointMode,
                                customEndpoint: videoProvider.customEndpoint
                            },
                            (status, progress, details) => {
                                setNodes(prev => prev.map(n => n.id === nodeId ? {
                                    ...n,
                                    title: details || `Streaming... ${progress}%`,
                                    progress: progress
                                } : n));
                            },
                            controller.signal
                        );

                        // Success
                        setNodes(prev => prev.map(n => n.id === nodeId ? {
                            ...n,
                            type: 'video',
                            status: 'success',
                            content: videoUrl,
                            title: 'Generated Video',
                            progress: 100
                        } : n));
                        recordGenerationHistory({
                            nodeId,
                            type: 'video',
                            title: 'Generated Video',
                            content: videoUrl,
                            prompt: finalPrompt
                        });

                    } catch (err: any) {
                        if (err.message === "Task aborted") return;
                        throw err; // Re-throw to be caught by outer catch
                    } finally {
                        taskControllersRef.current.delete(nodeId);
                    }

                } else if (connectedVideoNode && connectedVideoNode.taskId) {
                    // REMIX MODE: Connected to another video node
                    console.log(`[Video Generation] Remix mode: using source video ${connectedVideoNode.taskId}`);

                    // 1. Gather Upstream Text Content (for combining with prompt)
                    const connectedTextContent = inputConnections
                        .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                        .filter(n => n && n.type === 'text' && n.content)
                        .map(n => n!.content)
                        .join(' ');

                    // 2. Build final prompt
                    let finalPrompt = prompt;
                    if (connectedTextContent) {
                        finalPrompt = `${connectedTextContent} ${prompt}`;
                    }

                    // Create remix task
                    taskId = await remixSoraVideo(
                        connectedVideoNode.taskId,
                        finalPrompt,
                        {
                            apiKey: videoProvider.apiKey,
                            baseUrl: videoProvider.baseUrl,
                            type: videoProvider.type,
                            endpointMode: videoProvider.endpointMode,
                            customEndpoint: videoProvider.customEndpoint
                        }
                    );

                    setNodes(prev => prev.map(n => n.id === nodeId ? {
                        ...n,
                        taskId,
                        title: 'Remixing Video...',
                        progress: 0,
                        startTime: Date.now(),
                        remixedFromVideoId: connectedVideoNode.taskId
                    } : n));

                    // Monitor
                    await monitorSoraTask(nodeId, taskId, videoProvider.id);

                } else {
                    // NORMAL MODE: Regular video generation or image-to-video
                    // 1. Gather Upstream Text Content
                    const connectedTextContent = inputConnections
                        .map(conn => currentNodes.find(n => n.id === conn.fromNodeId))
                        .filter(n => n && n.type === 'text' && n.content)
                        .map(n => n!.content)
                        .join(' ');

                    // 2. Combine with User Prompt
                    let finalPrompt = prompt;
                    if (connectedTextContent) {
                        finalPrompt = `${connectedTextContent} ${prompt}`;
                    }

                    taskId = await createSoraTask(
                        {
                            prompt: finalPrompt,
                            size: sizeStr,
                            seconds: config.seconds || (config.duration ? config.duration.replace('s', '') : '15'),
                            model: modelId,
                            image: referenceImages[0], // Keep for backward compatibility (Sora)
                            images: referenceImages, // Pass full array for Veo
                            enhance_prompt: config.enhance_prompt,
                            enable_upsample: config.enable_upsample,
                            aspect_ratio: config.aspectRatio // Map UI property to API property
                        },
                        {
                            apiKey: videoProvider.apiKey,
                            baseUrl: videoProvider.baseUrl,
                            type: videoProvider.type,
                            endpointMode: videoProvider.endpointMode,
                            customEndpoint: videoProvider.customEndpoint
                        }
                    );

                    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, taskId, title: 'Task Created', progress: 0, startTime: Date.now() } : n));

                    // Monitor
                    await monitorSoraTask(nodeId, taskId, videoProvider.id);
                }


            } else if (currentNodes.find(n => n.id === nodeId)?.type === 'text') {
                // TEXT GENERATION
                const node = currentNodes.find(n => n.id === nodeId)!;

                // 1. Gather Upstream Content (from connected nodes)
                const incomingConnections = currentConnections.filter(c => c.toNodeId === nodeId);
                const upstreamContent = incomingConnections
                    .map(conn => {
                        const sourceNode = currentNodes.find(n => n.id === conn.fromNodeId);
                        if (!sourceNode) return '';
                        // Prefer content, fallback to prompt (e.g. for image nodes where prompt describes it)
                        return sourceNode.content || sourceNode.prompt || '';
                    })
                    .filter(Boolean)
                    .join('\n\n');

                // 2. Determine User Prompt (Input)
                // Rule: Combine current prompt (instruction) with upstream content (material to process)
                let userPrompt: string;
                if (upstreamContent) {
                    // Processing mode: instruction + content
                    if (prompt) {
                        userPrompt = `${prompt}\n\n${upstreamContent}`;
                    } else {
                        userPrompt = upstreamContent;
                    }
                } else {
                    // Creation mode: just use the prompt
                    userPrompt = prompt;
                }

                // 3. System Prompt
                // Ensure system prompt is passed correctly from node params
                const systemPrompt = latestConfig.systemPrompt || '';

                // Get text provider config from node or default
                const textProvider = (node.providerId
                    ? currentSettings.textProviders.find(p => p.id === node.providerId)
                    : currentSettings.textProviders.find(p => p.isDefault))
                    || currentSettings.textProviders[0];

                if (!textProvider) {
                    throw new Error('No text provider configured. Please add one in Settings.');
                }

                // Use node's modelId if specified, otherwise use config.model or first available
                const modelId = node.modelId || latestConfig.model || textProvider.models[0]?.id || 'gpt-4';

                const responseText = await generateText(
                    userPrompt,
                    modelId,
                    {
                        apiKey: textProvider.apiKey,
                        baseUrl: textProvider.baseUrl,
                        type: textProvider.type,
                        endpointMode: textProvider.endpointMode,
                        customEndpoint: textProvider.customEndpoint,
                        requestMode: (currentSettings as any).apiRequestMode || 'direct-first'
                    },
                    referenceImages,
                    systemPrompt
                );

                setNodes(prev => prev.map(n => n.id === nodeId ? {
                    ...n,
                    progress: 100,
                    status: 'success',
                    content: responseText,
                } : n));
                stopSimulatedProgress(nodeId);
                recordGenerationHistory({
                    nodeId,
                    type: 'text',
                    title: node.title || 'Generated Text',
                    content: responseText,
                    prompt: userPrompt
                });
            } else if (currentNodes.find(n => n.id === nodeId)?.type === 'audio') {
                const node = currentNodes.find(n => n.id === nodeId)!;
                const audioProvider = (node.providerId
                    ? currentSettings.audioProviders?.find(p => p.id === node.providerId)
                    : currentSettings.audioProviders?.find(p => p.isDefault))
                    || currentSettings.audioProviders?.[0];

                if (!audioProvider) {
                    throw new Error('No audio provider configured. Please add one in Settings.');
                }

                const modelId = node.modelId || latestConfig.model || audioProvider.models[0]?.id || 'gpt-4o-mini-tts';
                const audioUrl = await generateAudio(
                    prompt,
                    modelId,
                    {
                        apiKey: audioProvider.apiKey,
                        baseUrl: audioProvider.baseUrl,
                        type: audioProvider.type,
                        endpointMode: audioProvider.endpointMode,
                        customEndpoint: audioProvider.customEndpoint
                    },
                    {
                        voice: latestConfig.voice || 'alloy',
                        format: latestConfig.format || 'mp3',
                        seconds: latestConfig.seconds || latestConfig.duration
                    }
                );

                setNodes(prev => prev.map(n => n.id === nodeId ? {
                    ...n,
                    progress: 100,
                    status: 'success',
                    content: audioUrl,
                    title: 'Generated Audio'
                } : n));
                stopSimulatedProgress(nodeId);
                recordGenerationHistory({
                    nodeId,
                    type: 'audio',
                    title: 'Generated Audio',
                    content: audioUrl,
                    prompt
                });
            } else {
                // GEMINI IMAGE GENERATION
                // Get image provider config from node or default
                const node = currentNodes.find(n => n.id === nodeId)!;
                const imageProvider = (node.providerId
                    ? currentSettings.imageProviders.find(p => p.id === node.providerId)
                    : currentSettings.imageProviders.find(p => p.isDefault))
                    || currentSettings.imageProviders[0];

                if (!imageProvider) {
                    throw new Error('No image provider configured. Please add one in Settings.');
                }

                // Use node's modelId if specified, otherwise use config.model or first available
                const selectedModelId = node.modelId || latestConfig.model || imageProvider.models[0]?.id || 'gemini-2.0-flash-exp';
                const rawAspectRatio = latestConfig.aspectRatio || latestConfig.aspect_ratio;
                const rawResolution = latestConfig.resolution || latestConfig.size;
                const effectiveAspectRatio = resolveAutoAspectRatioForGeneration(rawAspectRatio, selectedReferenceImages, node);
                const effectiveResolution = resolveImageResolutionForGeneration(rawResolution);
                const modelId = resolveVariantModelId(
                    selectedModelId,
                    imageProvider.models,
                    effectiveResolution,
                    effectiveAspectRatio
                );
                const selectedReferenceLabels = selectedReferenceImages.map(image => image.label);
                const finalImagePrompt = buildImageInstructionPrompt(prompt, {
                    systemPrompt: latestConfig.systemPrompt,
                    selectedReferenceLabels,
                    upstreamReferenceCount: upstreamReferenceImages.length
                });

                console.log(`[App] Image generation for node ${nodeId}:`, {
                    providerId: imageProvider.id,
                    providerName: imageProvider.name,
                    providerType: imageProvider.type,
                    nodeModelId: node.modelId,
                    configModel: latestConfig.model,
                    selectedModelId,
                    finalModelId: modelId,
                    aspectRatio: effectiveAspectRatio,
                    rawAspectRatio,
                    resolution: effectiveResolution,
                    rawResolution,
                    rawPromptLength: prompt.length,
                    finalPromptLength: finalImagePrompt.length,
                    referenceImageCount: referenceImages.length,
                    selectedReferenceLabels
                });

                const imageResult = await generateImage(
                    finalImagePrompt,
                    modelId,
                    effectiveAspectRatio,
                    effectiveResolution,
                    {
                        apiKey: imageProvider.apiKey,
                        baseUrl: imageProvider.baseUrl,
                        type: imageProvider.type,
                        endpointMode: imageProvider.endpointMode,
                        customEndpoint: imageProvider.customEndpoint,
                        requestMode: (currentSettings as any).apiRequestMode || 'direct-first'
                    }, // Pass configured API settings
                    referenceImages, // Pass collected inputs
                    latestConfig.quality
                );

                const allDisplayUrls = imageResult.allImages.filter((url): url is string => typeof url === 'string' && !!url.trim());
                if (allDisplayUrls.length === 0) {
                    throw new Error('生成接口返回成功，但没有可显示的图片地址。');
                }
                const targetAspectRatio = effectiveAspectRatio;
                const targetResolution = effectiveResolution;
                const normalizedImages = await Promise.all(
                    allDisplayUrls.map(url => normalizeGeneratedImageSize(url, targetResolution, targetAspectRatio))
                );
                const finalDisplayUrls = normalizedImages.map(image => image.url);
                const finalBlobs = normalizedImages.map(image => image.blob).filter((blob): blob is Blob => !!blob);
                const primaryImageSize = normalizedImages[0]?.width && normalizedImages[0]?.height
                    ? { width: normalizedImages[0].width!, height: normalizedImages[0].height! }
                    : null;

                setNodes(prev => prev.map(n => {
                    if (n.id === nodeId) {
                        let newHeight = n.height;
                        let newWidth = n.width;

                        const ar = targetAspectRatio;
                        if (isAutoResize && ar && String(ar).toLowerCase() !== 'auto') {
                            try {
                                const [w, h] = ar.split(':').map(Number);
                                if (w && h) {
                                    const aspect = w / h;
                                    // Adjust height based on current width and aspect ratio
                                    // Node content height = width / aspect
                                    // Add 80px for header/UI padding approximation
                                    newHeight = (newWidth / aspect) + 80;
                                }
                            } catch (e) { }
                        }

                        return {
                            ...n,
                            progress: 100,
                            status: 'success',
                            content: finalDisplayUrls[0],
                            blob: normalizedImages[0]?.blob,
                            allImages: finalDisplayUrls,
                            allBlobs: finalBlobs.length === finalDisplayUrls.length ? finalBlobs : undefined,
                            currentImageIndex: 0,
                            width: newWidth,
                            height: newHeight,
                            ...(primaryImageSize ? { imageWidth: primaryImageSize.width, imageHeight: primaryImageSize.height } : {})
                        };
                    }
                    return n;
                }));
                stopSimulatedProgress(nodeId);
                await saveGeneratedImagesToDirectory(
                    nodeId,
                    finalImagePrompt,
                    normalizedImages.map(image => ({ url: image.url, blob: image.blob }))
                );
                recordGenerationHistory({
                    nodeId,
                    type: 'image',
                    title: 'Generated Image',
                    content: finalDisplayUrls[0] || allDisplayUrls[0] || imageResult.allImages[0],
                    blob: normalizedImages[0]?.blob,
                    prompt: finalImagePrompt
                });
            }

        } catch (e: any) {
            console.error('[Generate] Error details:', e);
            stopSimulatedProgress(nodeId);

            const rawErrorMessage = e.message || 'Generation failed';
            let displayError = rawErrorMessage;
            const failedNode = currentNodes.find(n => n.id === nodeId);
            const failedConfig = failedNode?.params || config || {};
            const failedProvider = failedNode?.type === 'image'
                ? (failedNode.providerId
                    ? currentSettings.imageProviders.find(p => p.id === failedNode.providerId)
                    : currentSettings.imageProviders.find(p => p.isDefault) || currentSettings.imageProviders[0])
                : failedNode?.type === 'video'
                    ? (failedNode.providerId
                        ? currentSettings.videoProviders.find(p => p.id === failedNode.providerId)
                        : currentSettings.videoProviders.find(p => p.isDefault) || currentSettings.videoProviders[0])
                    : failedNode?.type === 'audio'
                        ? (failedNode.providerId
                            ? currentSettings.audioProviders?.find(p => p.id === failedNode.providerId)
                            : currentSettings.audioProviders?.find(p => p.isDefault) || currentSettings.audioProviders?.[0])
                        : (failedNode?.providerId
                            ? currentSettings.textProviders.find(p => p.id === failedNode.providerId)
                            : currentSettings.textProviders.find(p => p.isDefault) || currentSettings.textProviders[0]);
            const diagnostic = failedProvider
                ? [
                    '',
                    '--- 生成配置诊断 ---',
                    `节点类型: ${failedNode?.type || 'unknown'}`,
                    `Provider: ${failedProvider.name}`,
                    `Provider 类型: ${failedProvider.type}`,
                    `Base URL: ${failedProvider.baseUrl || '(empty)'}`,
                    `Endpoint 模式: ${failedProvider.endpointMode || 'default'}`,
                    `Custom Endpoint: ${failedProvider.customEndpoint || '(none)'}`,
                    `模型: ${failedNode?.modelId || failedConfig.model || '(empty)'}`,
                    `比例: ${failedConfig.aspectRatio || failedConfig.aspect_ratio || '(empty)'}`,
                    `分辨率: ${failedConfig.resolution || failedConfig.size || '(empty)'}`
                ].join('\n')
                : '\n--- 生成配置诊断 ---\n未找到当前节点对应的 Provider 配置。';
            displayError = `${displayError}${diagnostic}`;

            // 闄愬埗鏄剧ず闀垮害
            const maxErrorLength = 80;
            let shortError = displayError;
            if (displayError.length > maxErrorLength) {
                shortError = displayError.substring(0, maxErrorLength) + '...';
            }

            setNodes(prev => prev.map(n =>
                n.id === nodeId
                    ? {
                        ...n,
                        status: 'error',
                        progress: 0,
                        title: '错误: ' + shortError,
                        errorDetails: displayError
                    }
                    : n
            ));

            // 错误已经保存到节点上展示。
        }
    }, [monitorSoraTask, saveGeneratedImagesToDirectory, startSimulatedProgress, stopSimulatedProgress]);

    const handleMultiAngleGenerate = useCallback((sourceNodeId: string, prompt: string, config: any) => {
        const currentNodes = nodesRef.current;
        const currentConnections = connectionsRef.current;
        const currentSettings = appSettingsRef.current;
        const sourceNode = currentNodes.find(n => n.id === sourceNodeId);

        if (!sourceNode) return;

        const sourceImageWidth = sourceNode.imageWidth || sourceNode.width;
        const sourceImageHeight = sourceNode.imageHeight || sourceNode.height;
        const sourceAspectRatio = getClosestImageAspectRatio(sourceImageWidth, sourceImageHeight);
        const generatedNodeSize = getGeneratedNodeSizeForAspectRatio(sourceAspectRatio);
        const selectedProviderId = config.providerId || sourceNode.providerId;
        const selectedModelId = config.model || config.modelId || sourceNode.modelId || sourceNode.params?.model;
        const selectedProvider = selectedProviderId
            ? currentSettings.imageProviders.find(p => p.id === selectedProviderId)
            : undefined;
        const providerForSelectedModel = selectedModelId
            ? currentSettings.imageProviders.find(p => p.models.some(m => m.id === selectedModelId))
            : undefined;
        const sourceProvider = sourceNode.providerId
            ? currentSettings.imageProviders.find(p => p.id === sourceNode.providerId)
            : undefined;
        const defaultProvider = currentSettings.imageProviders.find(p => p.isDefault) || currentSettings.imageProviders[0];
        const imageProvider = selectedProvider || providerForSelectedModel || sourceProvider || defaultProvider;
        const resolvedModelId = selectedModelId || imageProvider?.models[0]?.id || 'gemini-2.0-flash-exp';
        const providerHasModel = !!imageProvider?.models.some(m => m.id === resolvedModelId);
        const providerError = config.configError || (!imageProvider
            ? '当前没有配置图像生成 API。请先到设置 > 图像生成 添加 API 和模型。'
            : !providerHasModel
                ? `当前图像 API「${imageProvider.name}」没有配置模型 ${resolvedModelId}。请在设置里添加该模型，或选择已配置的模型。`
                : '');

        const nodeId = `img-angle-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const params = {
            ...(sourceNode.params || {}),
            ...config,
            model: resolvedModelId,
            aspectRatio: sourceAspectRatio,
            aspect_ratio: sourceAspectRatio,
            resolution: config.resolution || config.size || sourceNode.params?.resolution || sourceNode.params?.size || '2k',
            batchSize: 1
        };

        const generatedNode: NodeData = {
            id: nodeId,
            type: 'image',
            position: {
                x: sourceNode.position.x + sourceNode.width + 90,
                y: sourceNode.position.y
            },
            width: generatedNodeSize.width,
            height: generatedNodeSize.height,
            title: '多角度生成',
            prompt,
            content: '',
            status: providerError ? 'error' : 'idle',
            providerId: imageProvider?.id || sourceNode.providerId,
            modelId: resolvedModelId,
            params,
            errorDetails: providerError || undefined
        };

        const connection: Connection = {
            id: `c-angle-${Date.now()}`,
            fromNodeId: sourceNodeId,
            toNodeId: nodeId
        };

        const mergedNodes = [...currentNodes, generatedNode];
        const mergedConnections = [...currentConnections, connection];

        setNodes(prev => [...prev, generatedNode]);
        setConnections(prev => [...prev, connection]);
        setSelectedNodeIds(new Set([nodeId]));

        if (providerError) return;

        handleGenerate(nodeId, prompt, params, true, mergedNodes, mergedConnections);
    }, [handleGenerate]);

    const handleGroupRun = useCallback(async (groupId: string, mode: 'video' | 'text' | 'all') => {
        const currentNodes = nodesRef.current;
        const currentConnections = connectionsRef.current;
        const groupNodes = currentNodes.filter(n => n.groupId === groupId);

        if (groupNodes.length === 0) return;

        let nodesToRun: NodeData[] = [];

        const shouldSkipTextNode = (n: NodeData) => {
            // Skip text nodes that have no prompt and no inputs (e.g. Script nodes)
            if (n.type === 'text') {
                const hasPrompt = !!n.prompt && n.prompt.trim().length > 0;
                const hasInputs = currentConnections.some(c => c.toNodeId === n.id);
                // Also respect the explicit title check just in case
                const isScriptTitle = n.title && n.title.includes('(鍓ф湰)');

                if ((!hasPrompt && !hasInputs) || isScriptTitle) {
                    return true;
                }
            }
            return false;
        };

        if (mode === 'video') {
            nodesToRun = groupNodes.filter(n => n.type === 'video');
        } else if (mode === 'text') {
            nodesToRun = groupNodes.filter(n => n.type === 'text' && !shouldSkipTextNode(n));
        } else if (mode === 'all') {
            nodesToRun = groupNodes.filter(n =>
                ['text', 'video', 'image'].includes(n.type) && !shouldSkipTextNode(n)
            );
        }

        if (nodesToRun.length === 0) return;

        const CONCURRENCY_LIMIT = appSettingsRef.current.concurrencyLimit || 15;

        // Queue wrapper
        const queue: (() => Promise<void>)[] = nodesToRun.map(node => async () => {
            const safePrompt = node.prompt || '';
            const config = node.params || {};

            try {
                await handleGenerate(node.id, safePrompt, config, true);
            } catch (e) {
                console.error(`Failed to generate node ${node.id}`, e);
            }
        });

        // Worker function
        const worker = async () => {
            while (queue.length > 0) {
                const task = queue.shift();
                if (task) await task();
            }
        };

        // Start workers
        const workers = Array(Math.min(nodesToRun.length, CONCURRENCY_LIMIT)).fill(null).map(() => worker());
        await Promise.all(workers);
        saveToDB();
    }, [handleGenerate]);

    const handleNodeResize = useCallback((id: string, width: number, height: number, imageSize?: { width: number; height: number }) => {
        setNodes(prev => prev.map(n => n.id === id ? {
            ...n,
            width,
            height,
            ...(imageSize ? { imageWidth: imageSize.width, imageHeight: imageSize.height } : {})
        } : n));
    }, []);

    const handleUpload = useCallback((nodeId: string, dataUrl: string) => {
        const isAutoResize = isAutoResizeRef.current;
        // Since we are moving to Blobs elsewhere, we should ideally handle it as Blob here too
        // if dataUrl is already a dataUrl, it's fine for now but Blobs are better.
        // Convert to blob just to be consistent
        const handleWithBlob = async (url: string) => {
            const res = await fetch(url);
            const blob = await res.blob();
            const persistentUrl = blobToDisplayUrl(blob);

            const img = new Image();
            img.onload = () => {
                const imageWidth = img.naturalWidth || img.width;
                const imageHeight = img.naturalHeight || img.height;
                const size = getImageNodeDisplaySize(imageWidth, imageHeight);
                setNodes(prev => prev.map(n => {
                    if (n.id === nodeId) {
                        return {
                            ...n,
                            content: persistentUrl,
                            blob: blob, // Store actual blob
                            isReferenceImage: true,
                            status: 'success',
                            title: 'Uploaded Image',
                            width: size.width,
                            height: size.height,
                            imageWidth,
                            imageHeight
                        };
                    }
                    return n;
                }));
            };
            img.onerror = () => {
                setNodes(prev => prev.map(n => n.id === nodeId ? {
                    ...n,
                    content: persistentUrl,
                    blob,
                    isReferenceImage: true,
                    status: 'success',
                    title: 'Uploaded Image'
                } : n));
            };
            img.src = persistentUrl;
        };
        handleWithBlob(dataUrl);
    }, []);

    const handleRemoveBackground = useCallback(async (nodeId: string) => {
        const sourceNode = nodes.find(n => n.id === nodeId);
        if (!sourceNode || sourceNode.type !== 'image' || !sourceNode.content) return;

        setNodes(prev => prev.map(n => n.id === nodeId
            ? { ...n, status: 'loading', progress: 5, title: '去背景处理中...' }
            : n
        ));

        try {
            const imageSource = sourceNode.blob || sourceNode.content;
            const resultBlob = await removeImageBackground(imageSource, (progress) => {
                setNodes(prev => prev.map(n => n.id === nodeId
                    ? { ...n, progress, title: `去背景处理中... ${progress}%` }
                    : n
                ));
            });
            const resultUrl = blobToDisplayUrl(resultBlob);
            const resultImageSize = await getImageSizeFromUrl(resultUrl).catch(() => null);
            const resultDisplaySize = resultImageSize
                ? getImageNodeDisplaySize(resultImageSize.width, resultImageSize.height)
                : { width: sourceNode.width, height: sourceNode.height };
            const resultNode: NodeData = {
                ...sourceNode,
                id: `img-bg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                position: {
                    x: sourceNode.position.x + sourceNode.width + 48,
                    y: sourceNode.position.y
                },
                title: `${sourceNode.title || 'Image'} 去背景`,
                content: resultUrl,
                blob: resultBlob,
                width: resultDisplaySize.width,
                height: resultDisplaySize.height,
                imageWidth: resultImageSize?.width || sourceNode.imageWidth,
                imageHeight: resultImageSize?.height || sourceNode.imageHeight,
                allImages: undefined,
                allBlobs: undefined,
                currentImageIndex: undefined,
                status: 'success',
                progress: 100,
                selected: true,
                taskId: undefined,
                errorDetails: undefined
            };

            setNodes(prev => [
                ...prev.map(n => n.id === nodeId
                    ? { ...n, status: 'success', progress: 0, title: sourceNode.title }
                    : { ...n, selected: false }
                ),
                resultNode
            ]);
            setSelectedNodeIds(new Set([resultNode.id]));
        } catch (error: any) {
            const message = error?.message || 'Background removal failed';
            setNodes(prev => prev.map(n => n.id === nodeId
                ? {
                    ...n,
                    status: 'error',
                    progress: 0,
                    title: `去背景失败: ${message}`,
                    errorDetails: message
                }
                : n
            ));
        }
    }, [nodes]);
    const handleNodeTitleChange = useCallback((id: string, title: string) => {
        setNodes(prev => prev.map(n => n.id === id ? { ...n, title } : n));
    }, []);

    const handleNodeMaximize = useCallback((url: string, type: 'image' | 'video') => {
        setPreviewMedia({ url, type });
    }, []);

    // 澶勭悊鍥剧墖鍒囨崲锛堣疆鎾姛鑳斤級
    const handleImageSwitch = useCallback((nodeId: string, imageIndex: number) => {
        setNodes(prev => prev.map(n => {
            if (n.id === nodeId && n.allImages) {
                if (imageIndex >= 0 && imageIndex < n.allImages.length) {
                    return {
                        ...n,
                        content: n.allImages[imageIndex],
                        blob: n.allBlobs?.[imageIndex],
                        currentImageIndex: imageIndex
                    };
                }
            }
            return n;
        }));
    }, []);

    // Helper to create task from Grid Mode
    const handleCreateTask = useCallback(async (prompt: string, config: any, imageContent?: string | Blob) => {
        const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
        // Add minimal random offset
        const offset = (Math.random() - 0.5) * 50;

        const timestamp = Date.now();
        const videoNodeId = `v-${timestamp}`;
        const newNodes: NodeData[] = [];
        const newConnections: Connection[] = [];

        // 1. Determine iteration count
        const taskCount = config.count || 1;
        const videoNodeIds: string[] = [];

        // 2. Loop to create Video Nodes
        for (let i = 0; i < taskCount; i++) {
            const iterTimestamp = timestamp + i;
            const iterVideoNodeId = `v-${iterTimestamp}`;
            videoNodeIds.push(iterVideoNodeId);

            // Lay them out in a grid or stack?
            // Simple stack with offset
            const iterOffset = offset + (i * 20);
            const iterPos = {
                x: center.x - 240 + iterOffset + (i % 2) * 20,
                y: center.y - 160 + iterOffset + Math.floor(i / 2) * 20
            };

            const videoNode: NodeData = {
                id: iterVideoNodeId,
                type: 'video',
                position: iterPos,
                width: 480,
                height: 320,
                title: (prompt.slice(0, 20) || 'New Video Task') + (taskCount > 1 ? ` #${i + 1}` : ''),
                prompt: prompt,
                content: '',
                status: 'idle',
                source: 'grid',
                params: {
                    model: config.model || 'sora-2',
                    aspectRatio: config.aspectRatio || '16:9',
                    resolution: config.resolution || '720p',
                    batchSize: 1, // Individual node is 1, loop handles count
                    duration: config.duration,
                    seconds: (config.duration || '15s').replace('s', '')
                },
                providerId: config.providerId
            };
            newNodes.push(videoNode);
        }

        // No need to push single videoNode anymore as we loop


        // 2. If Image Provided, Create Image Node and Connect
        if (imageContent) {
            const imageNodeId = `img-${timestamp}`;
            let contentStr = '';
            let blobData: Blob | undefined = undefined;

            if (typeof imageContent === 'string') {
                contentStr = imageContent;
            } else {
                contentStr = blobToDisplayUrl(imageContent);
                blobData = imageContent;
            }

            // Find reference position (from first video node)
            const refPos = newNodes.length > 0 ? newNodes[0].position : { x: center.x - 240 + offset, y: center.y - 160 + offset };

            const imageNode: NodeData = {
                id: imageNodeId,
                type: 'image',
                position: { x: refPos.x - 380, y: refPos.y + 20 }, // Left of first video
                width: 340,
                height: 280,
                source: 'grid', // Mark as grid-generated
                title: 'Reference Image',
                content: contentStr,
                blob: blobData,
                status: 'success'
            };
            newNodes.push(imageNode);

            // Connect Image to ALL video nodes
            videoNodeIds.forEach((vid, idx) => {
                newConnections.push({
                    id: `c-${timestamp}-${idx}`,
                    fromNodeId: imageNodeId,
                    toNodeId: vid
                });
            });
        }

        setNodes(prev => [...prev, ...newNodes]);
        setConnections(prev => [...prev, ...newConnections]);

        // Prepare merged data for immediate execution
        const mergedNodes = [...nodesRef.current, ...newNodes];
        const mergedConnections = [...connectionsRef.current, ...newConnections];

        // Trigger generation for each video node created
        // We need to pass the specific node params. Can get from newNodes.
        videoNodeIds.forEach(vid => {
            const node = newNodes.find(n => n.id === vid);
            if (node && node.params) {
                handleGenerate(vid, prompt, node.params, true, mergedNodes, mergedConnections);
            }
        });
    }, [handleGenerate, screenToCanvas]);

    // --- Rendering ---

    // Render Connections with Culling
    const renderConnections = () => {
        const padding = 200;
        const screenW = window.innerWidth / viewport.k;
        const screenH = window.innerHeight / viewport.k;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + screenW + padding * 2;
        const viewBottom = viewTop + screenH + padding * 2;

        return connections.filter(conn => {
            const fromNode = nodes.find(n => n.id === conn.fromNodeId);
            const toNode = nodes.find(n => n.id === conn.toNodeId);
            if (!fromNode || !toNode) return false;

            // Exclude connections involving grid-generated nodes from main canvas render
            if (fromNode.source === 'grid' || toNode.source === 'grid') return false;

            // Culling with padding to prevent flickering at edges
            const padding = 200;
            const isNodeVisible = (n: any) => (
                n.position.x + n.width > viewLeft - padding &&
                n.position.x < viewRight + padding &&
                n.position.y + n.height > viewTop - padding &&
                n.position.y < viewBottom + padding
            );

            return isNodeVisible(fromNode) || isNodeVisible(toNode);
        }).map(conn => {
            const fromNode = nodes.find(n => n.id === conn.fromNodeId)!;
            const toNode = nodes.find(n => n.id === conn.toNodeId)!;

            const startX = fromNode.position.x + fromNode.width;
            const startY = fromNode.position.y + fromNode.height / 2;
            const endX = toNode.position.x;
            const endY = toNode.position.y + toNode.height / 2;

            // Stable Bezier Curve Calculation
            const dx = Math.abs(endX - startX);
            const curvature = Math.max(dx * 0.5, 50); // Minimum curvature for stability
            const cp1x = startX + curvature;
            const cp1y = startY;
            const cp2x = endX - curvature;
            const cp2y = endY;

            const pathD = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
            const isConnSelected = selectedConnectionId === conn.id;
            const midpointX = (startX + 3 * cp1x + 3 * cp2x + endX) / 8;
            const midpointY = (startY + 3 * cp1y + 3 * cp2y + endY) / 8;
            const cutButtonSize = 34 / viewport.k;

            return (
                <g key={conn.id}>
                    <path
                        className="connection-path-hit"
                        data-connection-id={conn.id}
                        data-from-node={conn.fromNodeId}
                        data-to-node={conn.toNodeId}
                        d={pathD}
                        stroke="transparent"
                        strokeWidth="15"
                        fill="none"
                        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                        onClick={(e) => {
                            e.stopPropagation();
                            setSelectedConnectionId(conn.id);
                            setSelectedNodeIds(new Set());
                        }}
                    />
                    <path
                        className="connection-path"
                        data-connection-id={conn.id}
                        data-from-node={conn.fromNodeId}
                        data-to-node={conn.toNodeId}
                        d={pathD}
                        stroke={isConnSelected ? "#22d3ee" : "#52525b"}
                        strokeWidth={isConnSelected ? "3" : "2"}
                        fill="none"
                        strokeOpacity={isConnSelected ? "1" : "0.8"}
                        style={{ pointerEvents: 'none', transition: 'none' }}
                    />
                    {isConnSelected && (
                        <foreignObject
                            x={midpointX - cutButtonSize / 2}
                            y={midpointY - cutButtonSize / 2}
                            width={cutButtonSize}
                            height={cutButtonSize}
                            className="connection-cut-control overflow-visible"
                            style={{ pointerEvents: 'all' }}
                        >
                            <button
                                type="button"
                                className="connection-cut-button flex h-full w-full items-center justify-center rounded-full border border-red-400/40 bg-zinc-950/95 text-red-300 shadow-lg backdrop-blur-sm transition-colors hover:border-red-300 hover:bg-red-500 hover:text-white"
                                title="删除连接"
                                aria-label="删除连接"
                                onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    handleDeleteConnection(conn.id);
                                }}
                            >
                                <ScissorsIcon className="h-4 w-4" />
                            </button>
                        </foreignObject>
                    )}
                </g>
            );
        });
    };

    // Render Active Drag Line
    const renderActiveConnection = () => {
        if (!connectingParams) return null;

        const sourceNodes = (connectingParams.nodeIds && connectingParams.nodeIds.length > 0
            ? connectingParams.nodeIds
            : [connectingParams.nodeId])
            .map(id => nodes.find(n => n.id === id))
            .filter(Boolean) as NodeData[];

        if (sourceNodes.length === 0) return null;

        const mouseCanvas = screenToCanvas(mousePos.x, mousePos.y);
        const sourceIdSet = new Set(sourceNodes.map(node => node.id));
        const targetHandleType = connectingParams.handleType === 'source' ? 'target' : 'source';
        let nearestTarget: NodeData | null = null;
        let nearestTargetDistance = Infinity;

        nodes.forEach(node => {
            if (node.source === 'grid' || sourceIdSet.has(node.id)) return;

            const handleCanvasX = targetHandleType === 'target'
                ? node.position.x
                : node.position.x + node.width;
            const handleCanvasY = node.position.y + node.height / 2;
            const handleScreenX = viewport.x + handleCanvasX * viewport.k;
            const handleScreenY = viewport.y + handleCanvasY * viewport.k;
            const distance = Math.hypot(mousePos.x - handleScreenX, mousePos.y - handleScreenY);

            if (distance < nearestTargetDistance) {
                nearestTargetDistance = distance;
                nearestTarget = node;
            }
        });

        const snapTarget = nearestTarget as NodeData | null;
        const isWithinSnapRange = !!snapTarget && nearestTargetDistance <= CONNECTION_SNAP_DISTANCE_PX;
        const snapProgress = isWithinSnapRange
            ? Math.max(0, Math.min(1, 1 - nearestTargetDistance / CONNECTION_SNAP_DISTANCE_PX))
            : 0;
        const snapAttraction = snapProgress * snapProgress * (3 - 2 * snapProgress);
        const isSnapLocked = snapAttraction >= 0.72;
        const snapHandle = snapTarget
            ? {
                x: targetHandleType === 'target' ? snapTarget.position.x : snapTarget.position.x + snapTarget.width,
                y: snapTarget.position.y + snapTarget.height / 2
            }
            : null;

        return (
            <g>
                {snapHandle && (
                    <g className="pointer-events-none">
                        {isWithinSnapRange && (
                            <>
                                <circle
                                    cx={snapHandle.x}
                                    cy={snapHandle.y}
                                    r={42 / viewport.k}
                                    fill={`rgba(34,211,238,${0.025 + snapAttraction * 0.04})`}
                                    className="connection-snap-soft-halo"
                                />
                                <circle
                                    cx={snapHandle.x}
                                    cy={snapHandle.y}
                                    r={24 / viewport.k}
                                    fill="none"
                                    stroke="#67e8f9"
                                    strokeWidth={1.5 / viewport.k}
                                    opacity="0.5"
                                    className="connection-snap-ripple"
                                />
                            </>
                        )}
                        <circle
                            cx={snapHandle.x}
                            cy={snapHandle.y}
                            r={(7 + snapAttraction * 3) / viewport.k}
                            fill={`rgba(34,211,238,${0.08 + snapAttraction * 0.12})`}
                            stroke={isSnapLocked ? '#a5f3fc' : '#22d3ee'}
                            strokeWidth={(1.25 + snapAttraction * 0.75) / viewport.k}
                            opacity={0.55 + snapAttraction * 0.45}
                            className={isSnapLocked ? 'connection-snap-port-active' : undefined}
                        />
                    </g>
                )}
                {sourceNodes.map((node, index) => {
                    let startX, startY, endX, endY;
                    const dragEnd = isWithinSnapRange && snapHandle
                        ? {
                            x: mouseCanvas.x + (snapHandle.x - mouseCanvas.x) * snapAttraction,
                            y: mouseCanvas.y + (snapHandle.y - mouseCanvas.y) * snapAttraction
                        }
                        : mouseCanvas;

                    if (connectingParams.handleType === 'source') {
                        startX = node.position.x + node.width;
                        startY = node.position.y + node.height / 2;
                        endX = dragEnd.x;
                        endY = dragEnd.y;
                    } else {
                        startX = dragEnd.x;
                        startY = dragEnd.y;
                        endX = node.position.x;
                        endY = node.position.y + node.height / 2;
                    }

                    const dist = Math.abs(endX - startX);
                    const curvature = Math.max(dist * 0.5, 50);
                    const cp1x = startX + curvature;
                    const cp1y = startY;
                    const cp2x = endX - curvature;
                    const cp2y = endY;
                    const pathD = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;

                    return (
                        <path
                            key={`${node.id}-${index}`}
                            d={pathD}
                            stroke={isSnapLocked ? '#67e8f9' : '#22d3ee'}
                            strokeWidth={2 + snapAttraction * 0.5}
                            strokeOpacity={sourceNodes.length > 1 ? 0.9 : 1}
                            fill="none"
                            strokeDasharray={isSnapLocked ? undefined : '5,5'}
                            strokeLinecap="round"
                            className={isSnapLocked ? 'connection-snap-line-active' : undefined}
                        />
                    );
                })}
            </g>
        );
    };

    const renderUnifiedConnectionInterface = () => {
        if (selectedNodeIds.size <= 1 || selectionBox || connectingParams?.nodeIds) return null;

        const selectedNodes = nodes.filter(node => selectedNodeIds.has(node.id) && node.source !== 'grid');
        if (selectedNodes.length <= 1) return null;

        const minX = Math.min(...selectedNodes.map(node => node.position.x));
        const minY = Math.min(...selectedNodes.map(node => node.position.y));
        const maxX = Math.max(...selectedNodes.map(node => node.position.x + node.width));
        const maxY = Math.max(...selectedNodes.map(node => node.position.y + node.height));
        const padding = 24;
        const x = minX - padding;
        const y = minY - padding;
        const width = maxX - minX + padding * 2;
        const height = maxY - minY + padding * 2;
        const nodeIds = selectedNodes.map(node => node.id);

        return (
            <div
                className="absolute pointer-events-none z-[45]"
                style={{
                    transform: `translate(${x}px, ${y}px)`,
                    width,
                    height
                }}
            >
                <div className="absolute inset-0 rounded-2xl border border-cyan-400/45 bg-cyan-400/[0.03] shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_20px_50px_rgba(0,0,0,0.18)]" />
                <div className="absolute -top-7 left-3 flex items-center gap-2 rounded-full border border-cyan-400/40 bg-zinc-950/90 px-3 py-1 text-[11px] font-medium text-cyan-100 shadow-lg backdrop-blur-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.9)]" />
                    <span>统一接口</span>
                    <span className="text-zinc-500">{selectedNodes.length}</span>
                </div>
                <button
                    className="absolute right-0 top-1/2 flex h-10 w-10 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-cyan-300 bg-zinc-950 text-cyan-200 shadow-[0_0_0_6px_rgba(34,211,238,0.12),0_12px_30px_rgba(0,0,0,0.35)] transition-all hover:scale-110 hover:bg-cyan-500 hover:text-zinc-950 pointer-events-auto"
                    title="拖拽以批量连接选中节点"
                    onMouseDown={(e) => handleUnifiedConnectStart(e, nodeIds)}
                >
                    <span className="h-3 w-3 rounded-full bg-current" />
                </button>
            </div>
        );
    };

    // Download Node Media
    const handleDownloadNodeMedia = async (nodeId: string) => {
        const node = nodes.find(n => n.id === nodeId);
        if (!node) return;

        // If no content (e.g. empty or text node without specific file), fallback to project export?
        if (!node.content && node.type !== 'text') {
            handleExport();
            return;
        }

        let url = node.content;
        let ext = 'png';
        let mime = 'image/png';

        if (node.type === 'video') {
            ext = 'mp4';
            mime = 'video/mp4';
        } else if (node.type === 'audio') {
            ext = 'mp3';
            mime = 'audio/mpeg';
        } else if (node.type === 'text') {
            const blob = new Blob([node.content || node.description || ''], { type: 'text/plain' });
            url = URL.createObjectURL(blob);
            ext = 'txt';
            mime = 'text/plain';
        }

        if (!url) {
            handleExport();
            return;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
            const blob = await response.blob();

            try {
                // @ts-ignore
                if (window.showSaveFilePicker) {
                    // @ts-ignore
                    const handle = await window.showSaveFilePicker({
                        suggestedName: `X-tapnow_${node.type}_${Date.now()}.${ext}`,
                        types: [{
                            description: 'Media File',
                            accept: { [mime]: [`.${ext}`] },
                        }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    return;
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    console.error('File System Access API failed, falling back to download:', err);
                } else {
                    return; // User cancelled
                }
            }

            // Fallback to standard download (blob)
            const a = document.createElement('a');
            a.href = window.URL.createObjectURL(blob);
            a.download = `X-tapnow_${node.type}_${Date.now()}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(a.href);

        } catch (error) {
            console.error('Download failed:', error);
            // Fallback: Direct Link (might open in new tab if CORS blocks download attr, but better than nothing)
            const a = document.createElement('a');
            a.href = url;
            a.download = `X-tapnow_${node.type}_${Date.now()}.${ext}`;
            a.target = "_blank"; // Ensure it opens even if blocked
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    const handleDownloadSelectedMedia = async () => {
        const selectedMediaNodes = nodes.filter(n =>
            selectedNodeIds.has(n.id) &&
            n.content &&
            (n.type === 'image' || n.type === 'video' || n.type === 'audio' || n.type === 'text')
        );

        for (let i = 0; i < selectedMediaNodes.length; i++) {
            await handleDownloadNodeMedia(selectedMediaNodes[i].id);
            if (i < selectedMediaNodes.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
    };

    return (
        <div
            className="w-screen h-screen bg-[#07090d] relative overflow-hidden font-sans text-white"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onContextMenu={handleCanvasContextMenu}
        >
            {/* Background Pattern - Moved inside InfiniteCanvas */}

            {/* Workflow Library Panel - Only in Canvas Mode */}
            {viewMode === 'canvas' && (
                <WorkflowLibraryPanel
                    isOpen={isWorkflowLibraryOpen}
                    onClose={() => setIsWorkflowLibraryOpen(false)}
                    currentNodes={nodes}
                    currentConnections={connections}
                    currentViewport={viewport}
                    onLoadWorkflow={handleLoadWorkflow}
                />
            )}

            {/* View Mode Switcher */}
            <div className="absolute top-6 left-6 z-[60] flex items-center gap-1 bg-zinc-900/90 border border-zinc-800 p-1 rounded-lg backdrop-blur-md shadow-xl">
                <button
                    onClick={() => setViewMode('canvas')}
                    className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all
                        ${viewMode === 'canvas' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}
                    `}
                >
                    <MoveIcon className="w-3.5 h-3.5" />
                    <span>Canvas</span>
                </button>
                <div className="w-px h-3 bg-zinc-700 mx-1"></div>
                <button
                    onClick={() => setViewMode('grid')}
                    className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all
                        ${viewMode === 'grid' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}
                    `}
                >
                    <GridIcon className="w-3.5 h-3.5" />
                    <span>List</span>
                </button>
            </div>

            {/* Sidebar - Only in Canvas Mode */}
            {viewMode === 'canvas' && (
                <Sidebar
                    onAddNode={addNewNode}
                    onAddVideoNode={addNewVideoNode}
                    onAddTextNode={addNewTextNode}
                    onAddAudioNode={addNewAudioNode}
                    onOpenSettings={() => setIsSettingsOpen(true)}
                    onSave={handleExport}
                    onLoad={handleImportClick}
                    onToggleLibrary={handleToggleLibrary}
                    isLibraryOpen={isWorkflowLibraryOpen}
                    onTogglePresets={() => setIsPromptPresetsOpen(prev => !prev)}
                    isPresetsOpen={isPromptPresetsOpen}
                    onOpenComposer={() => setIsImageComposerOpen(true)}
                    onNewProject={() => setIsNewProjectModalOpen(true)}
                    onArrangeSelectedImages={handleArrangeSelectedImages}
                    canArrangeSelectedImages={selectedImageCount > 1}
                    onChooseAutoSaveDirectory={handleChooseAutoSaveDirectory}
                    autoSaveDirectoryName={autoSaveDirectoryName}
                    isAutoSavingImages={isAutoSavingImages}
                />
            )}

            {viewMode === 'canvas' && isAutoSavePromptOpen && (
                <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/55 px-6 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-cyan-400/25 bg-zinc-950/95 p-5 shadow-2xl shadow-cyan-950/30">
                        <div className="mb-4 flex items-start gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/10 text-cyan-200">
                                <FolderIcon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                                <h2 className="text-sm font-semibold text-zinc-100">选择图片保存文件夹</h2>
                                <p className="mt-1 text-xs leading-5 text-zinc-400">
                                    {supportsDirectoryPicker()
                                        ? '选择一个本机文件夹，之后生成成功的图片会自动保存到这里。'
                                        : '当前地址无法直接选择固定文件夹，生成图片会下载到当前用户电脑，并保留在生成历史中。'}
                                </p>
                            </div>
                        </div>
                        <div className="mb-4 rounded-xl border border-zinc-800 bg-black/25 px-3 py-2 text-xs leading-5 text-zinc-400">
                            {autoSaveStatusMessage}
                        </div>
                        <button
                            type="button"
                            onClick={handleChooseAutoSaveDirectory}
                            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/15 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/25"
                        >
                            <FolderIcon className="h-4 w-4" />
                            <span>{supportsDirectoryPicker() ? '选择保存文件夹' : '使用本机下载目录'}</span>
                        </button>
                        <p className="mt-3 text-center text-[11px] leading-4 text-zinc-600">
                            {supportsDirectoryPicker()
                                ? '浏览器安全限制要求由你点击按钮后打开系统目录选择器。'
                                : '如需选择固定文件夹，请使用 HTTPS 访问此应用。'}
                        </p>
                    </div>
                </div>
            )}

            {/* Grid Mode View - Conditionally rendered to free resources */}
            {viewMode === 'grid' && (
                <GridModeView
                    nodes={nodes}
                    settings={appSettings}
                    onCreateTask={handleCreateTask}
                    onDeleteNode={handleDeleteNode}
                    onMaximize={handleNodeMaximize}
                    gridState={gridState}
                    onStateChange={(updates) => setGridState((prev: any) => ({ ...prev, ...updates }))}
                />
            )}

            {/* Settings Modal */}
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                settings={appSettings}
                onSave={handleSaveSettings}
            />

            {/* Generation History Panel */}
            <GenerationHistoryPanel
                isOpen={isPromptPresetsOpen}
                onClose={() => setIsPromptPresetsOpen(false)}
                items={generationHistory}
                nodes={nodes}
                onClear={handleClearGenerationHistory}
                onRestoreImage={handleRestoreHistoryImage}
            />

            <ImagePreviewModal
                isOpen={!!previewMedia}
                media={previewMedia}
                onClose={() => setPreviewMedia(null)}
            />

            {viewMode === 'canvas' && (
                <InfiniteCanvas
                    viewport={viewport}
                    theme={canvasTheme}
                    background={<ParticleCanvas theme={canvasTheme} viewport={viewport} />}
                    onViewportChange={(v) => {
                        setViewport(v);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={() => {
                        setSelectedNodeIds(new Set());
                        setSelectedGroupId(null);
                        setSelectedConnectionId(null);
                    }}
                >
                    {/* Groups Layer */}
                    {groups.map(group => (
                        <Group
                            key={group.id}
                            group={group}
                            nodes={nodes.filter(n => n.groupId === group.id && n.source !== 'grid')}
                            viewport={viewport}
                            isSelected={selectedGroupId === group.id}
                            onMouseDown={(e) => handleGroupMouseDown(e, group.id)}
                            onResize={(e, dir) => handleGroupResizeStart(e, group.id, dir)}
                            onTitleChange={(title) => handleGroupTitleChange(group.id, title)}
                            onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
                            onDelete={() => {
                                // Ask user whether to dissolve or delete completely
                                const result = window.confirm(
                                    '删除分组：\n\n' +
                                    '确定：仅解散分组，保留节点\n' +
                                    '取消：返回\n\n' +
                                    '如需彻底删除分组及内容，请使用右键菜单'
                                );
                                if (result) {
                                    // User clicked OK: dissolve group (keep nodes)
                                    handleDeleteGroup(group.id, false);
                                }
                            }}
                            onRun={(mode) => handleGroupRun(group.id, mode)}
                        />
                    ))}

                    {/* Connections Layer - Rendered after groups so they appear on top */}
                    <svg
                        className="absolute top-0 left-0 w-[10000px] h-[10000px] pointer-events-none overflow-visible"
                        style={{ transform: 'translateZ(0)', zIndex: 0 }}
                    >
                        {renderConnections().filter(pathElement => {
                            // This is hacking the JSX result which is messy. Better to filter data inside renderConnections.
                            // But I can't easily see renderConnections definition right now without another view.
                            // Let's assume renderConnections iterates 'connections' state.
                            // If I can't find it, I'll filter connections passed to it if it accepted args, but it takes none.
                            return true;
                        })}
                        {renderActiveConnection()}
                    </svg>

                    {/* Viewport Culling: Only render nodes that are visible in the current viewport AND not grid-hidden */}
                    {nodes.filter(node => node.source !== 'grid').filter(node => {
                        // Always render videos to avoid reload/buffering when scrolling back
                        if (node.type === 'video') return true;

                        const padding = 200; // Extra buffer area
                        const screenW = window.innerWidth / viewport.k;
                        const screenH = window.innerHeight / viewport.k;
                        const viewLeft = -viewport.x / viewport.k - padding;
                        const viewTop = -viewport.y / viewport.k - padding;
                        const viewRight = viewLeft + screenW + padding * 2;
                        const viewBottom = viewTop + screenH + padding * 2;

                        return (
                            node.position.x + node.width > viewLeft &&
                            node.position.x < viewRight &&
                            node.position.y + node.height > viewTop &&
                            node.position.y < viewBottom
                        );
                    }).map(node => (
                        <Node
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            showPanel={selectedNodeIds.has(node.id) && selectedNodeIds.size === 1 && !selectionBox}
                            onMouseDown={handleNodeMouseDown}
                            onNodeClick={handleNodeClick}
                            onDoubleClick={handleNodeDoubleClick}
                            onConnectStart={handleConnectStart}
                            onConnectEnd={handleConnectEnd}
                            onGenerate={handleGenerate}
                            onMaximize={handleNodeMaximize}
                            onUpload={handleUpload}
                            onResize={handleNodeResize}
                            onContextMenu={handleNodeContextMenu}
                            onPromptChange={handlePromptChange}
                            onContentChange={handleContentChange}
                            onParamsChange={handleParamsChange}
                            onDismissError={handleDismissError}
                            onTitleChange={handleNodeTitleChange}
                            onDownload={handleDownloadNodeMedia}
                            onRemoveBackground={handleRemoveBackground}
                            appSettings={appSettings}
                            onProviderChange={handleProviderChange}
                            onModelChange={handleModelChange}
                            isAutoResize={isAutoResize}
                            getFinalPrompt={getFinalPromptForNode}
                            onImageSwitch={handleImageSwitch}
                            onFontSizeChange={handleFontSizeChange}
                            onMultiAngleGenerate={handleMultiAngleGenerate}
                            upstreamImages={getUpstreamImagesForNode(node.id)}
                        />
                    ))}

                    {renderUnifiedConnectionInterface()}

                    {/* Selection Box - Now in World Space */}
                    {selectionBox && (
                        <div
                            className="absolute border-2 border-dashed border-cyan-400 bg-cyan-500/10 pointer-events-none z-[100] shadow-[0_0_18px_rgba(34,211,238,0.18)]"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY)
                            }}
                        />
                    )}
                </InfiniteCanvas>
            )}

            {/* Batch Selection Toolbar */}
            {selectedNodeIds.size > 1 && !selectionBox && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-[#18181b]/95 border border-zinc-700/50 rounded-full p-2 px-4 shadow-2xl z-50 animate-in slide-in-from-bottom-5 fade-in duration-200">
                    <span className="text-zinc-400 text-xs font-medium px-2">已选 {selectedNodeIds.size} 个</span>
                    <div className="h-4 w-px bg-zinc-700 mx-1" />
                    <button
                        onClick={handleBatchGenerate}
                        className="flex items-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs py-1.5 px-4 rounded-full transition-all shadow-lg hover:shadow-cyan-500/20 active:scale-95"
                    >
                        <Wand2Icon className="w-3.5 h-3.5" />
                        <span>全部生成</span>
                    </button>
                    <button
                        onClick={() => handleCreateGroup(Array.from(selectedNodeIds))}
                        className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs py-1.5 px-4 rounded-full transition-all border border-zinc-700 shadow-lg active:scale-95"
                        title="创建分组后可双击组名重命名"
                    >
                        <FolderIcon className="w-3.5 h-3.5 text-yellow-400" />
                        <span>打组</span>
                    </button>
                    <button
                        onClick={handleDownloadSelectedMedia}
                        className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs py-1.5 px-4 rounded-full transition-all border border-zinc-700 shadow-lg active:scale-95"
                    >
                        <DownloadIcon className="w-3.5 h-3.5" />
                        <span>批量下载</span>
                    </button>
                    <button
                        onClick={() => handleComposeSelected()}
                        className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs py-1.5 px-4 rounded-full transition-all border border-zinc-700 shadow-lg active:scale-95"
                    >
                        <LayersIcon className="w-3.5 h-3.5" />
                        <span>合成选中</span>
                    </button>
                    {/* Could add delete button here too for convenience */}
                </div>
            )}

            {/* Selection Box is now rendered inside InfiniteCanvas as a child */}

            {/* Helper Functions for Image Upload */}
            {/* These should be defined inside the component, but for this specific tool call I am inserting them here which is inside JSX if I am not careful. */}
            {viewMode === 'canvas' && (
                <>
                    {/* Tutorial Button */}
                    <button
                        type="button"
                        className="absolute bottom-6 left-6 z-50 flex items-center gap-2 bg-zinc-900/95 border border-zinc-800 rounded-full p-2 px-4 shadow-xl hover:bg-zinc-800 hover:text-white text-zinc-400 transition-all cursor-pointer group"
                    >
                        <BookOpenIcon className="w-4 h-4 group-hover:text-blue-400 transition-colors" />
                        <span className="text-xs font-medium">教程</span>
                    </button>

                    {/* Zoom Controls (Bottom Right) - Below Minimap */}
                    <div className="absolute bottom-6 right-6 flex w-[294px] items-center justify-end gap-4 bg-zinc-900/95 border border-zinc-800 rounded-full p-2 px-4 shadow-xl z-50">
                        <button
                            className="text-zinc-400 hover:text-white"
                            onClick={() => setViewport(prev => ({ ...prev, k: Math.max(0.1, prev.k - 0.1) }))}
                        >
                            -
                        </button>
                        <div className="w-24 h-1 bg-zinc-700 rounded-full overflow-hidden relative group cursor-pointer">
                            <div
                                className="absolute top-0 left-0 h-full bg-zinc-400 group-hover:bg-white transition-all"
                                style={{ width: `${Math.min(100, viewport.k * 50)}%` }}
                            />
                        </div>
                        <span className="text-xs text-zinc-500 w-8 text-right">{Math.round(viewport.k * 100)}%</span>
                        <button
                            className="text-zinc-400 hover:text-white"
                            onClick={() => setViewport(prev => ({ ...prev, k: Math.min(5, prev.k + 0.1) }))}
                        >
                            +
                        </button>
                        <div className="w-px h-4 bg-zinc-700 mx-1"></div>
                        <button
                            onClick={() => setViewport({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 150, k: 1 })}
                            className="text-zinc-500 hover:text-white transition-colors p-1"
                            title="Reset View"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                            </svg>
                        </button>
                    </div>

                    {/* Top Controls (Center) */}
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 pointer-events-auto">
                        <button
                            onClick={() => setIsAutoResize(!isAutoResize)}
                            className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors text-xs font-medium
                        ${isAutoResize
                                    ? 'bg-cyan-500/10 border-cyan-500/50 text-cyan-400'
                                    : 'bg-zinc-900/80 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                                }
                    `}
                        >
                            <MaximizeIcon className="w-3.5 h-3.5" />
                            <span>Auto-Resize</span>
                        </button>
                        <button
                            onClick={() => setCanvasTheme(prev => prev === 'dark' ? 'light' : 'dark')}
                            className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors text-xs font-medium
                        ${canvasTheme === 'light'
                                    ? 'bg-white/80 border-slate-300 text-slate-700 shadow-lg shadow-slate-200/40 hover:bg-white'
                                    : 'bg-zinc-900/80 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                                }
                    `}
                            title={canvasTheme === 'dark' ? '切换明亮主题' : '切换暗调主题'}
                        >
                            <PaletteIcon className="w-3.5 h-3.5" />
                            <span>{canvasTheme === 'dark' ? '暗调' : '明亮'}</span>
                        </button>
                    </div>
                </>
            )}

            {/* Top Right Controls */}
            <div className="absolute top-4 right-8 z-40 flex items-center gap-3">
                <div className="relative pointer-events-auto">
                    <button
                        onClick={() => setIsTopPromptWindowOpen(prev => !prev)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors text-xs font-medium ${
                            isTopPromptWindowOpen
                                ? 'bg-cyan-500/10 border-cyan-400/50 text-cyan-200'
                                : 'bg-zinc-900/80 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                        }`}
                        title="提示词窗口"
                    >
                        <FileTextIcon className="w-3.5 h-3.5" />
                        <span>提示词</span>
                    </button>

                    {isTopPromptWindowOpen && (
                        <div className="absolute right-0 top-full mt-3 w-[520px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/40 backdrop-blur">
                            <div className="border-b border-zinc-800 p-4">
                                <div className="mb-3 flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-semibold text-zinc-100">提示词窗口</div>
                                        <div className="mt-0.5 text-[11px] text-zinc-500">{allTopPromptPresets.length} 条已上传提示词</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <button
                                            type="button"
                                            onClick={handleImportTopPromptsClick}
                                            className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
                                            title="导入提示词预设"
                                        >
                                            <UploadIcon className="h-3.5 w-3.5" />
                                            <span>导入</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleExportTopPrompts}
                                            disabled={customTopPrompts.length === 0}
                                            className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                                            title="导出提示词预设"
                                        >
                                            <DownloadIcon className="h-3.5 w-3.5" />
                                            <span>导出</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setIsAddingTopPrompt(prev => !prev)}
                                            className="flex h-8 items-center gap-1.5 rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-2.5 text-[11px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20"
                                        >
                                            <PlusIcon className="h-3.5 w-3.5" />
                                            <span>新增</span>
                                        </button>
                                    </div>
                                </div>

                                <div className="mb-3 flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-black/25 px-3 text-zinc-500">
                                    <SearchIcon className="h-3.5 w-3.5 shrink-0" />
                                    <input
                                        value={topPromptSearch}
                                        onChange={(e) => setTopPromptSearch(e.target.value)}
                                        placeholder="搜索提示词..."
                                        className="h-full min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
                                    />
                                </div>

                                <div className="flex flex-wrap gap-2">
                                    {TOP_PROMPT_CATEGORIES.map(category => (
                                        <button
                                            key={category}
                                            type="button"
                                            onClick={() => setActiveTopPromptCategory(category)}
                                            className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                                                activeTopPromptCategory === category
                                                    ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                                                    : 'border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100'
                                            }`}
                                        >
                                            {category}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="max-h-[560px] overflow-y-auto p-3">
                                {isAddingTopPrompt && (
                                    <div className="mb-3 rounded-xl border border-cyan-400/25 bg-cyan-500/[0.06] p-3">
                                        <div className="mb-2 text-xs font-semibold text-cyan-100">新增提示词</div>
                                        <div className="grid grid-cols-[1fr_96px] gap-2">
                                            <input
                                                value={newTopPromptTitle}
                                                onChange={(e) => setNewTopPromptTitle(e.target.value)}
                                                placeholder="提示词标题"
                                                className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
                                            />
                                            <select
                                                value={newTopPromptCategory}
                                                onChange={(e) => setNewTopPromptCategory(e.target.value as TopPromptCategory)}
                                                className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-cyan-400/50"
                                            >
                                                {TOP_PROMPT_CATEGORIES.filter(category => category !== '全部').map(category => (
                                                    <option key={category} value={category}>{category}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <textarea
                                            value={newTopPromptContent}
                                            onChange={(e) => setNewTopPromptContent(e.target.value)}
                                            placeholder="输入提示词内容..."
                                            className="mt-2 min-h-24 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
                                        />
                                        <div className="mt-2 flex justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setIsAddingTopPrompt(false)}
                                                className="h-8 rounded-lg border border-zinc-800 px-3 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                                            >
                                                取消
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleAddTopPrompt}
                                                disabled={!newTopPromptTitle.trim() || !newTopPromptContent.trim()}
                                                className="h-8 rounded-lg bg-cyan-500 px-3 text-xs font-semibold text-zinc-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                                            >
                                                保存
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {visibleTopPromptPresets.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-zinc-800 bg-black/20 px-4 py-10 text-center text-xs text-zinc-500">
                                        暂无匹配的提示词
                                    </div>
                                ) : visibleTopPromptPresets.map((preset, index) => (
                                    <div
                                        key={preset.id}
                                        className="mb-3 rounded-xl border border-zinc-800 bg-zinc-900/55 p-3 transition-colors last:mb-0 hover:border-cyan-500/35"
                                    >
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-xs font-semibold text-zinc-100">{index + 1}. {preset.title}</div>
                                                <div className="mt-0.5 text-[10px] text-zinc-500">{preset.category}</div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => handleCopyTopPrompt(preset.id, preset.content)}
                                                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-950 px-2 text-[11px] font-medium text-zinc-300 transition-colors hover:border-cyan-400/50 hover:text-cyan-100"
                                            >
                                                {copiedTopPromptId === preset.id ? (
                                                    <>
                                                        <CheckIcon className="h-3.5 w-3.5 text-emerald-400" />
                                                        <span>已复制</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <CopyIcon className="h-3.5 w-3.5" />
                                                        <span>复制</span>
                                                    </>
                                                )}
                                            </button>
                                        </div>
                                        <p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-black/20 p-3 text-xs leading-5 text-zinc-300">
                                            {preset.content}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Context Menu */}
            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    onClose={handleCloseContextMenu}
                    items={contextMenu.type === 'group' ? [
                        {
                            label: '重命名',
                            icon: <EditIcon className="w-4 h-4 text-blue-400" />,
                            onClick: () => { /* Logic handled by double click for now, or we can focus input */ }
                        },
                        {
                            label: '颜色',
                            icon: <PaletteIcon className="w-4 h-4 text-pink-400" />,
                            children: [
                                { label: '默认灰', onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-slate-800/20') },
                                { label: '蓝色', icon: <div className="w-3 h-3 rounded-full bg-blue-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-blue-500/20') },
                                { label: '绿色', icon: <div className="w-3 h-3 rounded-full bg-emerald-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-emerald-500/20') },
                                { label: '黄色', icon: <div className="w-3 h-3 rounded-full bg-yellow-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-yellow-500/20') },
                                { label: '红色', icon: <div className="w-3 h-3 rounded-full bg-red-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-red-500/20') },
                                { label: '紫色', icon: <div className="w-3 h-3 rounded-full bg-purple-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-purple-500/20') },
                                { label: '青色', icon: <div className="w-3 h-3 rounded-full bg-cyan-500/50" />, onClick: () => handleGroupColorChange(contextMenu.groupId!, 'bg-cyan-500/20') },
                            ]
                        },
                        { separator: true },
                        {
                            label: '解散分组',
                            icon: <ScanIcon className="w-4 h-4" />,
                            onClick: () => {
                                const groupId = contextMenu.groupId!;
                                const nodesInGroup = nodes.filter(n => n.groupId === groupId);
                                const nodeCount = nodesInGroup.length;

                                setConfirmDialog({
                                    isOpen: true,
                                    title: '解散分组',
                                    message: `此操作将解散分组，但保留所有 ${nodeCount} 个节点。\n\n节点将恢复为独立状态。`,
                                    isDanger: false,
                                    onConfirm: () => {
                                        handleDeleteGroup(groupId, false);
                                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                                    }
                                });
                            }
                        },
                        {
                            label: '彻底删除',
                            danger: true,
                            icon: <Trash2Icon className="w-4 h-4" />,
                            onClick: () => {
                                const groupId = contextMenu.groupId!;
                                const nodesInGroup = nodes.filter(n => n.groupId === groupId);
                                const nodeCount = nodesInGroup.length;

                                setConfirmDialog({
                                    isOpen: true,
                                    title: '彻底删除分组',
                                    message: `此操作将删除分组及其内部的所有 ${nodeCount} 个节点。\n\n删除后可通过 Ctrl/⌘+Z 撤回，请谨慎操作。`,
                                    isDanger: true,
                                    onConfirm: () => {
                                        handleDeleteGroup(groupId, true);
                                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                                    }
                                });
                            }
                        }
                    ] : contextMenu.type === 'node' ? (() => {
                        const node = nodes.find(n => n.id === contextMenu.nodeId);
                        const isMediaNode = node && (node.type === 'image' || node.type === 'video');

                        return [
                            {
                                label: '创建分组',
                                icon: <FolderIcon className="w-4 h-4 text-yellow-500" />,
                                onClick: () => {
                                    if (selectedNodeIds.size > 0) {
                                        handleCreateGroup(Array.from(selectedNodeIds));
                                    } else if (contextMenu.nodeId) {
                                        handleCreateGroup([contextMenu.nodeId]);
                                    }
                                }
                            },
                            { separator: true },
                            {
                                label: '下载',
                                icon: <UploadIcon className="w-4 h-4 rotate-180" />, // Save/Download
                                onClick: () => {
                                    if (contextMenu.nodeId) {
                                        handleDownloadNodeMedia(contextMenu.nodeId);
                                    }
                                }
                            },
                            // Only show Compose option for Image/Video nodes
                            ...(isMediaNode ? [{
                                label: '发送至合成',
                                icon: <LayersIcon className="w-4 h-4 text-blue-400" />,
                                onClick: () => handleComposeSelected(new Set([contextMenu.nodeId!]))
                            }] : []),
                            {
                                label: '复制',
                                icon: <CopyIcon className="w-4 h-4" />,
                                onClick: () => {
                                    const node = nodes.find(n => n.id === contextMenu.nodeId);
                                    if (node) {
                                        const idsToCopy = selectedNodeIds.has(node.id) && selectedNodeIds.size > 1
                                            ? selectedNodeIds
                                            : new Set([node.id]);
                                        copyNodesToClipboard(idsToCopy);
                                    }
                                }
                            },
                            {
                                label: '删除',
                                icon: <Trash2Icon className="w-4 h-4" />,
                                danger: true,
                                onClick: () => {
                                    if (contextMenu.nodeId) {
                                        if (selectedNodeIds.has(contextMenu.nodeId!) && selectedNodeIds.size > 1) {
                                            handleDeleteNode();
                                        } else {
                                            handleDeleteNode(contextMenu.nodeId);
                                        }
                                    }
                                }
                            }
                        ]
                    })() : contextMenu.connectionSource ? [
                        {
                            label: '图片节点',
                            icon: <ImageIcon className="w-4 h-4 text-emerald-500" />,
                            onClick: () => addNewNode(contextMenu.canvasX, contextMenu.canvasY)
                        },
                        {
                            label: '视频节点',
                            icon: <VideoIcon className="w-4 h-4 text-blue-500" />,
                            onClick: () => addNewVideoNode(contextMenu.canvasX, contextMenu.canvasY)
                        },
                        {
                            label: '音频节点',
                            icon: <AudioIcon className="w-4 h-4 text-amber-400" />,
                            onClick: () => addNewAudioNode(contextMenu.canvasX, contextMenu.canvasY)
                        },
                        {
                            label: '文本节点',
                            icon: <FileTextIcon className="w-4 h-4 text-gray-400" />,
                            onClick: () => addNewTextNode(contextMenu.canvasX, contextMenu.canvasY)
                        }
                    ] : [
                        {
                            label: '新建分组',
                            icon: <FolderIcon className="w-4 h-4 text-yellow-500" />,
                            onClick: () => {
                                if (contextMenu.canvasX && contextMenu.canvasY) {
                                    handleCreateGroup(undefined, { x: contextMenu.canvasX, y: contextMenu.canvasY });
                                }
                            }
                        },
                        {
                            label: '上传',
                            icon: <UploadIcon className="w-4 h-4" />,
                            onClick: () => {
                                if (contextMenu.canvasX && contextMenu.canvasY) {
                                    uploadPosRef.current = { x: contextMenu.canvasX, y: contextMenu.canvasY };
                                }
                                imageInputRef.current?.click();
                            }
                        },
                        {
                            label: '添加节点',
                            // icon: <PlusIcon className="w-4 h-4" />, // Optional, screenshot doesn't show icon for parent
                            children: [
                                {
                                    label: '图片节点',
                                    icon: <ImageIcon className="w-4 h-4 text-emerald-500" />,
                                    onClick: () => addNewNode(contextMenu.canvasX, contextMenu.canvasY)
                                },
                                {
                                    label: '视频节点',
                                    icon: <VideoIcon className="w-4 h-4 text-blue-500" />,
                                    onClick: () => addNewVideoNode(contextMenu.canvasX, contextMenu.canvasY)
                                },
                                {
                                    label: '音频节点',
                                    icon: <AudioIcon className="w-4 h-4 text-amber-400" />,
                                    onClick: () => addNewAudioNode(contextMenu.canvasX, contextMenu.canvasY)
                                },
                                {
                                    label: '文本节点',
                                    icon: <FileTextIcon className="w-4 h-4 text-gray-400" />,
                                    onClick: () => addNewTextNode(contextMenu.canvasX, contextMenu.canvasY)
                                }
                            ]
                        },
                        { separator: true },
                        {
                            label: '清空画布',
                            danger: true,
                            onClick: () => {
                                setConfirmDialog({
                                    isOpen: true,
                                    title: '清空画布',
                                    message: '清空后可通过 Ctrl/⌘+Z 撤回，请确认',
                                    isDanger: true,
                                    onConfirm: () => {
                                        recordCanvasUndoSnapshot();
                                        setNodes([]);
                                        setConnections([]);
                                        setGroups([]); // 娓呴櫎鍒嗙粍
                                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                                    }
                                });
                            }
                        }
                    ]}
                />
            )}

            {viewMode === 'canvas' && (
                <Minimap
                    nodes={nodes}
                    viewport={viewport}
                    onViewportChange={(v) => {
                        setViewport(v);
                        setContextMenu(null);
                    }}
                />
            )}

            {/* Hidden File Input */}
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".json"
                onChange={handleFileChange}
            />
            <input
                type="file"
                ref={topPromptImportInputRef}
                className="hidden"
                accept=".json,application/json"
                onChange={handleTopPromptImportFileChange}
            />
            {/* Hidden Image Input */}
            <input
                type="file"
                ref={imageInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleImageInputChange}
            />


            <WelcomeNotice
                isOpen={showWelcomeNotice}
                onConfirm={handleWelcomeNoticeConfirm}
            />

            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                title={confirmDialog.title}
                message={confirmDialog.message}
                onConfirm={confirmDialog.onConfirm}
                onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                isDanger={confirmDialog.isDanger}
            />

            {/* Image Composer Modal */}
            <ImageComposerModal
                isOpen={isImageComposerOpen}
                onClose={() => {
                    setIsImageComposerOpen(false);
                    setComposerInitialImages([]);
                }}
                initialImages={composerInitialImages}
                onSendToCard={handleComposerSendToCard}
            />

            {/* New Project Modal */}
            <NewProjectModal
                isOpen={isNewProjectModalOpen}
                onClose={() => setIsNewProjectModalOpen(false)}
                onCreateProject={handleCreateProjectFromShots}
                appSettings={appSettings}
            />
        </div>
    );
};

export default App;
