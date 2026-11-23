import { pino, stdTimeFunctions, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * 敏感字段脱敏路径。
 * Pino 的 redact 使用点号路径，`*` 匹配一层通配；日志中不得出现这些字段的原文。
 */
export const REDACT_PATHS = [
    'authorization',
    'cookie',
    'password',
    'token',
    'secret',
    'apiKey',
    'apikey',
    'Authorization',
    'Cookie',
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    '*.authorization',
    '*.cookie',
    '*.password',
    '*.token',
    '*.secret',
    '*.apiKey',
    '*.*.apiKey',
    '*.*.authorization',
    '*.*.cookie',
    '*.*.password',
    '*.*.token',
    '*.*.secret',
];

const CENSOR = '[REDACTED]';

interface CreateLoggerOptions {
    level?: string
    /** 强制覆盖 pino-pretty；默认仅开发环境开启 */
    pretty?: boolean
    /** 指定输出流（测试用）；与 transport 互斥 */
    destination?: DestinationStream
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

    const config: LoggerOptions = {
        level: options.level ?? process.env.LOG_LEVEL ?? (isProduction ? 'info' : isTest ? 'silent' : 'debug'),
        base: { service: 'picturex' },
        timestamp: stdTimeFunctions.isoTime,
        redact: {
            paths: REDACT_PATHS,
            censor: CENSOR,
        },
    };

    if (options.destination) {
        return pino(config, options.destination);
    }

    // 开发环境用 pino-pretty 便于阅读；生产环境保持结构化 JSON（便于聚合与检索）
    const pretty = options.pretty ?? (!isProduction && !isTest);

    if (pretty) {
        config.transport = {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                singleLine: false,
            },
        };
    }

    return pino(config);
}

/** 进程级根 logger；请求作用域 logger 见 server/hono/middleware/logger.ts */
export const logger: Logger = createLogger();
