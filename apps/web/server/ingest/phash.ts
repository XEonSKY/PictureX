import sharp from 'sharp';

/**
 * 感知哈希（pHash）：
 * 32×32 灰度 → 二维 DCT → 取低频 8×8 → 与中位数比较得到 64 bit → 16 位十六进制。
 * DCT 按行/列分离计算（O(n³)），避免 O(n⁴) 的朴素实现。
 */

const SAMPLE_SIZE = 32;
const LOW_SIZE = 8;

function dctMatrix(size: number): Float64Array {
    const matrix = new Float64Array(size * size);

    for (let u = 0; u < size; u += 1) {
        for (let x = 0; x < size; x += 1) {
            matrix[u * size + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
        }
    }

    return matrix;
}

const COS = dctMatrix(SAMPLE_SIZE);

function dct2d(pixels: Float64Array): Float64Array {
    const rows = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
    const result = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);

    for (let y = 0; y < SAMPLE_SIZE; y += 1) {
        for (let u = 0; u < SAMPLE_SIZE; u += 1) {
            let sum = 0;

            for (let x = 0; x < SAMPLE_SIZE; x += 1) {
                sum += (pixels[y * SAMPLE_SIZE + x] ?? 0) * (COS[u * SAMPLE_SIZE + x] ?? 0);
            }

            rows[y * SAMPLE_SIZE + u] = sum;
        }
    }

    for (let u = 0; u < SAMPLE_SIZE; u += 1) {
        for (let v = 0; v < SAMPLE_SIZE; v += 1) {
            let sum = 0;

            for (let y = 0; y < SAMPLE_SIZE; y += 1) {
                sum += (rows[y * SAMPLE_SIZE + u] ?? 0) * (COS[v * SAMPLE_SIZE + y] ?? 0);
            }

            result[v * SAMPLE_SIZE + u] = sum;
        }
    }

    return result;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length === 0) {
        return 0;
    }

    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? 0;
}

export async function computePhash(path: string): Promise<string | null> {
    try {
        const { data } = await sharp(path, { animated: false, density: 192 })
            .rotate()
            .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (data.byteLength < SAMPLE_SIZE * SAMPLE_SIZE) {
            return null;
        }

        const pixels = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);

        for (let index = 0; index < pixels.length; index += 1) {
            pixels[index] = data[index] ?? 0;
        }

        const coefficients = dct2d(pixels);
        const low: number[] = [];

        for (let y = 0; y < LOW_SIZE; y += 1) {
            for (let x = 0; x < LOW_SIZE; x += 1) {
                low.push(coefficients[y * SAMPLE_SIZE + x] ?? 0);
            }
        }

        const threshold = median(low.slice(1));
        let hex = '';

        for (let index = 0; index < low.length; index += 4) {
            let nibble = 0;

            for (let bit = 0; bit < 4; bit += 1) {
                if ((low[index + bit] ?? 0) > threshold) {
                    nibble |= 1 << (3 - bit);
                }
            }

            hex += nibble.toString(16);
        }

        return hex;
    }
    catch {
        return null;
    }
}
