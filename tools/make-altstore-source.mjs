#!/usr/bin/env node
// Builds the AltStore source (source.json) that CI publishes with each release.
// AltStore polls the source; when the first entry of `versions` is newer than the installed app
// (version / buildVersion), it offers the update.
//
// CLI (used by .github/workflows/ios-ipa.yml):
//   node tools/make-altstore-source.mjs --version 1.2.57 --build 57 --ipa build/FrameRemote.ipa \
//     --privacy build/privacy.json --repo RitualKit/Tv-remote --notes "commit subject" --out build/source.json

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const APP = {
  name: 'Frame Remote',
  bundleIdentifier: 'com.ritualkit.frameremote',
  developerName: 'RitualKit',
  subtitle: 'Remote for Samsung The Frame',
  localizedDescription:
    'An iPhone remote for Samsung The Frame (2022+): D-pad, volume, channels, power and Art Mode, ' +
    'number pad, customisable app buttons and Wi-Fi discovery. Talks to the TV directly on your network.',
  tintColor: '4F8CFF',
  minOSVersion: '16.4',
};

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);

/**
 * @param {{ version: string, build: string, date: string, size: number, downloadURL: string,
 *           iconURL: string, sourceURL: string, website?: string, notes?: string,
 *           privacy?: Record<string, string> }} p
 */
export function buildSource(p) {
  if (!/^\d+\.\d+\.\d+$/.test(p.version ?? '')) throw new Error(`bad version "${p.version}"`);
  if (!/^\d+$/.test(String(p.build ?? ''))) throw new Error(`bad build "${p.build}"`);
  if (!Number.isInteger(p.size) || p.size <= 0) throw new Error(`bad size "${p.size}"`);
  if (!isHttps(p.downloadURL)) throw new Error(`downloadURL must be https: "${p.downloadURL}"`);
  if (!isHttps(p.iconURL)) throw new Error(`iconURL must be https: "${p.iconURL}"`);
  if (!isHttps(p.sourceURL)) throw new Error(`sourceURL must be https: "${p.sourceURL}"`);
  if (Number.isNaN(Date.parse(p.date ?? ''))) throw new Error(`bad date "${p.date}"`);

  const privacy = {};
  for (const [k, v] of Object.entries(p.privacy ?? {})) {
    if (/^NS\w+UsageDescription$/.test(k) && typeof v === 'string' && v.trim()) privacy[k] = v;
  }
  const notes = (p.notes ?? '').trim() || `Build ${p.build}`;
  const version = {
    version: p.version,
    buildVersion: String(p.build),
    date: new Date(p.date).toISOString(),
    localizedDescription: notes,
    downloadURL: p.downloadURL,
    size: p.size,
    minOSVersion: APP.minOSVersion,
  };

  return {
    name: APP.name,
    identifier: `${APP.bundleIdentifier}.source`,
    // Where this file itself is published (the stable "latest release" URL).
    sourceURL: p.sourceURL,
    subtitle: APP.subtitle,
    description: APP.localizedDescription,
    iconURL: p.iconURL,
    ...(p.website ? { website: p.website } : {}),
    tintColor: APP.tintColor,
    apps: [
      {
        name: APP.name,
        bundleIdentifier: APP.bundleIdentifier,
        developerName: APP.developerName,
        subtitle: APP.subtitle,
        localizedDescription: APP.localizedDescription,
        iconURL: p.iconURL,
        tintColor: APP.tintColor,
        category: 'utilities',
        // Newest first: AltStore compares versions[0] with the installed app.
        versions: [version],
        // Legacy (AltStore 1.x) single-version fields, mirrored from versions[0].
        version: version.version,
        versionDate: version.date,
        versionDescription: version.localizedDescription,
        downloadURL: version.downloadURL,
        size: version.size,
        // Declared up front so AltStore can show/verify them; must match the built Info.plist.
        appPermissions: { entitlements: [], privacy },
      },
    ],
    news: [],
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (!m) throw new Error(`unexpected argument "${argv[i]}"`);
    out[m[1]] = argv[++i];
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  for (const k of ['version', 'build', 'ipa', 'repo', 'out']) if (!a[k]) throw new Error(`missing --${k}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo)) throw new Error(`bad --repo "${a.repo}"`);
  const privacy = a.privacy ? JSON.parse(fs.readFileSync(a.privacy, 'utf8')) : {};
  const source = buildSource({
    version: a.version,
    build: a.build,
    date: a.date ?? new Date().toISOString(),
    size: fs.statSync(a.ipa).size,
    downloadURL: `https://github.com/${a.repo}/releases/download/v${a.version}/FrameRemote.ipa`,
    iconURL: `https://raw.githubusercontent.com/${a.repo}/main/assets/icon.png`,
    sourceURL: `https://github.com/${a.repo}/releases/latest/download/source.json`,
    website: `https://github.com/${a.repo}`,
    notes: a.notes,
    privacy,
  });
  fs.writeFileSync(a.out, JSON.stringify(source, null, 2) + '\n');
  return source;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const s = main();
    console.log(`wrote source for ${s.apps[0].name} ${s.apps[0].versions[0].version} (${s.apps[0].versions[0].buildVersion})`);
  } catch (e) {
    console.error(`make-altstore-source: ${e.message}`);
    process.exit(1);
  }
}
