import { THEMABLE_TOKENS } from '#shared/theme';
import { getSettings } from '../settings/setting-store';

const THEMABLE_KEYS = JSON.stringify(THEMABLE_TOKENS);

/**
 * 首屏防闪烁：在 <head> 最前面注入内联脚本。
 * 优先级：localStorage['picturex.theme'] > setting.json（SSR 注入）。
 * 脚本在样式/CSS 生效前设置 data-theme 与白名单覆盖变量。
 */
function buildInlineScript(serverTheme: unknown): string {
    const serialized = JSON.stringify(serverTheme).replace(/</g, '\\u003c');

    return `<script>(function(){try{
var serverTheme=${serialized};
var stored=null;
try{stored=JSON.parse(localStorage.getItem('picturex.theme')||'null')}catch(e){}
var theme=stored&&(stored.preset==='light'||stored.preset==='dark')?stored:serverTheme;
var root=document.documentElement;
root.setAttribute('data-theme',theme.preset);
root.style.colorScheme=theme.preset;
var overrides=theme.overrides||{};
var allowed=${THEMABLE_KEYS};
var unsafe=/[;{}<>]|url\\s*\\(|expression\\s*\\(/i;
var color=/^(#[0-9a-f]{3,8}|rgba?\\([\\d.,%\\s/+-]+\\)|hsla?\\([\\d.,%\\s/+-]+\\))$/i;
var length=/^(?:0|[+-]?\\d+(?:\\.\\d+)?(?:px|rem|em|%|vh|vw|fr))$/i;
for(var key in overrides){var v=overrides[key];if(allowed.indexOf(key)>=0&&typeof v==='string'&&!unsafe.test(v)&&(key.indexOf('color-')===0?color.test(v):length.test(v))){root.style.setProperty('--px-'+key,v)}}
window.__PX_THEME__=theme;
try{document.cookie='picturex.theme='+encodeURIComponent(JSON.stringify(theme))+'; path=/; max-age=31536000; samesite=lax'}catch(e){}
}catch(e){}})();</script>`;
}

export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook('render:html', (html) => {
        const theme = getSettings().theme;

        html.head.unshift(buildInlineScript(theme));
    });
});
