/**
 * Refresh packages/core/vendor/phone-timezones/phone-timezones.json, the data the dialler reads a prospect's local
 * time from (packages/core/src/phone-timezone.ts):
 *
 *   - phone prefixes to IANA zones: libphonenumber's `resources/timezones/map_data.txt` (Apache-2.0), the data its
 *     PhoneNumberToTimeZonesMapper reads, at a pinned commit;
 *   - ISO country codes to IANA zones: the tz database's `zone.tab` (public domain), at a pinned release.
 *
 * Run from the repository root, then run the test and commit both files:
 *
 *   bun packages/core/vendor/phone-timezones/refresh.ts [--libphonenumber <commit sha>] [--tzdb <release, e.g. 2026f>]
 *   bun --bun run test packages/core/__tests__/phone-timezone.test.ts
 *
 * Without flags it takes libphonenumber's newest commit that touched the file and the tz database's current release.
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = "packages/core/vendor/phone-timezones/phone-timezones.json";
const PATH = "resources/timezones/map_data.txt";

async function text(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "oneshot-gtm-refresh-phone-timezones" },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

const commit =
  flag("libphonenumber") ??
  (
    JSON.parse(
      await text(
        `https://api.github.com/repos/google/libphonenumber/commits?path=${PATH}&per_page=1`,
      ),
    ) as Array<{ sha: string }>
  )[0]!.sha;
const tzdb = flag("tzdb") ?? (await text("https://data.iana.org/time-zones/tzdb/version")).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit sha: ${commit}`);
if (!/^\d{4}[a-z]$/.test(tzdb)) throw new Error(`not a tz release: ${tzdb}`);

const prefixes: Record<string, string> = {};
for (const line of (
  await text(`https://raw.githubusercontent.com/google/libphonenumber/${commit}/${PATH}`)
).split("\n")) {
  const m = /^(\d+)\|(.+)$/.exec(line.trim());
  if (m) prefixes[m[1]!] = m[2]!;
}

const countries: Record<string, string[]> = {};
const zoneTab = await text(`https://raw.githubusercontent.com/eggert/tz/${tzdb}/zone.tab`);
for (const line of zoneTab.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [code, , zone] = line.split("\t");
  if (code && zone) (countries[code] ??= []).push(zone);
}

if (
  Object.keys(prefixes).length < 3000 ||
  !prefixes["1212"] ||
  Object.keys(countries).length < 240
) {
  throw new Error("the downloaded data is smaller than expected; nothing written");
}

const sorted = <T>(o: Record<string, T>) =>
  Object.fromEntries(
    Object.keys(o)
      .toSorted()
      .map((k) => [k, o[k]]),
  );
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      libphonenumber: { commit, file: PATH, license: "Apache-2.0" },
      tzdb: { release: tzdb, file: "zone.tab", license: "public domain" },
      prefixes: sorted(prefixes),
      countries: sorted(countries),
    },
    null,
    1,
  )}\n`,
);
console.log(
  `Wrote ${OUT}: ${Object.keys(prefixes).length} prefixes (libphonenumber ${commit.slice(0, 12)}), ${Object.keys(countries).length} countries (tzdb ${tzdb})`,
);
