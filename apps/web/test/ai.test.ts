import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalTagger, type Tagger } from '../server/ai/tagger';
import { parseSettings } from '../server/settings/setting-schema';

const cleanup: (() => Promise<void> | void)[] = [];

function tempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'picturex-ai-'));

    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const path = join(dir, 'image.jpg');

    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    return path;
}

interface ServerOptions {
    failFirst?: boolean
    content?: string
}

function serve(options: ServerOptions = {}): Promise<{ url: string, calls: () => number }> {
    let calls = 0;
    const content = options.content ?? '["beach","ocean","sunset"]';
    const server: Server = createServer((request, response) => {
        calls += 1;
        request.resume();

        if (options.failFirst && calls === 1) {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end('{"error":"temporary"}');

            return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if (!address || typeof address === 'string') {
                throw new Error('failed to bind test server');
            }

            cleanup.push(async () => {
                server.closeAllConnections();
                await new Promise<void>(done => server.close(() => done()));
            });

            resolve({
                url: `http://127.0.0.1:${address.port}/v1`,
                calls: () => calls,
            });
        });
    });
}

function settingsFor(baseUrl: string) {
    return parseSettings({
        ai: {
            external: { enabled: true, baseUrl, apiKey: 'test-key', model: 'test-model' },
        },
    });
}

const fallbackTagger: Tagger = {
    mode: 'zero-shot',
    modelId: 'fallback-model',
    async tag() {
        return {
            mode: 'zero-shot',
            modelId: 'fallback-model',
            labels: [{ name: 'fallback', score: 1 }],
        };
    },
};

afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) {
        await task();
    }
});

describe('external tagger', () => {
    it('parses JSON tags from an OpenAI-compatible endpoint', async () => {
        const server = await serve();
        const tagger = new ExternalTagger(settingsFor(server.url));
        const result = await tagger.tag({ path: tempFile(), mime: 'image/jpeg' });

        expect(result.mode).toBe('external');
        expect(result.labels.map(label => label.name)).toEqual(['beach', 'ocean', 'sunset']);
        expect(server.calls()).toBe(1);
    });

    it('retries once on a 5xx response', async () => {
        const server = await serve({ failFirst: true });
        const tagger = new ExternalTagger(settingsFor(server.url));
        const result = await tagger.tag({ path: tempFile(), mime: 'image/jpeg' });

        expect(result.labels).toHaveLength(3);
        expect(server.calls()).toBe(2);
    });

    it('parses fenced or comma separated content', async () => {
        const server = await serve({ content: '```json\n["city", "night"]\n```' });
        const tagger = new ExternalTagger(settingsFor(server.url));
        const result = await tagger.tag({ path: tempFile(), mime: 'image/jpeg' });

        expect(result.labels.map(label => label.name)).toEqual(['city', 'night']);
    });

    it('falls back to the local tagger when the endpoint keeps failing', async () => {
        const server = await serve({ failFirst: true, content: '' });
        const tagger = new ExternalTagger(settingsFor(server.url), fallbackTagger);
        const result = await tagger.tag({ path: tempFile(), mime: 'image/jpeg' });

        expect(result.mode).toBe('zero-shot');
        expect(result.labels[0]?.name).toBe('fallback');
    });
});
