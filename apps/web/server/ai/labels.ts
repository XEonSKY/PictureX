/** CLIP 零样本候选标签集：数量适中，覆盖本地相册常见主题 */
export const CANDIDATE_LABELS: readonly string[] = [
    'landscape',
    'portrait',
    'people',
    'animal',
    'pet',
    'food',
    'architecture',
    'vehicle',
    'document',
    'screenshot',
    'artwork',
    'nature',
    'city',
    'night scene',
    'beach',
    'mountain',
    'flower',
    'sky',
    'water',
    'indoor',
];

export const CAPTION_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'with', 'for', 'from',
    'is', 'are', 'was', 'were', 'be', 'being', 'this', 'that', 'these', 'those', 'there',
    'it', 'its', 'his', 'her', 'their', 'some', 'very', 'image', 'photo', 'picture',
]);
