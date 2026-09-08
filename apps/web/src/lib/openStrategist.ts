export const OPEN_STRATEGIST_EVENT = "oneshot-gtm:open-strategist";

/** Open the global strategist drawer from onboarding or any future CTA. */
export function openStrategist(): void {
  window.dispatchEvent(new Event(OPEN_STRATEGIST_EVENT));
}
