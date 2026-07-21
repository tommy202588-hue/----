# 图片生成、保存与生成历史问题修复报告

## 一、结论摘要

本次问题包含三部分：

1. 局域网 HTTP 页面无法直接选择用户本地文件夹。
2. 图片保存曾错误地写入运行 Vite 服务的电脑，并出现中文路径乱码导致 `ENOENT`。
3. Comfly 图片生成请求被新逻辑错误地改成代理优先，导致原本可用的请求链路返回 404。

当前版本已经完成修复：

- 局域网 HTTP 下不再调用服务器电脑的文件夹选择器。
- 图片会下载到当前访问用户电脑的浏览器下载目录，不会写入服务器电脑。
- 生成图片会写入 IndexedDB，生成历史刷新页面后仍可查看、预览和下载。
- HTTPS 环境继续支持用户选择固定本地文件夹并自动保存。
- Comfly 恢复原来的请求模式，并恢复 Images API 兜底逻辑。

## 二、问题原因

### 1. 局域网 HTTP 的浏览器限制

用户访问的是类似下面的地址：

```text
http://192.168.x.x:5178
```

浏览器只允许在 `localhost` 或 HTTPS 安全上下文中调用 `showDirectoryPicker()`。因此，局域网 HTTP 页面不能直接取得“当前用户电脑任意文件夹”的写入权限。

之前的降级方案由 Vite 服务端打开 Windows 文件夹选择器，选择到的是运行服务那台电脑的目录，不是访问网页的用户电脑目录。这不符合多用户场景。

### 2. 中文路径乱码导致 `ENOENT`

Windows PowerShell 返回中文目录路径时使用系统代码页，Node 端按 UTF-8 直接读取后，路径中的中文变成了 `����`。最终写入了一个不存在的乱码路径，因此出现：

```text
ENOENT: no such file or directory
```

该问题已不再影响正式的用户端下载流程。

### 3. Comfly 生图请求链路回归

`services/apiAdapters/openaiAdapter.ts` 的新逻辑曾将 Comfly 强制改为 `proxy-first`，并新增一段无条件的 Chat 请求。该代码提前结束了原有流程，使之前能工作的直连和 Images API 兜底无法正常执行。

修复后：

- 保留用户设置的 `direct-first` 或 `proxy-first`。
- 直连失败时仍可以回退到本地代理。
- Chat 请求失败时继续尝试 Images API。

## 三、最终实现

### 图片保存

保存逻辑位于 [App.tsx](C:/Users/Administrator/Documents/meitu/X-tapnow-main-workcopy-prompt-5178/App.tsx)：

- 安全上下文可用时：使用浏览器原生目录句柄，直接写入用户选择的文件夹。
- 局域网 HTTP 或不支持目录 API 时：使用浏览器下载能力，文件保存到当前用户电脑的下载目录。
- 服务端不再参与图片文件写入。

局域网 HTTP 下界面按钮会显示“使用本机下载目录”，这是有意设计，用来明确提示文件保存位置属于当前访问用户。

### 生成历史

生成历史现在使用 IndexedDB 保存完整图片数据，存储键为：

```text
X-tapnow_generation_history_v2
```

用户可以在“生成历史”中：

- 查看生成图片；
- 刷新页面后继续查看；
- 点击图片恢复到画布；
- 下载图片；
- 清空历史记录。

`localStorage` 仍保留兼容数据，但大图片的主要持久化位置已经改为 IndexedDB，避免浏览器容量限制导致历史丢失。

## 四、使用方式

### 当前局域网 HTTP 部署

1. 用户打开网页。
2. 点击“使用本机下载目录”。
3. 生成图片后，图片下载到该用户浏览器配置的下载目录。
4. 打开“生成历史”可以查看和再次下载图片。

### 需要固定文件夹自动保存

必须让用户通过 HTTPS 访问应用，例如：

```text
https://your-domain.example
```

HTTPS 环境下，按钮会恢复为“选择保存文件夹”，用户选择的目录属于用户自己的电脑。

## 五、验证结果

- `npm run build`：通过。
- 中文路径 UTF-8 Base64 编解码：通过，路径逐字一致。
- 局域网 HTTP 页面：不再调用服务器端文件夹选择器。
- 生成历史 IndexedDB 读写：已接入生成、加载和清空流程。
- Comfly 请求适配器：已恢复直连优先和 Images API 兜底。

## 六、涉及文件

- [App.tsx](C:/Users/Administrator/Documents/meitu/X-tapnow-main-workcopy-prompt-5178/App.tsx)：图片保存、目录能力判断、生成历史持久化。
- [openaiAdapter.ts](C:/Users/Administrator/Documents/meitu/X-tapnow-main-workcopy-prompt-5178/services/apiAdapters/openaiAdapter.ts)：Comfly/OpenAI 图片请求流程。
- [vite.config.ts](C:/Users/Administrator/Documents/meitu/X-tapnow-main-workcopy-prompt-5178/vite.config.ts)：开发服务和 API 代理配置。

