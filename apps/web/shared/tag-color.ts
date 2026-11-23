/** 标签自动配色：同一标签名始终得到同一颜色，随机模式从同一调色板抽取。 */
export const TAG_COLOR_PALETTE = [
    '#0A59F7',
    '#00A2AE',
    '#2E7D32',
    '#7B1FA2',
    '#C2185B',
    '#E65100',
    '#5D4037',
    '#455A64',
    '#1565C0',
    '#00838F',
    '#558B2F',
    '#6A1B9A',
    '#AD1457',
    '#EF6C00',
    '#4E342E',
    '#37474F',
] as const;

export function colorFromTagName(name: string): string {
    let hash = 0;

    for (const char of name) {
        hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    }

    return TAG_COLOR_PALETTE[hash % TAG_COLOR_PALETTE.length] ?? TAG_COLOR_PALETTE[0];
}

export function randomTagColor(): string {
    return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)] ?? TAG_COLOR_PALETTE[0];
}
