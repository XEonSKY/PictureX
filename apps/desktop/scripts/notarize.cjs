'use strict';
/**
 * electron-builder afterSign：仅在提供 Apple 凭据时执行公证。
 * 签名证书由 electron-builder 的 CSC_LINK / CSC_KEY_PASSWORD 处理。
 */
// electron-builder 以 CJS 加载 afterSign，这里必须使用 require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { notarize } = require('@electron/notarize');

module.exports = async function notarizeApp(context) {
    const { electronPlatformName, appOutDir, packager } = context;

    if (electronPlatformName !== 'darwin') {
        return;
    }

    const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;

    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
        process.stdout.write('[notarize] 跳过（缺少 Apple 凭据）\n');

        return;
    }

    const appPath = `${appOutDir}/${packager.appInfo.productFilename}.app`;

    await notarize({
        appBundleId: 'com.xeonsky.picturex',
        appPath,
        appleId: APPLE_ID,
        appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
        teamId: APPLE_TEAM_ID,
    });
    process.stdout.write(`[notarize] 完成: ${appPath}\n`);
};
