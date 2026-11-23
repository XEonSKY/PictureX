import { listAlbumSummaries } from '../album/album-store';
import { logger } from '../logger';
import { getSettings } from '../settings/setting-store';

export default defineNitroPlugin(() => {
    const settings = getSettings();
    const missing = listAlbumSummaries(settings).filter(album => album.missing);

    if (missing.length > 0) {
        logger.warn(
            { albums: missing.map(album => ({ id: album.id, name: album.name, dir: album.dir })) },
            'album directories are missing',
        );
    }
});
