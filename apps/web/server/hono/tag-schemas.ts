import { z } from 'zod';

/** 相册标签与全局标签共用的请求校验；名称上限统一 120 字符 */

export const tagColorSchema = z
    .string()
    .trim()
    .max(32)
    .regex(/^$|^#?[0-9a-fA-F]{3,8}$/u, 'color must be a hex value');

export const tagNameSchema = z.string().trim().min(1).max(120);

export const tagCreateSchema = z.object({
    name: tagNameSchema,
    color: tagColorSchema.optional(),
});

export const tagPatchSchema = z.object({
    name: tagNameSchema.optional(),
    color: tagColorSchema.optional(),
});

export const tagImportSchema = z.object({
    tags: z.array(z.object({
        name: tagNameSchema,
        color: tagColorSchema.optional(),
    })).min(1).max(500),
});

export const tagIdsSchema = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export const tagMergeSchema = z.object({
    sourceIds: z.array(z.string().min(1).max(64)).min(1).max(500),
    targetId: z.string().min(1).max(64),
});

export const tagRecolorSchema = z.object({
    mode: z.enum(['auto', 'random']),
    onlyEmpty: z.boolean().default(true),
});

export const tagDeleteAllSchema = z.object({
    confirm: z.literal(true),
});
