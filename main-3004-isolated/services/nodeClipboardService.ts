import { Connection, NodeData } from '../types';

export const PORTABLE_NODE_CLIPBOARD_TYPE = 'X-tapnow-nodes';
export const PORTABLE_NODE_CLIPBOARD_VERSION = 2;

export interface PortableNodeClipboardPayload {
    type: typeof PORTABLE_NODE_CLIPBOARD_TYPE;
    version: typeof PORTABLE_NODE_CLIPBOARD_VERSION;
    sourceOrigin: string;
    createdAt: number;
    nodes: NodeData[];
    connections: Connection[];
}

export interface PreparedPortableNodeAssets {
    content: string;
    allImages?: string[];
    currentImageIndex?: number;
}

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片数据失败。'));
    reader.readAsDataURL(blob);
});

const dataUrlToBlob = (dataUrl: string): Blob => {
    const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new Error('剪贴板中的图片数据格式无效。');

    const mimeType = match[1] || 'image/png';
    const encoded = match[3] || '';
    const binary = match[2] ? atob(encoded) : decodeURIComponent(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
};

const urlToPortableValue = async (value: string, fallbackBlob?: Blob): Promise<string> => {
    if (fallbackBlob instanceof Blob && fallbackBlob.size > 0) {
        return await blobToDataUrl(fallbackBlob);
    }

    const normalized = String(value || '').trim();
    if (!normalized) return '';
    if (normalized.startsWith('data:')) return normalized;

    try {
        const response = await fetch(normalized);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await blobToDataUrl(await response.blob());
    } catch {
        if (/^https?:\/\//i.test(normalized)) return normalized;
        throw new Error('无法读取节点图片。请重新上传图片后再复制。');
    }
};

export const preparePortableNodeAssets = async (node: NodeData): Promise<PreparedPortableNodeAssets> => {
    const sourceAllImages = Array.isArray(node.allImages) ? node.allImages : [];
    const sourceAllBlobs = Array.isArray(node.allBlobs) ? node.allBlobs : [];
    const portableAllImages: string[] = [];
    const imageCount = Math.max(sourceAllImages.length, sourceAllBlobs.length);

    for (let index = 0; index < imageCount; index += 1) {
        portableAllImages.push(await urlToPortableValue(
            sourceAllImages[index] || '',
            sourceAllBlobs[index]
        ));
    }

    const currentImageIndex = Math.min(
        Math.max(Number(node.currentImageIndex) || 0, 0),
        Math.max(portableAllImages.length - 1, 0)
    );
    const content = portableAllImages.length > 0
        ? portableAllImages[currentImageIndex] || portableAllImages[0] || ''
        : node.type === 'image' && (node.content || node.blob)
            ? await urlToPortableValue(node.content || '', node.blob)
            : node.content || '';

    return {
        content,
        allImages: portableAllImages.length > 0 ? portableAllImages : undefined,
        currentImageIndex: portableAllImages.length > 0 ? currentImageIndex : undefined
    };
};

const getSynchronousPortableAssets = (node: NodeData): PreparedPortableNodeAssets | null => {
    if (node.blob instanceof Blob || node.allBlobs?.some(blob => blob instanceof Blob)) return null;

    const allImages = Array.isArray(node.allImages) ? node.allImages : [];
    if (allImages.some(image => typeof image === 'string' && image.startsWith('blob:'))) return null;
    if (typeof node.content === 'string' && node.content.startsWith('blob:')) return null;

    const currentImageIndex = allImages.length > 0
        ? Math.min(Math.max(Number(node.currentImageIndex) || 0, 0), allImages.length - 1)
        : undefined;
    return {
        content: allImages.length > 0
            ? allImages[currentImageIndex || 0] || allImages[0] || ''
            : node.content || '',
        allImages: allImages.length > 0 ? [...allImages] : undefined,
        currentImageIndex
    };
};

const serializeNodeWithAssets = (node: NodeData, assets: PreparedPortableNodeAssets): NodeData => {
    const {
        blob: _blob,
        allBlobs: _allBlobs,
        taskId: _taskId,
        remixedFromVideoId: _remixedFromVideoId,
        errorDetails: _errorDetails,
        startTime: _startTime,
        executionTime: _executionTime,
        groupId: _groupId,
        isReferenceImage: _isReferenceImage,
        ...portableNode
    } = node;

    return {
        ...portableNode,
        content: assets.content,
        allImages: assets.allImages,
        currentImageIndex: assets.currentImageIndex,
        isReferenceImage: false,
        status: assets.content ? 'success' : 'idle',
        progress: 0,
        selected: false
    };
};

const createPayload = (
    nodes: NodeData[],
    connections: Connection[],
    nodeIdSet: Set<string>
): PortableNodeClipboardPayload => ({
    type: PORTABLE_NODE_CLIPBOARD_TYPE,
    version: PORTABLE_NODE_CLIPBOARD_VERSION,
    sourceOrigin: window.location.origin || 'file://',
    createdAt: Date.now(),
    nodes,
    // Keep every incoming edge for the copied nodes. Internal edges are remapped
    // to pasted nodes, while edges from an unselected upstream node can reconnect
    // to that existing node when pasted back into the same canvas.
    connections: connections.filter(connection => nodeIdSet.has(connection.toNodeId))
});

export const buildPortableNodeClipboardData = async (
    nodes: NodeData[],
    connections: Connection[],
    nodeIds: Iterable<string>
): Promise<PortableNodeClipboardPayload> => {
    const nodeIdSet = new Set(nodeIds);
    const portableNodes: NodeData[] = [];

    for (const node of nodes.filter(candidate => nodeIdSet.has(candidate.id))) {
        portableNodes.push(serializeNodeWithAssets(node, await preparePortableNodeAssets(node)));
    }

    return createPayload(portableNodes, connections, nodeIdSet);
};

export const buildPreparedPortableNodeClipboardData = (
    nodes: NodeData[],
    connections: Connection[],
    nodeIds: Iterable<string>,
    preparedAssets: ReadonlyMap<string, PreparedPortableNodeAssets>
): PortableNodeClipboardPayload => {
    const nodeIdSet = new Set(nodeIds);
    const portableNodes = nodes
        .filter(node => nodeIdSet.has(node.id))
        .map(node => {
            const assets = preparedAssets.get(node.id) || getSynchronousPortableAssets(node);
            if (!assets) {
                throw new Error(`节点“${node.title || node.id}”的图片正在准备，请稍候一秒后再次复制。`);
            }
            return serializeNodeWithAssets(node, assets);
        });

    return createPayload(portableNodes, connections, nodeIdSet);
};

const restoreNode = (node: NodeData): NodeData => {
    const portableAllImages = Array.isArray(node.allImages) ? node.allImages : [];
    const restoredAllImages: string[] = [];
    const restoredAllBlobs: Blob[] = [];

    portableAllImages.forEach(value => {
        if (typeof value === 'string' && value.startsWith('data:')) {
            const blob = dataUrlToBlob(value);
            restoredAllBlobs.push(blob);
            restoredAllImages.push(URL.createObjectURL(blob));
        } else {
            restoredAllImages.push(value);
        }
    });

    let restoredContent = node.content || '';
    let restoredBlob: Blob | undefined;
    const restoredIndex = Math.min(
        Math.max(Number(node.currentImageIndex) || 0, 0),
        Math.max(restoredAllImages.length - 1, 0)
    );

    if (restoredAllImages.length > 0) {
        restoredContent = restoredAllImages[restoredIndex] || restoredAllImages[0] || '';
        restoredBlob = restoredAllBlobs.length === restoredAllImages.length
            ? restoredAllBlobs[restoredIndex]
            : undefined;
    } else if (typeof restoredContent === 'string' && restoredContent.startsWith('data:')) {
        restoredBlob = dataUrlToBlob(restoredContent);
        restoredContent = URL.createObjectURL(restoredBlob);
    } else if (typeof restoredContent === 'string' && restoredContent.startsWith('blob:')) {
        throw new Error('该节点来自旧版画布，只包含已失效的临时 Blob 地址。请在升级后的来源画布重新复制。');
    }

    return {
        ...node,
        content: restoredContent,
        blob: restoredBlob,
        allImages: restoredAllImages.length > 0 ? restoredAllImages : undefined,
        allBlobs: restoredAllBlobs.length === restoredAllImages.length && restoredAllBlobs.length > 0
            ? restoredAllBlobs
            : undefined,
        currentImageIndex: restoredAllImages.length > 0 ? restoredIndex : undefined,
        taskId: undefined,
        remixedFromVideoId: undefined,
        errorDetails: undefined,
        startTime: undefined,
        executionTime: undefined,
        groupId: undefined,
        isReferenceImage: false,
        progress: 0,
        status: restoredContent ? 'success' : 'idle',
        selected: false
    };
};

export const restorePortableNodeClipboardData = (value: unknown): {
    nodes: NodeData[];
    connections: Connection[];
} => {
    const payload = value as Partial<PortableNodeClipboardPayload> | null;
    if (!payload || payload.type !== PORTABLE_NODE_CLIPBOARD_TYPE || !Array.isArray(payload.nodes)) {
        throw new Error('剪贴板中没有可识别的画布节点。');
    }

    return {
        nodes: payload.nodes.map(restoreNode),
        connections: Array.isArray(payload.connections) ? payload.connections : []
    };
};
