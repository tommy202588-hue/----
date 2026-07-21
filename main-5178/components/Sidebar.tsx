import React from 'react';
import { PlusIcon, SettingsIcon, DownloadIcon, UploadIcon, FolderIcon, VideoIcon, TypeIcon, HistoryIcon, LayersIcon, FileTextIcon, ArrangeIcon, AudioIcon } from './Icons';

type ArrangeMode = 'horizontal' | 'vertical' | 'grid';


interface SidebarProps {
  onAddNode: () => void;
  onAddVideoNode: () => void;
  onAddTextNode: () => void;
  onAddAudioNode: () => void;
  onOpenSettings: () => void;
  onSave: () => void;
  onLoad: () => void;
  onToggleLibrary: () => void;
  isLibraryOpen: boolean;
  onTogglePresets: () => void;
  isPresetsOpen: boolean;
  onOpenComposer: () => void;
  onNewProject: () => void;
  onArrangeSelectedImages: (mode: ArrangeMode) => void;
  canArrangeSelectedImages: boolean;
  onChooseAutoSaveDirectory: () => void;
  autoSaveDirectoryName: string;
  isAutoSavingImages: boolean;
}

const arrangeOptions: Array<{ mode: ArrangeMode; label: string }> = [
  { mode: 'horizontal', label: '水平排列' },
  { mode: 'vertical', label: '垂直排列' },
  { mode: 'grid', label: '宫格排列' }
];

const Sidebar: React.FC<SidebarProps> = ({
  onAddNode,
  onAddVideoNode,
  onAddTextNode,
  onAddAudioNode,
  onOpenSettings,
  onSave,
  onLoad,
  onToggleLibrary,
  isLibraryOpen,
  onTogglePresets,
  isPresetsOpen,
  onOpenComposer,
  onNewProject,
  onArrangeSelectedImages,
  canArrangeSelectedImages,
  onChooseAutoSaveDirectory,
  autoSaveDirectoryName,
  isAutoSavingImages
}) => {
  const [isArrangeMenuOpen, setIsArrangeMenuOpen] = React.useState(false);

  React.useEffect(() => {
    if (!canArrangeSelectedImages) {
      setIsArrangeMenuOpen(false);
    }
  }, [canArrangeSelectedImages]);

  const handleArrangeMenuToggle = () => {
    if (!canArrangeSelectedImages) return;
    setIsArrangeMenuOpen(prev => !prev);
  };

  const handleArrangeOptionClick = (mode: ArrangeMode) => {
    onArrangeSelectedImages(mode);
    setIsArrangeMenuOpen(false);
  };

  return (
    <div className="absolute left-6 top-1/2 -translate-y-1/2 flex flex-col gap-4 z-50">
      <div className="bg-[#27272a] border border-zinc-800 rounded-2xl p-2 flex flex-col gap-2 shadow-xl">
        <SidebarBtn icon={<PlusIcon />} label="Add Image Node" onClick={onAddNode} primary />
        <SidebarBtn icon={<VideoIcon />} label="Add Video Node" onClick={onAddVideoNode} primary />
        <SidebarBtn icon={<TypeIcon />} label="Add Text Node" onClick={onAddTextNode} primary />
        <SidebarBtn icon={<AudioIcon />} label="Add Audio Node" onClick={onAddAudioNode} primary />
        <SidebarBtn icon={<FileTextIcon />} label="新建工程" onClick={onNewProject} primary />
        <div className="h-px bg-zinc-800 my-1 mx-2" />
        <SidebarBtn
          icon={<FolderIcon />}
          label="我的工作流"
          onClick={onToggleLibrary}
          isActive={isLibraryOpen}
        />
        <SidebarBtn
          icon={<HistoryIcon />}
          label="生成历史"
          onClick={onTogglePresets}
          isActive={isPresetsOpen}
        />
        <SidebarBtn icon={<DownloadIcon />} label="导出项目" onClick={onSave} />
        <SidebarBtn icon={<UploadIcon />} label="导入项目" onClick={onLoad} />
        <SidebarBtn
          icon={<FolderIcon />}
          label={autoSaveDirectoryName ? `保存到：${autoSaveDirectoryName}` : "选择图片保存文件夹"}
          onClick={onChooseAutoSaveDirectory}
          accent={!!autoSaveDirectoryName}
          isBusy={isAutoSavingImages}
        />
        <div className="h-px bg-zinc-800 my-1 mx-2" />
        <SidebarBtn icon={<SettingsIcon />} label="设置" onClick={onOpenSettings} />
        <div className="h-px bg-zinc-800 my-1 mx-2" />
        <div className="relative">
          <SidebarBtn
            icon={<ArrangeIcon />}
            label={canArrangeSelectedImages ? "自动排列" : "框选至少 2 张图片"}
            onClick={handleArrangeMenuToggle}
            disabled={!canArrangeSelectedImages}
            accent={canArrangeSelectedImages}
            isActive={isArrangeMenuOpen}
          />
          {isArrangeMenuOpen && (
            <div className="absolute left-full top-0 ml-3 w-28 overflow-hidden rounded-xl border border-cyan-400/25 bg-zinc-950/95 p-1 shadow-2xl shadow-cyan-950/30 backdrop-blur">
              {arrangeOptions.map(option => (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => handleArrangeOptionClick(option.mode)}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-zinc-200 transition-colors hover:bg-cyan-500/15 hover:text-cyan-100 focus:outline-none focus:ring-1 focus:ring-cyan-400/60"
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <SidebarBtn icon={<LayersIcon />} label="视觉合成" onClick={onOpenComposer} />
      </div>
    </div>
  );
};

const SidebarBtn = ({
  icon,
  label,
  onClick,
  primary,
  isActive,
  disabled,
  accent,
  isBusy
}: {
  icon: React.ReactNode,
  label: string,
  onClick?: () => void,
  primary?: boolean,
  isActive?: boolean,
  disabled?: boolean,
  accent?: boolean,
  isBusy?: boolean
}) => {
  const toneClass = disabled
    ? 'text-zinc-600 cursor-not-allowed opacity-60'
    : accent
      ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-400/35 hover:bg-cyan-500/25 hover:text-cyan-100 shadow-[0_0_16px_rgba(34,211,238,0.12)]'
      : primary
        ? 'bg-zinc-700 text-white hover:bg-zinc-600'
        : isActive
          ? 'bg-white text-zinc-900 shadow-lg scale-105'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200 group relative ${toneClass}`}
    >
      <div className="w-5 h-5 [&>svg]:w-full [&>svg]:h-full">{icon}</div>
      {isBusy && (
        <span className="absolute right-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" />
      )}

      {/* Tooltip */}
      {!isActive && (
        <div className="absolute left-full ml-3 px-2 py-1 bg-zinc-900 text-zinc-300 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap border border-zinc-800 z-50 shadow-lg">
          {label}
        </div>
      )}
    </button>
  );
};

export default Sidebar;
