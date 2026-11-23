import { logger } from '../logger';

/**
 * 绑定安全：非回环地址 + 未设访问令牌 = 局域网全盘读取 + 借 ffmpeg 转码执行任意程序。
 *
 * CLI 已在入口拦截，但服务端也可能被直接运行（`node dist/nuxt/server`、桌面外的其它宿主）。
 * 这里在 Nitro 插件层再拦一次，让「不安全绑定」无法在任何一个启动路径上静默放行。
 * 逃生开关 PX_ALLOW_INSECURE_BIND=1 仅用于确实可信的网络。
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackBind(host: string): boolean {
    const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');

    return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith('127.');
}

export default defineNitroPlugin(() => {
    const host = process.env.NITRO_HOST ?? process.env.HOST ?? process.env.NUXT_HOST ?? '127.0.0.1';
    const token = process.env.PX_AUTH_TOKEN?.trim() ?? '';

    if (!isLoopbackBind(host) && token === '' && process.env.PX_ALLOW_INSECURE_BIND !== '1') {
        const message = `拒绝启动：监听地址 ${host} 对局域网/公网开放但未设置 PX_AUTH_TOKEN。`
          + '请设置 PX_AUTH_TOKEN，或改用回环地址；确需无鉴权开放时设 PX_ALLOW_INSECURE_BIND=1。';

        logger.fatal({ host }, message);
        throw new Error(message);
    }
});
