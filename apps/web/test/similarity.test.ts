import { describe, expect, it } from 'vitest';
import { groupSimilar, hammingDistance, type PhashItem, type SimilarGroup } from '../server/ingest/similarity';

/** 旧实现：与所有组代表比较，用来验证分桶优化不改变结果 */
function bruteForce(items: PhashItem[], threshold: number): SimilarGroup[] {
    const sorted = [...items]
        .filter(item => /^[0-9a-f]{16}$/iu.test(item.phash))
        .sort((a, b) => a.phash.localeCompare(b.phash) || a.id.localeCompare(b.id));
    const groups: { representativeId: string, representativePhash: string, items: PhashItem[], maxDistance: number }[] = [];

    for (const item of sorted) {
        let target: typeof groups[number] | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const group of groups) {
            const distance = hammingDistance(item.phash, group.representativePhash);

            if (distance <= threshold && distance < bestDistance) {
                target = group;
                bestDistance = distance;
            }
        }

        if (target) {
            target.items.push(item);
            target.maxDistance = Math.max(target.maxDistance, bestDistance);
        }
        else {
            groups.push({
                representativeId: item.id,
                representativePhash: item.phash,
                items: [item],
                maxDistance: 0,
            });
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

function randomSeed(): () => number {
    let state = 0x1234_5678;

    return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

        return state;
    };
}

function flipBits(hex: string, count: number, random: () => number): string {
    const bits = [...hex]
        .map(char => Number.parseInt(char, 16).toString(2).padStart(4, '0'))
        .join('')
        .split('');

    for (let index = 0; index < count; index += 1) {
        const position = random() % 64;

        bits[position] = bits[position] === '1' ? '0' : '1';
    }

    let result = '';

    for (let index = 0; index < 64; index += 4) {
        result += Number.parseInt(bits.slice(index, index + 4).join(''), 2).toString(16);
    }

    return result;
}

describe('similarity grouping', () => {
    it('matches the brute-force result for every threshold', () => {
        const random = randomSeed();
        const items: PhashItem[] = [];

        // 每 8 张图围绕同一个基准 phash，保证 threshold 8 附近能形成分组
        for (let group = 0; group < 60; group += 1) {
            const base = random().toString(16).padStart(16, '0');

            for (let member = 0; member < 8; member += 1) {
                items.push({
                    id: `asset-${group}-${member}`,
                    phash: flipBits(base, random() % 10, random),
                });
            }
        }

        for (const threshold of [0, 1, 4, 8, 12, 32]) {
            expect(groupSimilar(items, threshold)).toEqual(bruteForce(items, threshold));
        }
    });

    it('keeps invalid phashes out of every group', () => {
        const result = groupSimilar([
            { id: 'a', phash: '0000000000000000' },
            { id: 'b', phash: 'not-a-phash' },
            { id: 'c', phash: '0000000000000001' },
        ], 1);

        expect(result).toHaveLength(1);
        expect(result[0]?.items.map(item => item.id)).toEqual(['a', 'c']);
    });

    it('finds matches across every seed segment when threshold exceeds 8', () => {
        // 10 个差异位分散在旧实现的 9 个 7 位分段中，阈值 10 必须仍能命中
        const left = '0000000000000000';
        const right = '8102040810204081';

        expect(hammingDistance(left, right)).toBe(10);
        expect(groupSimilar([
            { id: 'left', phash: left },
            { id: 'right', phash: right },
        ], 10)).toHaveLength(1);
        expect(groupSimilar([
            { id: 'left', phash: left },
            { id: 'right', phash: right },
        ], 9)).toHaveLength(0);
    });
});
