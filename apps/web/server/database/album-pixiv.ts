import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PIXIV_DDL } from './pixiv';
import { pixivRelations } from './schemas/pixiv';

/**
 * 相册级 Pixiv 库 `<album>/data/pixiv.db`：全局库同构 5 表的「按相册裁剪副本」。
 *
 * 只装本相册实际存在的作品（含画师与 Pixiv 标签关系），因此随相册目录一起搬去别的设备后，
 * 不需要重新联网就能读到作品详情；数据根的全局库退化成「所有相册副本的汇总」，删掉可重建。
 * asset ↔ 分P 映射与补全断点仍在 picture.db（它们外键依赖 assets 的级联删除）。
 */

export type AlbumPixivDatabase = BetterSQLite3Database<typeof pixivRelations> & {
    $client: Database.Database
};

const ALBUM_PIXIV_SCHEMA_VERSION = 3;

export function createAlbumPixivDatabase(client: Database.Database): AlbumPixivDatabase {
    if (Number(client.pragma('user_version', { simple: true })) < ALBUM_PIXIV_SCHEMA_VERSION) {
        client.exec(PIXIV_DDL);
        client.pragma(`user_version = ${ALBUM_PIXIV_SCHEMA_VERSION}`);
    }

    return drizzle({ client, relations: pixivRelations });
}
