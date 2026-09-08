/**
 * The strategist, absent.
 *
 * vite.config.ts aliases StrategistDock to this file in a demo build. The dock
 * streams from an LLM endpoint that a static bundle has no way to reach, so it
 * is not rendered there anyway (see routes/__root.tsx) — but the static import
 * alone is enough to keep @assistant-ui/react in the output, which is a 174 KB
 * chunk vendored into a site to be downloaded by nobody.
 *
 * An alias rather than a lazier import, because the reason it is gone belongs
 * in the build that drops it, not spread through the app that ships it.
 */
export function StrategistDock() {
  return null;
}
