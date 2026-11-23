import { createWriteStream, existsSync, statSync } from 'node:fs';
import { toIso, toIsoRequired } from '../utils/time';
import { rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { asc, isNull } from 'drizzle-orm';
import { getAlbum } from '../album/album-store';
import type { AlbumDatabase } from '../database/album';
import { assets } from '../database/schemas/album';
import { livePhotoMeta } from './asset-query';
import { ApiError } from '../hono/problem';
import type { Settings } from '../settings/setting-schema';
import { storageForAlbum } from '../storage/registry';
import type { StorageAdapter } from '../storage/types';

/**
 * 导出全部图片到一个普通文件夹：按入库顺序复制文件，并写一份清单
 * （uuid、文件名、顺序 ID、拍摄/入库/修改时间、导出后的文件名）。
 * 命名方式决定目标文件名，重名自动加 `-2` 后缀，绝不覆盖已有文件。
 */

export type ExportNaming = 'sequence' | 'filename' | 'uuid';

export interface ExportOptions {
    targetPath: string
    naming: ExportNaming
}

export interface ExportManifestItem {
    uuid: string
    filename: string
    sequence: number
    takenAt: string | null
    addedAt: string
    modifiedAt: string | null
    exportedAs: string
    liveExportedAs: string | null
    size: number
    sha256: string
}

export type ExportEvent
    = | { type: 'start', total: number, targetPath: string }
      | { type: 'progress', done: number, total: number, filename: string }
      | { type: 'missing', filename: string }
      | { type: 'cancelled' }
      | { type: 'done', exported: number, missing: number, manifest: string };

export interface ExportPlan {
    albumId: string
    db: AlbumDatabase
    albumName: string
    albumDir: string
    targetDir: string
    storage: StorageAdapter
}

const MANIFEST_FILE = 'picturex-export.json';

export function planExport(settings: Settings, albumId: string, options: ExportOptions): ExportPlan {
    const context = getAlbum(settings, albumId);
    const albumDir = resolve(context.dir);
    const targetDir = resolve(options.targetPath.trim());

    if (targetDir === albumDir || targetDir.startsWith(`${albumDir}${sep}`)) {
        throw new ApiError(422, 'export_target_invalid', 'The export target must be outside the album folder.');
    }

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        throw new ApiError(422, 'export_target_missing', 'The export target folder does not exist.');
    }

    return {
        albumId,
        db: context.db.album,
        albumName: context.index.name,
        albumDir,
        targetDir,
        storage: storageForAlbum(context.dir, settings),
    };
}

function uniqueName(base: string, used: Set<string>, targetDir: string): string {
    const extension = extname(base);
    const stem = extension === '' ? base : base.slice(0, -extension.length);
    let name = base;
    let counter = 1;

    // 同时避开本次导出的重名和目录里已存在的文件，绝不覆盖用户数据
    while (used.has(name) || existsSync(join(targetDir, name))) {
        counter += 1;
        name = `${stem}-${counter}${extension}`;
    }

    used.add(name);

    return name;
}

function uniqueExportName(
    row: typeof assets.$inferSelect,
    index: number,
    naming: ExportNaming,
    used: Set<string>,
    targetDir: string,
): string {
    const ext = row.ext === '' ? '' : `.${row.ext}`;
    const base = naming === 'uuid'
        ? `${row.id}${ext}`
        : naming === 'filename'
            ? row.filename
            : `${String(index + 1).padStart(4, '0')}_${row.filename}`;

    return uniqueName(base, used, targetDir);
}

export async function* exportAlbumAssets(
    plan: ExportPlan,
    options: ExportOptions,
    signal?: AbortSignal,
): AsyncGenerator<ExportEvent> {
    const rows = plan.db
        .select()
        .from(assets)
        .where(isNull(assets.deletedAt))
        .orderBy(asc(assets.storageKey))
        .all();

    yield { type: 'start', total: rows.length, targetPath: plan.targetDir };

    const used = new Set<string>();
    const manifest: ExportManifestItem[] = [];
    let missing = 0;

    for (const [index, row] of rows.entries()) {
        if (signal?.aborted) {
            yield { type: 'cancelled' };

            return;
        }

        const name = uniqueExportName(row, index, options.naming, used, plan.targetDir);
        const destination = join(plan.targetDir, name);
        let liveName: string | null = null;

        try {
            const source = await plan.storage.open(row.storageKey);

            await pipeline(source, createWriteStream(destination, { flags: 'wx' }), { signal });

            const live = livePhotoMeta(row);

            if (live) {
                const liveExt = extname(live.storageKey);
                const stem = extname(name) === '' ? name : name.slice(0, -extname(name).length);

                liveName = uniqueName(`${stem}-live${liveExt}`, used, plan.targetDir);

                const liveSource = await plan.storage.open(live.storageKey);

                await pipeline(
                    liveSource,
                    createWriteStream(join(plan.targetDir, liveName), { flags: 'wx' }),
                    { signal },
                );
            }
        }
        catch (error) {
            // 失败/取消会留下不完整文件；但 wx 因目标已存在失败时绝不能删别人的文件
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                if (signal?.aborted) {
                    await rm(destination, { force: true }).catch(() => undefined);

                    if (liveName !== null) {
                        await rm(join(plan.targetDir, liveName), { force: true }).catch(() => undefined);
                    }
                }
                else {
                    await rm(join(plan.targetDir, liveName ?? name), { force: true }).catch(() => undefined);
                }
            }

            if (signal?.aborted) {
                yield { type: 'cancelled' };

                return;
            }

            if (liveName !== null) {
                // 图片已导出但实况视频失败：保留图片并记录缺失
                missing += 1;
                yield { type: 'missing', filename: `${row.filename} (${liveName})` };
                liveName = null;
            }
            else {
                missing += 1;
                yield { type: 'missing', filename: row.filename };

                continue;
            }
        }

        let modifiedAt: string | null = null;

        try {
            modifiedAt = new Date(statSync(destination).mtimeMs).toISOString();
        }
        catch {
            // 写盘后拿不到时间就不记
        }

        manifest.push({
            uuid: row.id,
            filename: row.filename,
            sequence: index + 1,
            takenAt: toIso(row.takenAt),
            addedAt: toIsoRequired(row.addedAt),
            modifiedAt,
            exportedAs: name,
            liveExportedAs: liveName,
            size: row.size,
            sha256: row.sha256,
        });

        yield {
            type: 'progress',
            done: manifest.length,
            total: rows.length,
            filename: name,
        };
    }

    if (signal?.aborted) {
        yield { type: 'cancelled' };

        return;
    }

    // 清单也参与重名规避，并用 wx 写盘，绝不覆盖上一次导出或用户文件
    let manifestName = uniqueName(MANIFEST_FILE, used, plan.targetDir);
    const payload = JSON.stringify({
        albumId: plan.albumId,
        albumName: plan.albumName,
        exportedAt: new Date().toISOString(),
        naming: options.naming,
        total: manifest.length,
        missing,
        items: manifest,
    }, null, 2);

    for (let attempt = 0; ; attempt += 1) {
        try {
            await writeFile(join(plan.targetDir, manifestName), payload, { encoding: 'utf8', flag: 'wx' });

            break;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) {
                throw error;
            }

            manifestName = uniqueName(MANIFEST_FILE, used, plan.targetDir);
        }
    }

    yield { type: 'done', exported: manifest.length, missing, manifest: manifestName };
}
