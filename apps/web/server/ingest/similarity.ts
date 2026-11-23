const POPCOUNT = new Uint8Array(256);

for (let index = 0; index < 256; index += 1) {
    POPCOUNT[index] = (index & 1) + (POPCOUNT[index >> 1] ?? 0);
}

export function hammingDistance(left: string, right: string): number {
    if (left.length !== right.length) {
        return Number.POSITIVE_INFINITY;
    }

    let distance = 0;

    for (let index = 0; index < left.length; index += 2) {
        const a = Number.parseInt(left.slice(index, index + 2), 16);
        const b = Number.parseInt(right.slice(index, index + 2), 16);

        if (Number.isNaN(a) || Number.isNaN(b)) {
            return Number.POSITIVE_INFINITY;
        }

        distance += POPCOUNT[a ^ b] ?? 0;
    }

    return distance;
}

export interface PhashItem {
    id: string
    phash: string
}

export interface SimilarGroup {
    /** 组内代表（第一张） */
    representativeId: string
    items: PhashItem[]
    maxDistance: number
}

/**
 * 相似分组：只与已有组的代表比较。
 * 按 pigeonhole 原理把 64 位 pHash 切成 threshold + 1 段（≥9），距离 ≤ threshold
 * 的两个值至少有一段完全相同，因此只需比较命中的代表。
 * 大相册里候选集仍然可能达到数千，距离计算使用预编码的 8 字节查表。
 */
interface WorkingGroup {
    order: number
    representativeId: string
    representativePhash: string
    representativeBytes: Uint8Array
    representativeBinary: string
    items: PhashItem[]
    maxDistance: number
    stamp: number
}

interface EncodedItem extends PhashItem {
    bytes: Uint8Array
    binary: string
}

const PHASH_BITS = 64;

interface Segment {
    start: number
    end: number
}

/** 分成 threshold + 1 段；段长尽量均匀并覆盖全部 64 位 */
function segmentsFor(threshold: number): Segment[] {
    const count = Math.max(1, Math.min(PHASH_BITS, threshold + 1));
    const base = Math.floor(PHASH_BITS / count);
    const extra = PHASH_BITS % count;
    const segments: Segment[] = [];
    let start = 0;

    for (let index = 0; index < count; index += 1) {
        const length = base + (index < extra ? 1 : 0);

        segments.push({ start, end: start + length });
        start += length;
    }

    return segments;
}

function encodeBytes(phash: string): Uint8Array {
    const bytes = new Uint8Array(8);

    for (let index = 0; index < 8; index += 1) {
        bytes[index] = Number.parseInt(phash.slice(index * 2, index * 2 + 2), 16);
    }

    return bytes;
}

function binaryOf(phash: string): string {
    let binary = '';

    for (const char of phash) {
        binary += Number.parseInt(char, 16).toString(2).padStart(4, '0');
    }

    return binary;
}

function hammingBytes(left: Uint8Array, right: Uint8Array): number {
    let distance = 0;

    for (let index = 0; index < 8; index += 1) {
        distance += POPCOUNT[(left[index] ?? 0) ^ (right[index] ?? 0)] ?? 0;
    }

    return distance;
}

function segmentKey(binary: string, segment: Segment): string {
    return binary.slice(segment.start, segment.end);
}

export function groupSimilar(items: PhashItem[], threshold: number): SimilarGroup[] {
    const sorted: EncodedItem[] = [...items]
        .filter(item => /^[0-9a-f]{16}$/iu.test(item.phash))
        .sort((a, b) => (a.phash < b.phash ? -1 : a.phash > b.phash ? 1 : 0)
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(item => ({ ...item, bytes: encodeBytes(item.phash), binary: binaryOf(item.phash) }));

    if (sorted.length < 2) {
        return [];
    }

    if (threshold >= PHASH_BITS) {
        const first = sorted[0]!;
        let maxDistance = 0;

        for (const item of sorted) {
            maxDistance = Math.max(maxDistance, hammingBytes(item.bytes, first.bytes));
        }

        return [{
            representativeId: first.id,
            items: sorted.map(item => ({ id: item.id, phash: item.phash })),
            maxDistance,
        }];
    }

    const segments = segmentsFor(threshold);
    const buckets = Array.from({ length: segments.length }, () => new Map<string, WorkingGroup[]>());
    const groups: WorkingGroup[] = [];
    let stamp = 0;

    for (const item of sorted) {
        stamp += 1;

        const candidates: WorkingGroup[] = [];

        for (let index = 0; index < segments.length; index += 1) {
            const segment = segments[index]!;
            const bucket = buckets[index]?.get(segmentKey(item.binary, segment));

            if (!bucket) {
                continue;
            }

            for (const group of bucket) {
                if (group.stamp !== stamp) {
                    group.stamp = stamp;
                    candidates.push(group);
                }
            }
        }

        let target: WorkingGroup | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const group of candidates) {
            const distance = hammingBytes(item.bytes, group.representativeBytes);

            if (distance <= threshold
              && (distance < bestDistance || (distance === bestDistance && group.order < (target?.order ?? Number.POSITIVE_INFINITY)))) {
                target = group;
                bestDistance = distance;
            }
        }

        if (target) {
            target.items.push(item);
            target.maxDistance = Math.max(target.maxDistance, bestDistance);

            continue;
        }

        const group: WorkingGroup = {
            order: groups.length,
            representativeId: item.id,
            representativePhash: item.phash,
            representativeBytes: item.bytes,
            representativeBinary: item.binary,
            items: [item],
            maxDistance: 0,
            stamp: 0,
        };

        groups.push(group);

        for (let index = 0; index < segments.length; index += 1) {
            const key = segmentKey(item.binary, segments[index]!);
            const bucket = buckets[index]!;
            const list = bucket.get(key);

            if (list) {
                list.push(group);
            }
            else {
                bucket.set(key, [group]);
            }
        }
    }

    return groups
        .filter(group => group.items.length > 1)
        .map(group => ({
            representativeId: group.representativeId,
            items: group.items.map(item => ({ id: item.id, phash: item.phash })),
            maxDistance: group.maxDistance,
        }))
        .sort((a, b) => b.items.length - a.items.length);
}
