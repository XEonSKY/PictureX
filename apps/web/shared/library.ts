/**
 * 全局图库（仅查看器打开过的离散图片）的共享 DTO。
 * 服务端按内容 SHA-256 去重；相册资产只在各自相册库中，不进入这里。
 */

export interface LibraryTagDto {
    id: string
    name: string
    color: string
    /** 关联的散图数量 */
    count: number
}

export interface LibraryMediaDto {
    sha256: string
    kind: string
    mime: string
    filename: string
    size: number
    width: number | null
    height: number | null
    durationMs: number | null
    addedAt: string
    tagIds: string[]
}

export interface LibraryMediaPage {
    data: LibraryMediaDto[]
    total: number
    pagination: {
        limit: number
        nextCursor: string | null
        hasMore: boolean
    }
}
