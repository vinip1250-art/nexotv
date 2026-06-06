import crypto from 'crypto';
import LRUCache from '../utils/lruCache';
import * as sqliteCache from '../utils/sqliteCache';
import { makeLogger } from '../utils/logger';
import { parseEPG, getCurrentProgram, getUpcomingPrograms } from '../parsers/epgParser';
import { inferStreamTechnicalInfo } from '../utils/iptvContent';
import env from '../config/env';
import * as xtreamProvider from '../providers/xtreamProvider';
import * as iptvOrgProvider from '../providers/iptvOrgProvider';
import * as m3uProvider from '../providers/m3uProvider';

const CACHE_ENABLED = env.CACHE_ENABLED;
const CACHE_TTL_MS = env.CACHE_TTL_MS;
const MAX_CACHE_ENTRIES = env.MAX_CACHE_ENTRIES;
const CHANNEL_CACHE_SCHEMA_VERSION = 2;

if (CACHE_ENABLED) {
    sqliteCache.init(env.SQLITE_PATH);
}

export const buildPromiseCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const externalMetaCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });

const PROVIDER_MAP: Record<string, { fetchData: (addon: any) => Promise<void> }> = {
    'xtream': xtreamProvider,
    'iptv-org': iptvOrgProvider,
    'm3u': m3uProvider,
};

const CATALOGS_BY_TYPE: Record<string, string[]> = {
    tv: ['iptv_channels', 'iptv_org'],
    movie: ['iptv_movies'],
    series: ['iptv_series'],
};

const ALL_GENRE_LABEL_BY_TYPE: Record<string, string> = {
    tv: 'All Channels',
    movie: 'All Movies',
    series: 'All Series',
};

const FALLBACK_GENRE_BY_TYPE: Record<string, string> = {
    tv: 'Live TV',
    movie: 'IPTV Movies',
    series: 'IPTV Series',
};

function getItemType(item: any) {
    return item?.type || 'tv';
}

function getItemGenre(item: any, fallback?: string) {
    return item?.category || item?.attributes?.['group-title'] || fallback || FALLBACK_GENRE_BY_TYPE[getItemType(item)] || 'IPTV';
}

function hashId(value: string) {
    return crypto.createHash('md5').update(value).digest('hex').slice(0, 12);
}

function toPositiveInt(value: any) {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function episodeCode(item: any) {
    const season = toPositiveInt(item?.season);
    const episode = toPositiveInt(item?.episode);
    if (!season || !episode) return '';
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function sortEpisodes(a: any, b: any) {
    const seasonA = toPositiveInt(a.season) ?? Number.MAX_SAFE_INTEGER;
    const seasonB = toPositiveInt(b.season) ?? Number.MAX_SAFE_INTEGER;
    if (seasonA !== seasonB) return seasonA - seasonB;
    const episodeA = toPositiveInt(a.episode) ?? Number.MAX_SAFE_INTEGER;
    const episodeB = toPositiveInt(b.episode) ?? Number.MAX_SAFE_INTEGER;
    if (episodeA !== episodeB) return episodeA - episodeB;
    return String(a.name || '').localeCompare(String(b.name || ''));
}

function normalizeMatchTitle(value?: string | null) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeResolutionLabel(value?: string | null) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return undefined;
    if (['4k', 'uhd', '2160p'].includes(raw)) return '4K';
    if (['fhd', '1080p'].includes(raw)) return 'FHD';
    if (['hd', '720p', '576p', '540p'].includes(raw)) return 'HD';
    if (['sd', '480p', '360p'].includes(raw)) return 'SD';
    return String(value).trim().toUpperCase();
}

function getSearchValues(item: any) {
    return [
        item?.name,
        item?.originalName,
        item?.seriesName,
        item?.episodeTitle,
        item?.category,
        item?.releaseInfo,
        item?.year ? String(item.year) : null,
        item?.quality,
        item?.attributes?.['tvg-name'],
        item?.attributes?.['tvg-id'],
        item?.attributes?.['group-title'],
    ].filter(Boolean).map((value: any) => String(value));
}

function matchesNormalizedSearchValue(candidate: string, query: string) {
    const normalizedCandidate = normalizeMatchTitle(candidate);
    const normalizedQuery = normalizeMatchTitle(query);
    if (!normalizedCandidate || !normalizedQuery) return false;
    if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) return true;

    const queryTokens = normalizedQuery
        .split(' ')
        .filter((token) => token.length >= 3 && !/^(19|20)\d{2}$/.test(token));
    if (!queryTokens.length) return false;

    return queryTokens.every((token) => normalizedCandidate.includes(token));
}

function titleMatches(candidate?: string | null, target?: string | null) {
    const candidateTitle = String(candidate || '');
    const targetTitle = String(target || '');
    if (!candidateTitle || !targetTitle) return false;
    if (matchesNormalizedSearchValue(candidateTitle, targetTitle)) return true;
    if (Math.min(candidateTitle.length, targetTitle.length) < 6) return false;
    return normalizeMatchTitle(candidateTitle).includes(normalizeMatchTitle(targetTitle));
}

function parseExternalStremioId(id: string) {
    const parts = String(id || '').split(':');
    const imdbId = parts[0];
    if (!/^tt\d+$/i.test(imdbId)) return null;
    return {
        imdbId,
        season: toPositiveInt(parts[1]),
        episode: toPositiveInt(parts[2]),
    };
}

async function fetchJsonWithTimeout(url: string, ms: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return null;
        return await resp.json();
    } finally {
        clearTimeout(timer);
    }
}

export interface AddonConfig {
    provider?: string;
    xtreamUrl?: string;
    xtreamUsername?: string;
    xtreamPassword?: string;
    m3uUrl?: string;
    epgUrl?: string;
    enableEpg?: boolean;
    epgOffsetHours?: number | string;
    reformatLogos?: boolean;
    iptvOrgCountry?: string;
    iptvOrgCategory?: string;
    instanceId?: string;
    catalogName?: string;
    globalUserAgent?: string;
}

function stableStringify(obj: any) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

export function createCacheKey(config: AddonConfig) {
    const provider = config.provider || 'xtream';
    let minimal: any;
    if (provider === 'iptv-org') {
        minimal = {
            provider,
            iptvOrgCountry: config.iptvOrgCountry || null,
            iptvOrgCategory: config.iptvOrgCategory || null,
        };
    } else if (provider === 'm3u') {
        minimal = {
            provider,
            m3uUrl: config.m3uUrl || null,
            enableEpg: !!config.enableEpg,
            epgUrl: config.epgUrl || null,
            epgOffsetHours: config.epgOffsetHours,
            reformatLogos: !!config.reformatLogos,
            globalUserAgent: config.globalUserAgent || null,
        };
    } else {
        minimal = {
            provider: 'xtream',
            epgUrl: config.epgUrl,
            enableEpg: !!config.enableEpg,
            xtreamUrl: config.xtreamUrl,
            xtreamUsername: config.xtreamUsername,
            epgOffsetHours: config.epgOffsetHours,
            reformatLogos: !!config.reformatLogos
        };
    }
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

export class M3UEPGAddon {
    providerName: string;
    config: AddonConfig;
    manifestRef: any;
    cacheKey: string;
    idPrefix: string;
    updateInterval: number;
    channels: any[];
    channelMap: Map<string, any>;
    epgData: Record<string, any[]>;
    lastUpdate: number;
    m3uEtag: string | null;
    m3uLastModified: string | null;
    iptvOrgEtag: string | null;
    xtreamEtag: string | null;
    lastEpgUpdate: number | null;
    _evictTimer: any;
    private _updateTimer: ReturnType<typeof setInterval> | null;
    _loadPromise: any;
    firstCatalogRefreshDone: boolean;
    firstCatalogRefreshPromise: any;
    private _consecutiveRefreshFailures = 0;
    private _refreshFailedAt: number | null = null;
    private _timerConsecutiveFailures = 0;
    private _timerPausedUntil: number | null = null;
    cacheTtl: number;
    log: ReturnType<typeof makeLogger>;

    constructor(config: AddonConfig = {}, manifestRef?: any) {
        this.providerName = config.provider || 'xtream';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.idPrefix = this.cacheKey.slice(0, 8);
        this.updateInterval = env.UPDATE_INTERVAL_MS;
        this.channels = [];
        this.channelMap = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.m3uEtag = null;
        this.m3uLastModified = null;
        this.iptvOrgEtag = null;
        this.xtreamEtag = null;
        this.lastEpgUpdate = null;
        this._evictTimer = null;
        this._updateTimer = null;
        this._loadPromise = null;
        this.firstCatalogRefreshDone = false;
        this.firstCatalogRefreshPromise = null;
        const TTL_MAP: Record<string, number> = {
            'iptv-org': env.IPTV_ORG_CACHE_TTL_MS,
            'm3u': env.M3U_CACHE_TTL_MS,
        };
        this.cacheTtl = TTL_MAP[this.providerName] ?? CACHE_TTL_MS;
        this.log = makeLogger();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours as number))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours as number) > 48)
            this.config.epgOffsetHours = 0;

        if (this.providerName === 'iptv-org' || this.providerName === 'm3u') {
            this.config.reformatLogos = true;
        }

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours
        });
    }

    async saveChannelsToCache() {
        if (!CACHE_ENABLED) return;
        await sqliteCache.setRaw('addon:channels:' + this.cacheKey, {
            schemaVersion: CHANNEL_CACHE_SCHEMA_VERSION,
            channels: this.channels,
            lastUpdate: this.lastUpdate,
            m3uEtag: this.m3uEtag ?? null,
            m3uLastModified: this.m3uLastModified ?? null,
            iptvOrgEtag: this.iptvOrgEtag ?? null,
            xtreamEtag: this.xtreamEtag ?? null,
            lastEpgUpdate: this.lastEpgUpdate ?? null,
        }, this.cacheTtl);
        this.log.debug('Channels saved to cache', { count: this.channels.length });
    }

    async loadChannelsFromCache() {
        if (!CACHE_ENABLED) return;
        const cached = await sqliteCache.getRaw('addon:channels:' + this.cacheKey);
        if (cached) {
            if (cached.schemaVersion !== CHANNEL_CACHE_SCHEMA_VERSION) {
                await sqliteCache.del('addon:channels:' + this.cacheKey);
                this.log.debug('Ignoring stale channel cache schema', {
                    expected: CHANNEL_CACHE_SCHEMA_VERSION,
                    actual: cached.schemaVersion ?? null,
                });
                return;
            }
            this.channels = cached.channels || [];
            this.channelMap = new Map(this.channels.map(c => [c.id, c]));
            this.lastUpdate = cached.lastUpdate || 0;
            this.m3uEtag = cached.m3uEtag ?? null;
            this.m3uLastModified = cached.m3uLastModified ?? null;
            this.iptvOrgEtag = cached.iptvOrgEtag ?? null;
            this.xtreamEtag = cached.xtreamEtag ?? null;
            this.lastEpgUpdate = cached.lastEpgUpdate ?? null;
            this.log.debug('Channels loaded from cache', { count: this.channels.length });
        }
    }

    async saveEpgToCache() {
        if (!CACHE_ENABLED) return;
        if (!this.epgData || Object.keys(this.epgData).length === 0) return;
        await sqliteCache.set('addon:epg:' + this.cacheKey, { epgData: this.epgData }, this.cacheTtl);
        this.log.debug('EPG saved to cache', { channels: Object.keys(this.epgData).length });
    }

    async loadEpgFromCache() {
        if (!CACHE_ENABLED) return;
        const cached = await sqliteCache.get('addon:epg:' + this.cacheKey);
        if (cached) {
            this.epgData = cached.epgData || {};
            this.log.debug('EPG loaded from cache', { channels: Object.keys(this.epgData).length });
        }
    }

    async ensureEpgLoaded() {
        if (this.epgData && Object.keys(this.epgData).length > 0) return;
        if (!CACHE_ENABLED) return;
        await this.loadEpgFromCache();
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;

        const stats: Record<string, number> = {};
        for (const type of Object.keys(CATALOGS_BY_TYPE)) {
            const catalogIds = CATALOGS_BY_TYPE[type];
            const items = this.getItemsByType(type);
            const groups = [
                ...new Set(
                    items
                        .map((c: any) => getItemGenre(c, FALLBACK_GENRE_BY_TYPE[type]))
                        .filter(Boolean)
                        .map((s: string) => s.trim())
                )
            ].sort((a: any, b: any) => a.localeCompare(b));
            const allLabel = ALL_GENRE_LABEL_BY_TYPE[type];
            if (!groups.includes(allLabel)) groups.unshift(allLabel);

            for (const catalogId of catalogIds) {
                const catalog = this.manifestRef.catalogs.find((c: any) => c.id === catalogId);
                if (!catalog) continue;
                catalog.genres = groups;

                const genreExtra = catalog.extra.find((e: any) => e.name === 'genre');
                if (genreExtra) {
                    genreExtra.options = groups;
                }
                stats[catalogId] = groups.length;
            }
        }

        this.log.debug('Catalog genres built', stats);
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if (this.channels.length && now - this.lastUpdate < env.MIN_UPDATE_INTERVAL_MS) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        try {
            const start = Date.now();
            const providerModule = PROVIDER_MAP[this.providerName];
            if (!providerModule) throw new Error(`Unknown provider: ${this.providerName}`);
            const epgUpdateTimeBefore = this.lastEpgUpdate;
            await providerModule.fetchData(this);
            this.channelMap = new Map(this.channels.map(c => [c.id, c]));
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED && this.channels.length > 0) {
                await this.saveChannelsToCache();
                if (this.lastEpgUpdate !== epgUpdateTimeBefore) {
                    await this.saveEpgToCache();
                }
            }
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                ms: Date.now() - start
            });
        } catch (e: any) {
            this.log.error('[UPDATE] Failed:', e.message);
            throw e;
        }
    }

    private _getRefreshCooldownMs(): number {
        if (this._consecutiveRefreshFailures <= 0) return 0;
        if (this._consecutiveRefreshFailures === 1) return 60_000;      // 1 min
        if (this._consecutiveRefreshFailures === 2) return 5 * 60_000;  // 5 min
        return 30 * 60_000;                                              // 30 min
    }

    async refreshOnFirstCatalogRequest() {
        // Exponential backoff: don't hammer a failing provider
        if (this._refreshFailedAt !== null) {
            const cooldown = this._getRefreshCooldownMs();
            if (Date.now() - this._refreshFailedAt < cooldown) return;
        }

        if (this.firstCatalogRefreshDone) return;
        if (this.firstCatalogRefreshPromise) {
            await this.firstCatalogRefreshPromise;
            return;
        }

        const JUST_FETCHED_MS = 2 * 60 * 1000;
        if (this.lastUpdate && (Date.now() - this.lastUpdate < JUST_FETCHED_MS)) {
            this.firstCatalogRefreshDone = true;
            return;
        }

        this.firstCatalogRefreshPromise = (async () => {
            // Reset ETags so the forced re-fetch is unconditional (not a 304).
            // Without this, channels evicted from RAM + a cached ETag would cause
            // fetchData to get a 304, save 0 channels, and wipe the valid cache.
            this.m3uEtag = null;
            this.m3uLastModified = null;
            this.iptvOrgEtag = null;
            this.xtreamEtag = null;
            if (CACHE_ENABLED) {
                await sqliteCache.del('addon:channels:' + this.cacheKey);
                await sqliteCache.del('addon:epg:' + this.cacheKey);
            }
            await this.updateData(true);
            this.firstCatalogRefreshDone = true;
            this.log.debug('Bootstrap catalog refresh completed', {
                cacheKey: this.cacheKey,
                channels: this.channels.length
            });
        })();

        try {
            await this.firstCatalogRefreshPromise;
            this._consecutiveRefreshFailures = 0;  // reset on success
            this._refreshFailedAt = null;
        } catch (e) {
            this._consecutiveRefreshFailures++;
            this._refreshFailedAt = Date.now();
            throw e;
        } finally {
            this.firstCatalogRefreshPromise = null;
        }
    }

    private getItemsByType(type = 'tv') {
        if (type === 'series') {
            const xtreamSeries = this.channels.filter((item: any) => getItemType(item) === 'series' && item.xtreamSeriesId);
            return [...xtreamSeries, ...this.buildSeriesCatalogItems()];
        }
        return this.channels.filter((item: any) => getItemType(item) === type);
    }

    buildSeriesCatalogItems() {
        const groups = new Map<string, any>();

        for (const episodeItem of this.channels.filter((item: any) => getItemType(item) === 'series' && !item.xtreamSeriesId && !item.xtreamParentSeriesId)) {
            const seriesName = String(episodeItem.seriesName || episodeItem.name || episodeItem.originalName || 'Unknown').trim();
            const category = getItemGenre(episodeItem, FALLBACK_GENRE_BY_TYPE.series);
            const key = `${seriesName.toLowerCase()}|${String(category).toLowerCase()}`;
            let group = groups.get(key);

            if (!group) {
                group = {
                    id: `m3${this.idPrefix}_series_${hashId(key)}`,
                    type: 'series',
                    name: seriesName,
                    category,
                    logo: episodeItem.logo || '',
                    attributes: {
                        'tvg-logo': episodeItem.logo || '',
                        'group-title': category,
                    },
                    episodes: [],
                };
                groups.set(key, group);
            }

            group.episodes.push(episodeItem);
            if (!group.logo && episodeItem.logo) {
                group.logo = episodeItem.logo;
                group.attributes['tvg-logo'] = episodeItem.logo;
            }
        }

        return Array.from(groups.values()).map((group: any) => {
            const episodes =
