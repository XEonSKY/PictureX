import { contextBridge, ipcRenderer } from 'electron';

/**
 * 查看器窗口暴露给渲染进程的唯一桥：按不透明 ref 取文件元数据。
 * 只返回展示/入库所需字段与 pxfile 地址，绝不返回真实磁盘路径来源之外的能力。
 */
contextBridge.exposeInMainWorld('picturexViewer', {
    stat: (ref: string): Promise<unknown> => ipcRenderer.invoke('viewer:stat', ref),
});
