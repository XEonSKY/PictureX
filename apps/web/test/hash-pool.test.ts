import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../server/utils/hash';
import { sha256FileAccelerated } from '../server/utils/hash-pool';

describe('parallel sha256 pool', () => {
    it('returns the same digest as the single-threaded implementation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'picturex-hash-pool-'));
        const paths = Array.from({ length: 8 }, (_, index) => {
            const path = join(dir, `payload-${index}.bin`);

            writeFileSync(path, `picturex-${index}-`.repeat(20_000));

            return path;
        });

        try {
            const accelerated = await Promise.all(paths.map(path => sha256FileAccelerated(path)));
            const expected = await Promise.all(paths.map(path => sha256File(path)));

            expect(accelerated).toEqual(expected);
            expect(accelerated.every(hash => /^[0-9a-f]{64}$/u.test(hash))).toBe(true);
        }
        finally {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});
