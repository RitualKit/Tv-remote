// App shortcut buttons: a built-in catalog of Samsung Tizen app IDs, plus apps the user adds by
// name + ID. Pure TypeScript (no React / storage), so it is unit-tested in Node.
//
// IDs come from community lists (see APP_CATALOG comment). They differ between model years and
// regions, so most apps list several; the first one that the TV reports as installed is moved to
// the front when the user checks an app in the editor.

export interface TvApp {
  /** Stable identity: catalog key, or `custom:<id>` for user-added apps. */
  key: string;
  name: string;
  /** Tried in order when launching. */
  ids: string[];
  color: string;
  custom?: boolean;
}

// Sources (cross-checked; none name a Frame model, so treat as best effort):
//  - xchwarze/samsung-tv-ws-api APPLICATIONS.md (community list, also tavicu/homebridge-samsung-tizen)
//  - ollo69/ha-samsungtv-smart docs/App_list.md
//  - user reports in tavicu/homebridge-samsung-tizen#26 and Ape/samsungctl#75 (2018–2025)
// For 2020+ TVs the newer (usually larger) numeric ID tends to be right, so it is listed first;
// older numeric IDs and alphanumeric "xxxxxxxxxx.Name" / "org.tizen.*" forms follow as fallbacks.
export const APP_CATALOG: TvApp[] = [
  { key: 'netflix', name: 'Netflix', ids: ['3201907018807', '11101200001', 'org.tizen.netflix-app'], color: '#E50914' },
  { key: 'youtube', name: 'YouTube', ids: ['111299001912'], color: '#FF0033' },
  { key: 'prime-video', name: 'Prime Video', ids: ['3201910019365', '3201512006785', 'org.tizen.ignition'], color: '#00A8E1' },
  { key: 'disney-plus', name: 'Disney+', ids: ['3202204027038', '3202009021709', '3201901017640', 'MCmYXNxgcu.DisneyPlus'], color: '#113CCF' },
  { key: 'apple-tv', name: 'Apple TV', ids: ['3201807016597', 'com.samsung.tv.ariavideo'], color: '#3A3A40' },
  { key: 'max', name: 'Max', ids: ['3202301029760', '3201601007230'], color: '#002BE7' },
  { key: 'hulu', name: 'Hulu', ids: ['3201601007625'], color: '#1CE783' },
  { key: 'paramount-plus', name: 'Paramount+', ids: ['3202110025305', '3201710014981'], color: '#0064FF' },
  { key: 'peacock', name: 'Peacock', ids: ['3202006020991'], color: '#5A5A64' },
  { key: 'youtube-tv', name: 'YouTube TV', ids: ['3201707014489'], color: '#CC0000' },
  { key: 'plex', name: 'Plex', ids: ['3201512006963', 'kIciSQlYEM.plex'], color: '#C98A00' },
  { key: 'jellyfin', name: 'Jellyfin', ids: ['AprZAARz4r.Jellyfin'], color: '#7B4FD0' },
  { key: 'emby', name: 'Emby', ids: ['3201606009872'], color: '#3A9E3A' },
  { key: 'twitch', name: 'Twitch', ids: ['3202203026841'], color: '#9146FF' },
  { key: 'pluto-tv', name: 'Pluto TV', ids: ['3201808016802'], color: '#2D2D9F' },
  { key: 'tubi', name: 'Tubi', ids: ['3201504001965'], color: '#7408FF' },
  { key: 'rakuten-tv', name: 'Rakuten TV', ids: ['3201511006428'], color: '#BF0000' },
  { key: 'dazn', name: 'DAZN', ids: ['3201806016390'], color: '#2A2A2E' },
  { key: 'bbc-iplayer', name: 'BBC iPlayer', ids: ['3201601007670'], color: '#E5007E' },
  { key: 'now', name: 'NOW', ids: ['3201603008746', '3202011022131'], color: '#00A3A6' },
  { key: 'canal-plus', name: 'Canal+', ids: ['3201606009910'], color: '#2B2B30' },
  { key: 'viaplay', name: 'Viaplay', ids: ['11111300404'], color: '#C4003B' },
  { key: 'vimeo', name: 'Vimeo', ids: ['JtPoChZbf4.Vimeo'], color: '#1AB7EA' },
  { key: 'spotify', name: 'Spotify', ids: ['3201606009684', 'rJeHak5zRg.Spotify'], color: '#1DB954' },
  { key: 'apple-music', name: 'Apple Music', ids: ['3201908019041'], color: '#FA2D48' },
  { key: 'amazon-music', name: 'Amazon Music', ids: ['3201710014874'], color: '#25D1DA' },
  { key: 'deezer', name: 'Deezer', ids: ['3201608010191'], color: '#A238FF' },
  { key: 'tidal', name: 'Tidal', ids: ['3201805016367'], color: '#33333A' },
  { key: 'xbox', name: 'Xbox', ids: ['3202203026799'], color: '#107C10' },
  { key: 'steam-link', name: 'Steam Link', ids: ['3201702011851'], color: '#1B2838' },
  { key: 'browser', name: 'Internet', ids: ['3202010022079', 'org.tizen.browser', '3201907018784'], color: '#3A6EE8' },
  { key: 'smartthings', name: 'SmartThings', ids: ['3201910019378', '3201710015016'], color: '#15BFFF' },
  { key: 'gallery', name: 'Gallery', ids: ['3201710015037'], color: '#5B5BD6' },
];

export const DEFAULT_APP_KEYS = ['netflix', 'youtube', 'prime-video', 'disney-plus'];

const CUSTOM_COLORS = ['#4F8CFF', '#8E5CFF', '#FF7A45', '#14B8A6', '#E8B400', '#EC4899', '#64748B'];

export function findCatalogApp(key: string): TvApp | undefined {
  return APP_CATALOG.find((a) => a.key === key);
}

export function defaultApps(): TvApp[] {
  return DEFAULT_APP_KEYS.map((k) => findCatalogApp(k)!).map(cloneApp);
}

/** Samsung app IDs are digits (3201907018807) or `xxxxxxxxxx.Name` (rJeHak5zRg.Spotify). */
export function isValidAppId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(id.trim());
}

export function makeCustomApp(name: string, id: string): TvApp {
  const cleanId = id.trim();
  let h = 0;
  for (const ch of cleanId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    key: `custom:${cleanId}`,
    name: name.trim() || cleanId,
    ids: [cleanId],
    color: CUSTOM_COLORS[h % CUSTOM_COLORS.length],
    custom: true,
  };
}

/** True if `app` (by key or any of its IDs) is already among `list`. */
export function hasApp(list: TvApp[], app: TvApp): boolean {
  return list.some((a) => a.key === app.key || a.ids.some((id) => app.ids.includes(id)));
}

export function addApp(list: TvApp[], app: TvApp): TvApp[] {
  return hasApp(list, app) ? list : [...list, cloneApp(app)];
}

export function removeApp(list: TvApp[], key: string): TvApp[] {
  return list.filter((a) => a.key !== key);
}

/** Move the app at `index` by `delta` (−1 = left/up, +1 = right/down), clamped. */
export function moveApp(list: TvApp[], index: number, delta: number): TvApp[] {
  const to = Math.max(0, Math.min(list.length - 1, index + delta));
  if (to === index || index < 0 || index >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

/** Put the ID the TV confirmed first, so launches use it directly. */
export function preferId(app: TvApp, id: string): TvApp {
  if (!app.ids.includes(id) || app.ids[0] === id) return app;
  return { ...app, ids: [id, ...app.ids.filter((x) => x !== id)] };
}

/**
 * Rebuild the saved list from storage. Returns null (= use defaults) when nothing valid is saved.
 * Catalog apps take the current catalog's name/colour, keep the saved ID order (it may reflect a
 * check against the user's TV) and gain any IDs added to the catalog since.
 */
export function restoreApps(raw: unknown): TvApp[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TvApp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { key, name, ids, color } = item as Record<string, unknown>;
    if (typeof key !== 'string') continue;
    const savedIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && isValidAppId(x)) : [];
    const catalog = findCatalogApp(key);
    let app: TvApp | null = null;
    if (catalog) {
      const merged = [...savedIds.filter((x) => catalog.ids.includes(x)), ...catalog.ids.filter((x) => !savedIds.includes(x))];
      app = { ...catalog, ids: merged };
    } else if (key.startsWith('custom:') && savedIds.length > 0) {
      app = {
        key,
        name: typeof name === 'string' && name.trim() ? name.trim() : savedIds[0],
        ids: savedIds,
        color: typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : CUSTOM_COLORS[0],
        custom: true,
      };
    }
    if (app && !hasApp(out, app)) out.push(app);
  }
  return out;
}

export interface InstalledApp {
  id: string;
  name: string;
}

/**
 * Parse the TV's reply to `ed.installedApp.get` (frame.data). The list is at `data.data`, items
 * look like `{ appId, name, app_type, icon }`. Not every TV answers this request.
 */
export function parseInstalledApps(data: unknown): InstalledApp[] {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const out: InstalledApp[] = [];
  for (const item of list) {
    const id = typeof item?.appId === 'string' ? item.appId.trim() : '';
    if (!isValidAppId(id) || out.some((a) => a.id === id)) continue;
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : id;
    out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turn an app the TV reported into a button: the catalog entry if we know it, else a custom app. */
export function buttonForInstalledApp(app: InstalledApp): TvApp {
  const known = APP_CATALOG.find((a) => a.ids.includes(app.id));
  return known ? preferId(cloneApp(known), app.id) : makeCustomApp(app.name, app.id);
}

function cloneApp(app: TvApp): TvApp {
  return { ...app, ids: [...app.ids] };
}
