/**
 * 桌面查看器与 Electron 主进程之间的桥（仅桌面壳里存在）。
 * Web 端没有这个桥，页面会退化为提示，不做任何文件系统访问。
 */

export interface ViewerFileInfo {
    ref: string
    name: string
    sha256: string
    kind: 'image' | 'video'
    mime: string
    size: number
    url: string
}

export interface ViewerBridge {
    stat: (ref: string) => Promise<ViewerFileInfo | null>
}

export function getViewerBridge(): ViewerBridge | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const bridge = (window as unknown as { picturexViewer?: ViewerBridge }).picturexViewer;

    return bridge && typeof bridge.stat === 'function' ? bridge : null;
}
