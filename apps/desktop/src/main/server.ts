import { utilityProcess } from 'electron';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { logMain, logServer } from './log';

const READY_TIMEOUT_MS = 120_000;
const PROBE_INTERVAL_MS = 300;
const PROBE_TIMEOUT_MS = 1500;

export interface LocalServer {
    readonly url: string;
    /** 一次性访问令牌：主进程写入 cookie，本机其它进程直连端口会 401 */
    readonly token: string;
    stop(): void;
}

interface StartOptions {
    entry: string;
    dataDir: string;
    onExit?: (code: number | null) => void;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(port);
            });
        });
    });
}

function cleanEnv(source: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) {
            env[key] = value;
        }
    }

    return env;
}

function probe(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const request = http.get(url, { timeout: PROBE_TIMEOUT_MS }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });

        request.once('timeout', () => {
            request.destroy();
            resolve(false);
        });
        request.once('error', () => resolve(false));
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startLocalServer(options: StartOptions): Promise<LocalServer> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const token = randomUUID();
    const env = cleanEnv({
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        NITRO_PORT: String(port),
        HOST: '127.0.0.1',
        NITRO_HOST: '127.0.0.1',
        NUXT_DATA_DIR: options.dataDir,
        // 桌面端始终自带令牌：挡住本机其它进程/误访问端口直接调用完整 API
        PX_AUTH_TOKEN: token,
    });

    logMain(`starting local server: ${options.entry} (port ${port}, data ${options.dataDir})`);

    // 入口是 CJS bootstrap：Nitro 产物为 ESM，由它内部动态 import。
    const child = utilityProcess.fork(options.entry, [], {
        env,
        stdio: 'pipe',
        serviceName: 'PictureX Server',
    });

    let exited = false;
    let exitCode: number | null = null;
    let ready = false;
    let intentionalStop = false;

    child.stdout?.on('data', (chunk: Buffer) => logServer('stdout', chunk.toString().trimEnd()));
    child.stderr?.on('data', (chunk: Buffer) => logServer('stderr', chunk.toString().trimEnd()));
    child.once('exit', (code) => {
        exited = true;
        exitCode = code;

        if (ready && !intentionalStop) {
            options.onExit?.(code);
        }

        if (code !== 0) {
            logMain(`local server exited with code ${code}`);
        }
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (exited) {
            throw new Error(`Local server exited before becoming ready (code ${exitCode ?? 'unknown'}).`);
        }

        if (await probe(`${url}/api/v1/health`)) {
            ready = true;
            logMain(`local server ready at ${url}`);

            return {
                url,
                token,
                stop: () => {
                    if (!exited) {
                        intentionalStop = true;
                        child.kill();
                    }
                },
            };
        }

        await delay(PROBE_INTERVAL_MS);
    }

    child.kill();
    throw new Error(`Local server did not become ready within ${READY_TIMEOUT_MS / 1000}s.`);
}
