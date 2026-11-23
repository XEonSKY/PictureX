import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyViewerFile, type ViewerKind } from './media-types';

/**
 * 查看器已打开文件的登记表：既是 `pxfile:` 协议的访问白名单，也是内容哈希缓存。
 * 只有经 OS「打开方式 / 双击」或应用内「新窗口」显式登记过的文件才可被读取，
 * 渲染进程拿到的永远是 `pxfile://media/<ref>` 这种不透明引用，拿不到真实路径来源。
 */

export interface ViewerFileRecord {
    ref: string
    path: string
    name: string
    sha256: string
    kind: ViewerKind
    mime: string
    size: number
    /** 登记时解析出的真实路径与文件身份（dev/ino）：协议请求时复核，挡住登记后被换成软链接/替换的文件 */
    realpath: string
    dev: number
    ino: number
}

const records = new Map<string, ViewerFileRecord>();

function sha256OfFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);

        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

export async function registerViewerFile(filePath: string): Promise<ViewerFileRecord | null> {
    if (!existsSync(filePath)) {
        return null;
    }

    const type = classifyViewerFile(filePath);

    if (!type) {
        return null;
    }

    let realpath: string;
    let stat: ReturnType<typeof statSync>;

    try {
        // 解析真实路径（跟随符号链接一次），以解析后的文件身份作为后续复核基准
        realpath = realpathSync(filePath);
        stat = statSync(realpath);
    }
    catch {
        return null;
    }

    if (!stat.isFile()) {
        return null;
    }

    const sha256 = await sha256OfFile(realpath);
    const record: ViewerFileRecord = {
        ref: randomUUID(),
        path: filePath,
        name: basename(filePath),
        sha256,
        kind: type.kind,
        mime: type.mime,
        size: stat.size,
        realpath,
        dev: stat.dev,
        ino: stat.ino,
    };

    records.set(record.ref, record);

    return record;
}

export function getViewerFile(ref: string): ViewerFileRecord | undefined {
    return records.get(ref);
}

/**
 * 协议请求时复核登记文件仍是同一份内容：
 * 本机攻击者可能在窗口打开后把登记路径 rename 成指向敏感文件的软链。
 * 真实路径、设备号、inode 任一不符即判定已被替换。
 */
export function isViewerRecordCurrent(record: ViewerFileRecord): boolean {
    try {
        const realpath = realpathSync(record.path);
        const stat = statSync(realpath);

        return realpath === record.realpath && stat.dev === record.dev && stat.ino === record.ino && stat.isFile();
    }
    catch {
        return false;
    }
}

export function releaseViewerFile(ref: string): void {
    records.delete(ref);
}
