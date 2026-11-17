import { ChevronDown, CircleStop, Phone } from "lucide-react";
import { cn } from "../../lib/cn.ts";
import { Button } from "../primitives/Button.tsx";

/**
 * A cadence row whose next step is a call: it is placed from /calls, never
 * sent from the cadences page. Open call, the row's expand button (the
 * row's click opens it too; this is the keyboard's way in), and Stop.
 */
export function CallStepActions({
  expanded,
  stopDisabled,
  onOpenCall,
  onToggle,
  onStop,
}: {
  expanded: boolean;
  stopDisabled: boolean;
  onOpenCall: () => void;
  onToggle: () => void;
  onStop: () => void;
}) {
  return (
    <>
      <Button size="sm" title="Open the call on /calls" onClick={onOpenCall}>
        <Phone size={12} /> Open call
      </Button>
      <Button
        size="sm"
        variant="ghost"
        title={expanded ? "collapse" : "view cadence history and the offer"}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronDown size={12} className={cn("transition-transform", expanded && "rotate-180")} />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        title="Stop cadence"
        disabled={stopDisabled}
        onClick={onStop}
      >
        <CircleStop size={12} />
      </Button>
    </>
  );
}
