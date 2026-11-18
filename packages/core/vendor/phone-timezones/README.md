# Phone and country time zones (vendored)

`phone-timezones.json` is the data the dialler reads a prospect's local time from
(`packages/core/src/phone-timezone.ts`), so the Calls page can say what time it is where they are and keep
calls inside the workspace's call window. It is generated; do not edit it by hand. It was ported from the
OneShot API's copy of the same data (same commit, same release).

| Part                                                          | Source                                                                                               | Pinned at                                                      | Licence       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------- |
| `prefixes`: phone number prefix to IANA zones (`&`-separated) | libphonenumber `resources/timezones/map_data.txt`, the data its `PhoneNumberToTimeZonesMapper` reads | commit `d1457634c3d95e570dad433ee0ab400beb343a56` (2026-10-07) | Apache-2.0    |
| `countries`: ISO 3166 country code to IANA zones              | tz database `zone.tab`                                                                               | release `2026f`                                                | public domain |

libphonenumber is Copyright (C) The Libphonenumber Authors, licensed under the Apache License, Version 2.0. The
notice and the full licence text are in [`LICENSE`](./LICENSE) next to the data; the server build copies it into
its package (`dist/licenses/libphonenumber-LICENSE`), since the data is bundled there. The data is used unmodified
apart from the JSON packing.

The longest prefix of a number's E.164 digits wins, as in libphonenumber. A prefix as short as the calling code is
the whole country's zone list. North American area codes are listed one by one, with finer prefixes where an area
code spans two zones (for example `1208201`).

## Refresh

Run from the repository root, then check and commit both this file's table and the JSON:

```sh
bun packages/core/vendor/phone-timezones/refresh.ts            # newest libphonenumber commit of the file, current tz release
bun packages/core/vendor/phone-timezones/refresh.ts --libphonenumber <sha> --tzdb <release>
bun --bun run test packages/core/__tests__/phone-timezone.test.ts
```

libphonenumber publishes a release roughly every two weeks and updates the file when area codes are added or move;
the tz database releases a few times a year. Refresh when either changes, at least every quarter. The script refuses
to write data much smaller than expected.
