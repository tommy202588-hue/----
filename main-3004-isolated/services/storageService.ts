import { get, set } from 'idb-keyval';
import { NodeData, Connection, GroupData } from '../types';

const STORAGE_KEY = 'X-tapnow_project_data';

export interface ProjectData {
    nodes: NodeData[];
    connections: Connection[];
    groups?: GroupData[];
    viewport?: { x: number; y: number; k: number };
    version: number;
    settings?: any; // AppSettings
    characters?: any[]; // Character list
    extraConfig?: Record<string, string>; // Legacy keys like sora_api_base_url
}

const CURRENT_VERSION = 1;

// --- IndexedDB (Auto-save) ---

export const saveProjectToIndexedDB = async (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = []
) => {
    const data: ProjectData = {
        nodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION
    };
    await set(STORAGE_KEY, data);
};

export const loadProjectFromIndexedDB = async (): Promise<ProjectData | null> => {
    const data = await get(STORAGE_KEY) as ProjectData | null;
    if (data && data.nodes) {
        data.nodes = data.nodes.map(node => {
            if (node.blob) {
                if (typeof node.content === 'string' && node.content.startsWith('data:image')) {
                    return node;
                }
                return {
                    ...node,
                    content: URL.createObjectURL(node.blob)
                };
            }
            return node;
        });
    }
    return data;
};

// --- File Export/Import ---

// Helper: Convert Blob to Base64
const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

// Helper: Convert Base64 to Blob
const base64ToBlob = (base64: string): Blob => {
    const parts = base64.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
};

const redactProviderApiKey = (provider: any) => {
    if (!provider || typeof provider !== 'object') return provider;
    if (!('apiKey' in provider)) return provider;
    return { ...provider, apiKey: '' };
};

const sanitizeSettingsForExport = (rawSettings: any) => {
    if (!rawSettings || typeof rawSettings !== 'object') return rawSettings;

    return {
        ...rawSettings,
        imageProviders: Array.isArray(rawSettings.imageProviders)
            ? rawSettings.imageProviders.map(redactProviderApiKey)
            : rawSettings.imageProviders,
        videoProviders: Array.isArray(rawSettings.videoProviders)
            ? rawSettings.videoProviders.map(redactProviderApiKey)
            : rawSettings.videoProviders,
        textProviders: Array.isArray(rawSettings.textProviders)
            ? rawSettings.textProviders.map(redactProviderApiKey)
            : rawSettings.textProviders,
        audioProviders: Array.isArray(rawSettings.audioProviders)
            ? rawSettings.audioProviders.map(redactProviderApiKey)
            : rawSettings.audioProviders,
    };
};

export const exportProjectToJson = async (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = [],
    includeSensitiveData: boolean = false
) => {
    // Serialize images sequentially to avoid holding many FileReader/base64
    // conversions in memory at the same time. Multi-image nodes use allBlobs
    // as the single source of truth instead of exporting the primary image twice.
    const serializableNodes: any[] = [];
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        const serialized: any = { ...node };

        if (node.allBlobs && node.allBlobs.length > 0) {
            serialized.allBlobsData = [];
            for (const imageBlob of node.allBlobs) {
                serialized.allBlobsData.push(await blobToBase64(imageBlob));
            }
            delete serialized.allBlobs;
            delete serialized.allImages;
            delete serialized.blob;
            serialized.content = '';
        } else if (node.blob) {
            serialized.blobData = await blobToBase64(node.blob);
            delete serialized.blob;
            if (typeof serialized.content === 'string' && /^(blob:|data:image)/i.test(serialized.content)) {
                serialized.content = '';
            }
        } else if (typeof serialized.content === 'string' && serialized.content.startsWith('blob:')) {
            serialized.content = '';
        }

        serializableNodes.push(serialized);
        if (nodeIndex % 3 === 2) {
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
    }

    // Gather extra data for backup
    let settings;
    try {
        const s = localStorage.getItem('X-tapnow_app_settings');
        if (s) {
            const parsedSettings = JSON.parse(s);
            settings = includeSensitiveData ? parsedSettings : sanitizeSettingsForExport(parsedSettings);
        }
    } catch (e) {
        console.error('Failed to read settings for export', e);
    }

    let characters;
    try {
        const c = localStorage.getItem('sora_characters');
        if (c) {
            characters = JSON.parse(c);
        }
    } catch (e) {
        console.error('Failed to read characters for export', e);
    }

    const extraConfig: Record<string, string> = {};
    const baseUrl = localStorage.getItem('sora_api_base_url');
    if (baseUrl) extraConfig['sora_api_base_url'] = baseUrl;

    if (includeSensitiveData) {
        const token = localStorage.getItem('sora_character_token');
        if (token) extraConfig['sora_character_token'] = token;
    }

    const data: ProjectData = {
        nodes: serializableNodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION,
        settings,
        characters,
        extraConfig
    };

    const jsonString = JSON.stringify(data);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `X-tapnow-project-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

// --- Workflow Library (Internal) ---

export interface WorkflowEntry {
    id: string;
    name: string;
    timestamp: number;
    nodes: NodeData[];
    connections: Connection[];
    groups?: GroupData[];
    viewport?: { x: number; y: number; k: number };
}

const WORKFLOWS_KEY = 'X-tapnow_workflows';

export const saveWorkflowToLibrary = async (
    name: string,
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number }
) => {
    const workflows = (await get(WORKFLOWS_KEY)) as WorkflowEntry[] || [];

    const cleanNodes = nodes.map(n => ({
        ...n,
        status: 'idle' as const,
    }));

    const newEntry: WorkflowEntry = {
        id: crypto.randomUUID(),
        name,
        timestamp: Date.now(),
        nodes: cleanNodes,
        connections,
        viewport
    };

    workflows.push(newEntry);
    await set(WORKFLOWS_KEY, workflows);
    return newEntry;
};

export const getWorkflowLibrary = async (): Promise<WorkflowEntry[]> => {
    return (await get(WORKFLOWS_KEY)) || [];
};

export const deleteWorkflowFromLibrary = async (id: string) => {
    const workflows = (await get(WORKFLOWS_KEY)) as WorkflowEntry[] || [];
    const newWorkflows = workflows.filter(w => w.id !== id);
    await set(WORKFLOWS_KEY, newWorkflows);
    return newWorkflows;
};

export const exportWorkflowToJson = (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = []
) => {
    // Create a lightweight version (stripping images)
    const lightweightNodes = nodes.map(node => ({
        ...node,
        content: '', // Clear generated image content
        status: 'idle' as const // Reset status
    }));

    const data: ProjectData = {
        nodes: lightweightNodes,
        connections,
        groups,
        viewport,
        version: CURRENT_VERSION
    };

    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `X-tapnow-workflow-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

export const importProjectFromJson = (file: File): Promise<ProjectData> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const result = e.target?.result as string;
                const data = JSON.parse(result) as ProjectData;

                // Basic validation
                if (!Array.isArray(data.nodes) || !Array.isArray(data.connections)) {
                    reject(new Error("Invalid project file format"));
                    return;
                }

                // Convert base64 back to blobs
                data.nodes = data.nodes.map((node: any) => {
                    const restored: any = { ...node };

                    // Restore all blobs from base64
                    if (node.allBlobsData && Array.isArray(node.allBlobsData)) {
                        restored.allBlobs = node.allBlobsData.map((base64: string) =>
                            base64ToBlob(base64)
                        );
                        restored.allImages = restored.allBlobs.map((blob: Blob) =>
                            URL.createObjectURL(blob)
                        );
                        const currentIndex = Math.min(
                            Math.max(Number(restored.currentImageIndex) || 0, 0),
                            Math.max(restored.allBlobs.length - 1, 0)
                        );
                        restored.currentImageIndex = currentIndex;
                        restored.blob = restored.allBlobs[currentIndex];
                        restored.content = restored.allImages[currentIndex] || '';
                        delete restored.allBlobsData;
                    }

                    // Restore legacy/single-image exports.
                    if (!restored.blob && node.blobData) {
                        restored.blob = base64ToBlob(node.blobData);
                        restored.content = URL.createObjectURL(restored.blob);
                    }
                    delete restored.blobData;

                    return restored;
                });

                resolve(data);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
    });
};

// --- Settings Management ---

import { AppSettings, ApiProvider } from '../types/settings';

const SETTINGS_KEY = 'X-tapnow_app_settings';
const MINIMAX_VIDEO_PROVIDER_ID = 'default-minimax-video';
const LEGACY_CREDENTIAL_CLEANUP_KEY = 'X-tapnow_legacy_credential_cleanup_2026_07_21_v1';
const LEGACY_CREDENTIAL_KEYS = [
    'gemini_api_key',
    'sora_api_key',
    'text_api_key',
    'audio_api_key',
    'sora_character_token'
];

const COMFLY_IMAGE_PROVIDER_ID = 'default-comfly-image';

declare global {
    interface Window {
        desktopCredentials?: {
            load: () => Record<string, string>;
            save: (credentials: Record<string, string>) => boolean;
        };
        desktopRuntime?: { isElectron: boolean };
    }
}

const getDesktopCredentialStore = () =>
    typeof window !== 'undefined' ? window.desktopCredentials : undefined;

const getProviderCredentials = (settings: AppSettings): Record<string, string> => {
    const credentials: Record<string, string> = {};
    const providers = [
        ...settings.imageProviders,
        ...settings.videoProviders,
        ...settings.textProviders,
        ...(settings.audioProviders || [])
    ];
    providers.forEach(provider => {
        if (provider.id && provider.apiKey) credentials[provider.id] = provider.apiKey;
    });
    return credentials;
};

const isXwangPreset = (provider: ApiProvider) =>
    provider.baseUrl?.includes('api.xwang.store') ||
    ['xwang', 'xwang audio'].includes(provider.name?.trim().toLowerCase() || '');

const isComflyPreset = (provider: ApiProvider) =>
    provider.id === COMFLY_IMAGE_PROVIDER_ID ||
    provider.baseUrl?.includes('ai.comfly.org') ||
    provider.name?.trim().toLowerCase() === 'comfly';

const normalizeProviderDefault = (
    providers: ApiProvider[],
    currentDefault?: string
): { providers: ApiProvider[]; defaultProvider?: string } => {
    const defaultProvider = providers.some(provider => provider.id === currentDefault)
        ? currentDefault
        : providers.find(provider => provider.isDefault)?.id || providers[0]?.id;
    return {
        providers: providers.map(provider => ({ ...provider, isDefault: provider.id === defaultProvider })),
        defaultProvider
    };
};

const removeDeprecatedProviderPresets = (settings: AppSettings): boolean => {
    const image = normalizeProviderDefault(settings.imageProviders.filter(provider => !isComflyPreset(provider)), settings.defaultImageProvider);
    const video = normalizeProviderDefault(settings.videoProviders.filter(provider => !isXwangPreset(provider)), settings.defaultVideoProvider);
    const text = normalizeProviderDefault(settings.textProviders.filter(provider => !isXwangPreset(provider)), settings.defaultTextProvider);
    const audio = normalizeProviderDefault((settings.audioProviders || []).filter(provider => !isXwangPreset(provider)), settings.defaultAudioProvider);
    const changed = image.providers.length !== settings.imageProviders.length ||
        video.providers.length !== settings.videoProviders.length ||
        text.providers.length !== settings.textProviders.length ||
        audio.providers.length !== (settings.audioProviders || []).length;

    if (!changed) return false;
    settings.imageProviders = image.providers;
    settings.videoProviders = video.providers;
    settings.textProviders = text.providers;
    settings.audioProviders = audio.providers;
    settings.defaultImageProvider = image.defaultProvider;
    settings.defaultVideoProvider = video.defaultProvider;
    settings.defaultTextProvider = text.defaultProvider;
    settings.defaultAudioProvider = audio.defaultProvider;
    return true;
};

// 鐢熸垚鍞竴ID
const generateId = () => `provider-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// 淇濆瓨璁剧疆锟?localStorage
export const saveSettings = (settings: AppSettings) => {
    const credentialStore = getDesktopCredentialStore();
    if (credentialStore) {
        const saved = credentialStore.save(getProviderCredentials(settings));
        if (saved) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettingsForExport(settings)));
            return;
        }
        console.warn('Windows credential encryption is unavailable; provider credentials remain in local storage.');
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

export const removeLegacyCredentialsOnce = (): void => {
    if (localStorage.getItem(LEGACY_CREDENTIAL_CLEANUP_KEY) === '1') return;
    LEGACY_CREDENTIAL_KEYS.forEach(key => localStorage.removeItem(key));
    localStorage.setItem(LEGACY_CREDENTIAL_CLEANUP_KEY, '1');
};

// 锟?localStorage 鍔犺浇璁剧疆
export const loadSettings = (): AppSettings | null => {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
        try {
            const settings = JSON.parse(stored) as AppSettings;
            const storedCredentials = getDesktopCredentialStore()?.load() || {};
            const hadPlaintextCredentials = [
                ...settings.imageProviders,
                ...settings.videoProviders,
                ...settings.textProviders,
                ...(settings.audioProviders || [])
            ].some(provider => Boolean(provider.apiKey));

            // 鍏煎鎬у鐞嗭細涓虹己灏憈ype鐨勬彁渚涘晢娣诲姞绫诲瀷
            const ensureType = (providers: ApiProvider[]) => {
                return providers.map(p => {
                    if (!(p as any).type) {
                        // 鏅鸿兘鎺ㄦ柇type
                        if (p.baseUrl?.includes('openai.com')) {
                            return { ...p, type: 'openai' as const };
                        }
                        // 榛樿涓篻emini
                        return { ...p, type: 'gemini' as const };
                    }
                    return p;
                });
            };

            // 涓篛penAI鎻愪緵鍟嗘坊鍔犻粯璁ndpoint妯″紡
            const ensureEndpointMode = (providers: ApiProvider[]) => {
                return providers.map(p => {
                    if ((p as any).type === 'openai' && !(p as any).endpointMode) {
                        return { ...p, endpointMode: 'chat' as const };
                    }
                    return p;
                });
            };

            const hydrateCredentials = (providers: ApiProvider[]) => providers.map(provider => ({
                ...provider,
                apiKey: storedCredentials[provider.id] || provider.apiKey || ''
            }));

            const normalizedSettings: AppSettings = {
                imageProviders: hydrateCredentials(ensureEndpointMode(ensureType(settings.imageProviders))),
                videoProviders: hydrateCredentials(ensureEndpointMode(ensureType(settings.videoProviders))),
                textProviders: hydrateCredentials(ensureEndpointMode(ensureType(settings.textProviders))),
                audioProviders: hydrateCredentials(ensureEndpointMode(ensureType((settings as any).audioProviders || []))),
                defaultImageProvider: settings.defaultImageProvider,
                defaultVideoProvider: settings.defaultVideoProvider,
                defaultTextProvider: settings.defaultTextProvider,
                defaultAudioProvider: (settings as any).defaultAudioProvider,
                apiRequestMode: (settings as any).apiRequestMode || 'direct-first',
                concurrencyLimit: settings.concurrencyLimit || 15 // 榛樿骞跺彂鏁颁负15
            };
            if (hadPlaintextCredentials && getDesktopCredentialStore()) {
                saveSettings(normalizedSettings);
            }
            return normalizedSettings;
        } catch (e) {
            console.error('Failed to parse settings:', e);
            return null;
        }
    }
    return null;
};

// 鏁版嵁杩佺Щ锛氫粠鏃х殑鍗曚竴API閰嶇疆杩佺Щ鍒版柊鐨勫API鏍煎紡
export const migrateOldSettings = (): AppSettings => {
    const settings: AppSettings = {
        imageProviders: [],
        videoProviders: [],
        textProviders: [],
        audioProviders: []
    };

    // 杩佺Щ鍥惧儚鐢熸垚閰嶇疆
    const oldImageApiKey = localStorage.getItem('gemini_api_key');
    const oldImageBaseUrl = localStorage.getItem('gemini_base_url');
    if (oldImageApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Gemini (Migrated)',
            apiKey: oldImageApiKey,
            baseUrl: oldImageBaseUrl || 'https://generativelanguage.googleapis.com',
            type: 'gemini',
            models: [
                { id: 'gemini-2.0-flash-exp', displayName: 'Gemini 2.0 Flash' },
                { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' }
            ],
            isDefault: true
        };
        settings.imageProviders.push(provider);
        settings.defaultImageProvider = provider.id;
    }

    // 杩佺Щ瑙嗛鐢熸垚閰嶇疆
    const oldVideoApiKey = localStorage.getItem('sora_api_key');
    const oldVideoBaseUrl = localStorage.getItem('sora_base_url');
    if (oldVideoApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Sora (Migrated)',
            apiKey: oldVideoApiKey,
            baseUrl: oldVideoBaseUrl || 'https://api.openai.com',
            type: 'sora',
            models: [
                { id: 'sora-2', displayName: 'Sora 2' },
                { id: 'sora-2-all', displayName: 'Sora 2 All' }
            ],
            isDefault: true
        };
        settings.videoProviders.push(provider);
        settings.defaultVideoProvider = provider.id;
    }

    // 杩佺Щ鏂囨湰鐢熸垚閰嶇疆
    const oldTextApiKey = localStorage.getItem('text_api_key');
    const oldTextBaseUrl = localStorage.getItem('text_base_url');
    if (oldTextApiKey) {
        const provider: ApiProvider = {
            id: generateId(),
            name: 'Gemini (Migrated)',
            apiKey: oldTextApiKey,
            baseUrl: oldTextBaseUrl || 'https://generativelanguage.googleapis.com',
            type: 'gemini',
            models: [
                { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
                { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash' }
            ],
            isDefault: true
        };
        settings.textProviders.push(provider);
        settings.defaultTextProvider = provider.id;
    }

    saveSettings(settings);
    return settings;
};

// 鍒濆鍖栬缃細濡傛灉娌℃湁鏂拌缃紝鍒欎粠鏃ч厤缃縼锟?
export const initializeSettings = (): AppSettings => {
    let settings = loadSettings();

    if (!settings) {
        // 灏濊瘯杩佺Щ鏃ч厤锟?
        settings = migrateOldSettings();

        // 濡傛灉杩佺Щ鍚庝粛鐒舵病鏈変换浣曟彁渚涘晢锛屽垱寤虹┖鐨勯粯璁ょ粨锟?
        if (settings.imageProviders.length === 0 &&
            settings.videoProviders.length === 0 &&
            settings.textProviders.length === 0) {
            // 杩斿洖鍒濆棰勮閰嶇疆
            settings = {
                imageProviders: [],
                videoProviders: [],
                audioProviders: [],
                textProviders: [],
                apiRequestMode: 'direct-first',
                concurrencyLimit: 15 // 榛樿骞跺彂鏁颁负15
            };
        } else {
            // 淇濆瓨杩佺Щ鍚庣殑璁剧疆
            saveSettings(settings);
        }
    }

    if (!settings.audioProviders) {
        settings.audioProviders = [];
    }

    if (removeDeprecatedProviderPresets(settings)) {
        saveSettings(settings);
    }

    // Add the official H3 provider to both new and existing settings while
    // preserving the user's current provider, default, and API credentials.
    const existingMiniMaxIndex = settings.videoProviders.findIndex(provider =>
        provider.id === MINIMAX_VIDEO_PROVIDER_ID ||
        provider.type === 'minimax' ||
        provider.baseUrl?.includes('api.minimaxi.com')
    );
    if (existingMiniMaxIndex === -1) {
        const isFirstVideoProvider = settings.videoProviders.length === 0;
        settings.videoProviders.push({
            id: MINIMAX_VIDEO_PROVIDER_ID,
            name: 'MiniMax',
            apiKey: '',
            baseUrl: 'https://api.minimaxi.com',
            type: 'minimax',
            models: [{ id: 'MiniMax-H3', displayName: 'MiniMax H3' }],
            isDefault: isFirstVideoProvider
        });
        if (!settings.defaultVideoProvider && isFirstVideoProvider) {
            settings.defaultVideoProvider = MINIMAX_VIDEO_PROVIDER_ID;
        }
        saveSettings(settings);
    } else {
        const provider = settings.videoProviders[existingMiniMaxIndex];
        const hasH3 = provider.models.some(model => model.id === 'MiniMax-H3');
        const nextProvider: ApiProvider = {
            ...provider,
            type: 'minimax',
            baseUrl: provider.baseUrl || 'https://api.minimaxi.com',
            models: hasH3
                ? provider.models
                : [...provider.models, { id: 'MiniMax-H3', displayName: 'MiniMax H3' }]
        };
        if (JSON.stringify(nextProvider) !== JSON.stringify(provider)) {
            settings.videoProviders[existingMiniMaxIndex] = nextProvider;
            saveSettings(settings);
        }
    }

    return settings;
};

// --- 閰嶇疆瀵煎嚭/瀵煎叆 ---

// 瀵煎嚭閰嶇疆涓篔SON鏂囦欢
export const exportSettings = (settings: AppSettings) => {
    const dataStr = JSON.stringify(settings, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `X-tapnow-settings-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
};

// 浠嶫SON鏂囦欢瀵煎叆閰嶇疆
export const importSettings = (file: File): Promise<AppSettings> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const result = e.target?.result as string;
                const settings = JSON.parse(result) as AppSettings;

                // 鍩烘湰楠岃瘉
                if (!settings.imageProviders || !settings.videoProviders || !settings.textProviders) {
                    reject(new Error("Invalid settings file format"));
                    return;
                }

                // 纭繚鎵€鏈塸rovider閮芥湁type瀛楁
                const ensureType = (providers: any[]) => {
                    return providers.map(p => {
                        if (!p.type) {
                            if (p.baseUrl?.includes('openai.com')) {
                                return { ...p, type: 'openai' as const };
                            }
                            return { ...p, type: 'gemini' as const };
                        }
                        return p;
                    });
                };

                const validatedSettings: AppSettings = {
                    imageProviders: ensureType(settings.imageProviders),
                    videoProviders: ensureType(settings.videoProviders),
                    textProviders: ensureType(settings.textProviders),
                    audioProviders: ensureType((settings as any).audioProviders || []),
                    defaultImageProvider: settings.defaultImageProvider,
                    defaultVideoProvider: settings.defaultVideoProvider,
                    defaultTextProvider: settings.defaultTextProvider,
                    defaultAudioProvider: (settings as any).defaultAudioProvider,
                    apiRequestMode: (settings as any).apiRequestMode || 'direct-first',
                    concurrencyLimit: settings.concurrencyLimit || 15
                };

                resolve(validatedSettings);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
    });
};
