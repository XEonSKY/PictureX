/** 标签主数据（相册 tag.db / 全局 tag.db 共用）。API 时间仍为 ISO-8601，数据库存 Unix 秒。 */

export interface TagRecord {
    id: string
    name: string
    color: string
    createdAt: string
}

/** 旧 tag.json 结构；source 仅用于迁移时丢弃历史 Pixiv 标签 */
export interface TagFile {
    schemaVersion: number
    tags: Array<TagRecord & { source?: string }>
}
