import type { Logger } from 'pino';

/** Hono Context 变量表；中间件注入、handler 读取 */
export interface AppEnv {
    /** Nitro 入口注入真实连接地址，避免直接连接时被伪造的转发头欺骗 */
    Bindings: {
        clientIp?: string
    }
    Variables: {
        logger: Logger
        requestId: string
    }
}
