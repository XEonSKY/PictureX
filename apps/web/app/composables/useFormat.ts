import { useI18n } from 'vue-i18n';

/**
 * 日期 / 数字 / 相对时间 / 文件大小的本地化格式化。
 * 只使用 Intl.*，不引入第三方格式化库。
 */
export function useFormat() {
    const { locale } = useI18n();

    function currentLocale(): string {
        return locale.value || 'zh-CN';
    }

    function formatDate(value: string | number | Date | null | undefined): string {
        if (value === null || value === undefined || value === '') {
            return '—';
        }

        const date = value instanceof Date ? value : new Date(value);

        if (Number.isNaN(date.getTime())) {
            return '—';
        }

        return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(date);
    }

    function formatDateTime(value: string | number | Date | null | undefined): string {
        if (value === null || value === undefined || value === '') {
            return '—';
        }

        const date = value instanceof Date ? value : new Date(value);

        if (Number.isNaN(date.getTime())) {
            return '—';
        }

        return new Intl.DateTimeFormat(currentLocale(), {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(date);
    }

    function formatTime(value: string | number | Date | null | undefined): string {
        if (value === null || value === undefined || value === '') {
            return '—';
        }

        const date = value instanceof Date ? value : new Date(value);

        if (Number.isNaN(date.getTime())) {
            return '—';
        }

        return new Intl.DateTimeFormat(currentLocale(), { timeStyle: 'short' }).format(date);
    }

    function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
        return new Intl.NumberFormat(currentLocale(), options).format(value);
    }

    function formatRelative(value: string | number | Date | null | undefined): string {
        if (value === null || value === undefined || value === '') {
            return '—';
        }

        const date = value instanceof Date ? value : new Date(value);

        if (Number.isNaN(date.getTime())) {
            return '—';
        }

        const formatter = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
        const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
        const ranges: { unit: Intl.RelativeTimeFormatUnit, seconds: number }[] = [
            { unit: 'year', seconds: 60 * 60 * 24 * 365 },
            { unit: 'month', seconds: 60 * 60 * 24 * 30 },
            { unit: 'day', seconds: 60 * 60 * 24 },
            { unit: 'hour', seconds: 60 * 60 },
            { unit: 'minute', seconds: 60 },
            { unit: 'second', seconds: 1 },
        ];

        for (const range of ranges) {
            if (Math.abs(diffSeconds) >= range.seconds || range.unit === 'second') {
                return formatter.format(Math.round(diffSeconds / range.seconds), range.unit);
            }
        }

        return formatter.format(diffSeconds, 'second');
    }

    function formatBytes(value: number): string {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = Math.max(0, value);
        let index = 0;

        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }

        const digits = size >= 100 || index === 0 ? 0 : 1;

        return `${new Intl.NumberFormat(currentLocale(), {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(size)} ${units[index]}`;
    }

    function formatDuration(milliseconds: number): string {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
            return '0:00';
        }

        const totalSeconds = Math.round(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const pad = (input: number) => String(input).padStart(2, '0');

        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
    }

    function formatPercent(ratio: number): string {
        return new Intl.NumberFormat(currentLocale(), {
            style: 'percent',
            maximumFractionDigits: 1,
        }).format(Math.min(1, Math.max(0, ratio)));
    }

    return {
        formatDate,
        formatDateTime,
        formatTime,
        formatNumber,
        formatRelative,
        formatBytes,
        formatDuration,
        formatPercent,
    };
}
