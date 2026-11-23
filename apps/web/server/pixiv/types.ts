/** Pixiv 领域类型：缓存表与 DTO 共用，JSON 字段只在领域层序列化。 */

export interface PixivTag {
    name: string
    translatedName: string | null
}

export interface PixivPageUrls {
    squareMedium: string
    medium: string
    large: string
    original: string
}

export interface PixivPage {
    index: number
    urls: PixivPageUrls
}

export interface PixivUgoiraFrame {
    file: string
    delay: number
}

export interface PixivUgoira {
    zipUrl: string
    frames: PixivUgoiraFrame[]
}

export interface PixivIllust {
    illustId: string
    title: string
    type: string
    caption: string
    userId: string
    userName: string
    userAccount: string
    pageCount: number
    width: number | null
    height: number | null
    xRestrict: number
    sanityLevel: number
    illustAiType: number
    createDate: string | null
    totalView: number
    totalBookmarks: number
    tags: PixivTag[]
    pages: PixivPage[]
    ugoira: PixivUgoira | null
}

export interface PixivLocalPage {
    index: number
    assetId: string
    filename: string
}

export interface PixivIllustContextDto {
    pixiv: true
    illustId: string
    pageIndex: number
    /** 未登录且无缓存时为 null，仍返回本地分P用于展示 */
    illust: PixivIllust | null
    localPages: PixivLocalPage[]
    missingPages: number[]
    authRequired: boolean
    /** Pixiv 已返回 404；不再自动联网，手动刷新可重试 */
    invalid: boolean
    /** 命中缓存但远端刷新失败时为 true */
    stale: boolean
    downloadedPages: number[]
    downloadErrors: number[]
}

export interface PixivNotPixivDto {
    pixiv: false
}

export type AssetPixivContextDto = PixivIllustContextDto | PixivNotPixivDto;

export interface PixivStatusDto {
    configured: boolean
    accountId: string
    accountName: string
    account: string
    premium: boolean
    networkMode: 'direct' | 'proxy'
}
