/**
 * 浏览器端解析 Pixiv ugoira zip。
 * 只支持 stored/deflate，足够覆盖 Pixiv 的帧压缩包；无需服务端解压依赖。
 */

interface ZipEntry {
    name: string
    method: number
    compressedSize: number
    localOffset: number
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEocd(view: DataView): number {
    const minimum = Math.max(0, view.byteLength - 65_557);

    for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
        if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
            return offset;
        }
    }

    return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const eocd = findEocd(view);

    if (eocd < 0) {
        throw new Error('ZIP end-of-central-directory record not found.');
    }

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const entries: ZipEntry[] = [];

    for (let index = 0; index < count; index += 1) {
        if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
            throw new Error('Invalid ZIP central directory.');
        }

        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

        entries.push({ name, method, compressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    const result = new Map<string, Uint8Array>();

    for (const entry of entries) {
        if (view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) {
            continue;
        }

        const nameLength = view.getUint16(entry.localOffset + 26, true);
        const extraLength = view.getUint16(entry.localOffset + 28, true);
        const start = entry.localOffset + 30 + nameLength + extraLength;
        const data = bytes.subarray(start, start + entry.compressedSize);

        if (entry.method === 0) {
            result.set(entry.name, data.slice());
        }
        else if (entry.method === 8) {
            result.set(entry.name, await inflateRaw(data));
        }
    }

    return result;
}
