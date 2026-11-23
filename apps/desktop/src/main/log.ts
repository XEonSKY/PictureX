import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let cachedDir: string | null = null;

function logDir(): string {
    if (cachedDir === null) {
        cachedDir = path.join(app.getPath('userData'), 'logs');
        mkdirSync(cachedDir, { recursive: true });
    }

    return cachedDir;
}

export function logPath(name: string): string {
    return path.join(logDir(), name);
}

function write(name: string, line: string): void {
    const file = logPath(name);

    try {
        if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
            renameSync(file, `${file}.1`);
        }

        appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // 日志本身不能影响启动或退出
    }
}

export function logMain(message: string): void {
    write('desktop.log', message);
    console.log(`[desktop] ${message}`);
}

export function logServer(source: 'stdout' | 'stderr', message: string): void {
    write('server.log', `${source}: ${message}`);

    const stream = source === 'stderr' ? process.stderr : process.stdout;
    stream.write(`[server:${source}] ${message}\n`);
}
