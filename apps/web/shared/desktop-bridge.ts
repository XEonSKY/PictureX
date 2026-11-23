/**
 * 桌面壳与主窗口之间的桥（仅安装版/桌面窗口存在）。
 * Web 部署版没有这个桥，设置页会退化为说明文案，不发起任何更新请求。
 */

export type DesktopUpdateChannel = 'latest' | 'pre';

export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date'
  | 'error' | 'unsupported';

export interface DesktopInfo {
    version: string
    packaged: boolean
    channel: DesktopUpdateChannel
    platform: string
}

export interface DesktopUpdateStatus {
    phase: DesktopUpdatePhase
    currentVersion: string
    channel: DesktopUpdateChannel
    supported: boolean
    version: string | null
    percent: number | null
    checkedAt: string | null
    error: string | null
}

export interface DesktopBridge {
    info: () => Promise<DesktopInfo | null>
    updateStatus: () => Promise<DesktopUpdateStatus | null>
    checkForUpdates: () => Promise<DesktopUpdateStatus | null>
    installUpdate: () => Promise<boolean>
    subscribeUpdateStatus: (handler: (status: DesktopUpdateStatus) => void) => number
    unsubscribeUpdateStatus: (id: number) => void
}

export function getDesktopBridge(): DesktopBridge | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const bridge = (window as unknown as { picturexDesktop?: DesktopBridge }).picturexDesktop;

    if (!bridge
      || typeof bridge.info !== 'function'
      || typeof bridge.checkForUpdates !== 'function'
      || typeof bridge.subscribeUpdateStatus !== 'function') {
        return null;
    }

    return bridge;
}
