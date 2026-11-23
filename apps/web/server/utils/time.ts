/**
 * 数据库时间统一使用 Unix 秒级时间戳（INTEGER）。
 * API/DTO 仍输出 ISO-8601，转换只允许发生在领域层边界。
 */

export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** 把已有值（Unix 秒 / 数字字符串 / ISO 字符串）归一化为 Unix 秒；无法解析返回 null */
export function toSeconds(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.floor(value) : null;
    }

    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
        return Math.floor(numeric);
    }

    const parsed = Date.parse(trimmed);

    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/** 数据库秒 → ISO-8601（API 边界） */
export function toIso(value: string | number | null | undefined): string | null {
    const seconds = toSeconds(value);

    return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** 必填时间字段的 ISO 输出；缺失时回退 epoch，避免 DTO 类型被 null 污染 */
export function toIsoRequired(value: string | number | null | undefined): string {
    return toIso(value) ?? new Date(0).toISOString();
}

/** 毫秒截止时间 → Unix 秒，用于 `fetched_at >= cutoff` 之类的查询 */
export function cutoffSeconds(cutoffMs: number): number {
    return Math.floor(cutoffMs / 1000);
}
