#!/usr/bin/env node
/**
 * 从 apps/web/app/assets/logo/picturex-mark.svg 生成多尺寸 PNG 与 favicon。
 * Logo 全部为手写路径（无 <text>），sharp 渲染 SVG 不依赖系统字体。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'apps', 'web', 'app', 'assets', 'logo', 'picturex-mark.svg');
const PUBLIC_LOGO = join(ROOT, 'apps', 'web', 'public', 'logo');
const PUBLIC_ROOT = join(ROOT, 'apps', 'web', 'public');
const SIZES = [16, 32, 48, 64, 128, 180, 192, 512];

const svg = readFileSync(SOURCE);

mkdirSync(PUBLIC_LOGO, { recursive: true });

copyFileSync(SOURCE, join(PUBLIC_ROOT, 'favicon.svg'));
writeFileSync(join(PUBLIC_LOGO, 'picturex-mark.svg'), svg);

for (const size of SIZES) {
    await sharp(svg, { density: 384 })
        .resize(size, size, { fit: 'contain' })
        .png()
        .toFile(join(PUBLIC_LOGO, `picturex-${size}.png`));
}

copyFileSync(join(PUBLIC_LOGO, 'picturex-32.png'), join(PUBLIC_ROOT, 'favicon-32.png'));
copyFileSync(join(PUBLIC_LOGO, 'picturex-180.png'), join(PUBLIC_ROOT, 'apple-touch-icon.png'));

process.stdout.write(`Logo 已生成：${SIZES.map(size => `${size}px`).join(', ')} + favicon.svg\n`);
