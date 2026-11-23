export type AssetKind = 'image' | 'gif' | 'dynamic' | 'svg' | 'video';

export interface ExtractedMetadata {
    mime: string
    kind: AssetKind
    width: number | null
    height: number | null
    durationMs: number | null
    takenAt: string | null
    meta: Record<string, unknown>
    /** HEIC/RAW 等浏览器不能直接解码的格式，附一份 JPEG 预览 */
    preview?: Buffer
}
