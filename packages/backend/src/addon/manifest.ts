import env from '../config/env';

function catalogExtra() {
    return [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip' }
    ];
}

export function createManifest(idPrefix?: string, catalogName?: string) {
    const baseCatalogName = catalogName || env.ADDON_NAME;

    // Build idPrefixes arrays used both at top-level and per-resource.
    // IMPORTANT: Stremio Android TV (and the Android Mobile beta) have a confirmed bug
    // where, if a resource object has idPrefixes omitted or null, the client silently
    // replaces it with [] — making the addon never get called for stream/meta requests
    // on TV, while mobile still worked because it fell back to the top-level idPrefixes.
    // Fix: always declare stream and meta as explicit resource objects that include
    // types and idPrefixes explicitly.  See: https://github.com/Stremio/stremio-bugs/issues/1469
    const allPrefixes = idPrefix
        ? [`xc${idPrefix}_`, `io${idPrefix}_`, `m3${idPrefix}_`, 'tt']
        : ['xc', 'io', 'm3', 'tt'];

    return {
        id: 'community.nexotv',
        version: '2.0.0',
        name: env.ADDON_NAME,
        description: env.ADDON_DESCRIPTION,

        // Expand every non-catalog resource to the explicit object form so that
        // idPrefixes and types are always present — never undefined/null.
        resources: [
            'catalog',
            {
                name: 'stream',
                types: ['tv', 'movie', 'series'],
                idPrefixes: allPrefixes,
            },
            {
                name: 'meta',
                types: ['tv', 'movie', 'series'],
                idPrefixes: allPrefixes,
            },
        ],

        types: ['tv', 'movie', 'series'],
        catalogs: [
            {
                type: 'tv',
                id: 'iptv_channels',
                name: baseCatalogName,
                extra: catalogExtra(),
                genres: []
            },
            {
                type: 'movie',
                id: 'iptv_movies',
                name: `${baseCatalogName} Movies`,
                extra: catalogExtra(),
                genres: []
            },
            {
                type: 'series',
                id: 'iptv_series',
                name: `${baseCatalogName} Series`,
                extra: catalogExtra(),
                genres: []
            }
        ],
        idPrefixes: allPrefixes,
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        },
        ...(env.ADDON_LOGO_URL ? { logo: env.ADDON_LOGO_URL } : {}),
        ...(env.ADDON_BACKGROUND_URL ? { background: env.ADDON_BACKGROUND_URL } : {}),
    };
}
