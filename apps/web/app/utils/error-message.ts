/** 统一把 catch 到的 unknown 转成可展示的字符串，避免每个页面各写一份 messageOf。 */
export function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
}
