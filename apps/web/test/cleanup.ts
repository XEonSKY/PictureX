import { rmSync } from 'node:fs';
import { closeAllAlbumDatabases } from '../server/database/album';

/**
 * better-sqlite3 13 / Node 26 在 Windows 上不再允许删除仍被连接持有的数据库文件。
 * 测试清理临时目录前先关闭相册连接，避免 finally 里的 EPERM 变成未处理错误。
 */
export function removeAlbumTree(
    path: string,
    options: { maxRetries?: number, retryDelay?: number } = {},
): void {
    closeAllAlbumDatabases();
    rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
        ...options,
    });
}
