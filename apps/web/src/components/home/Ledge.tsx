import { motion } from "motion/react";
import { useEffect, useId, useReducer, useSyncExternalStore } from "react";
import { INITIAL_LEDGE, ledgePose, ledgeReducer, type LedgePose } from "../../lib/ledgeState.ts";
import { useLocalStorage } from "../../lib/useLocalStorage.ts";

/** Original SVG character, developed with Montage's character rig and pose tools. */
export function LedgeIllustration({
  pose = "idle",
  animated = false,
}: {
  pose?: LedgePose;
  animated?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const happy = pose === "reply";
  const waving = pose === "wave";
  const working = pose === "working";
  const curve = { duration: 1.6, times: [0, 0.18, 0.4, 0.65, 1] };
  return (
    <svg
      viewBox="0 0 112 112"
      fill="none"
      aria-hidden="true"
      className="h-full w-full overflow-visible"
    >
      <defs>
        <linearGradient
          id={`${id}-cover`}
          x1="25"
          y1="23"
          x2="82"
          y2="91"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fffaf0" />
          <stop offset="1" stopColor="#ddd1b9" />
        </linearGradient>
        <linearGradient
          id={`${id}-spine`}
          x1="19"
          y1="30"
          x2="33"
          y2="82"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#a4977f" />
          <stop offset="1" stopColor="#6d6455" />
        </linearGradient>
      </defs>
      <ellipse cx="55" cy="103" rx="30" ry="4" fill="currentColor" opacity="0.12" />
      <motion.g
        initial={false}
        animate={
          animated && happy
            ? { y: [0, 2, -8, -3, 0], rotate: [0, -4, 3, -2, 0] }
            : { y: 0, rotate: 0 }
        }
        transition={animated ? curve : { duration: 0 }}
        style={{ transformOrigin: "56px 88px", transformBox: "view-box" }}
      >
        <path
          d="M39 87L37 99Q32 102 28 99"
          stroke="#82745f"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M69 88L72 99Q77 102 81 98"
          stroke="#82745f"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path d="M23 58Q10 59 12 74" stroke="#bcad91" strokeWidth="6" strokeLinecap="round" />
        <motion.g
          initial={false}
          animate={
            animated && waving
              ? { rotate: [0, -85, -60, -85, 0] }
              : { rotate: waving ? -75 : happy ? -45 : working ? 18 : 0 }
          }
          transition={animated ? curve : { duration: 0 }}
          style={{ transformOrigin: "84px 60px", transformBox: "view-box" }}
        >
          <path d="M84 60Q99 59 103 71" stroke="#bcad91" strokeWidth="6" strokeLinecap="round" />
          <circle cx="103" cy="72" r="4" fill="#d7c8aa" />
        </motion.g>
        <path
          d="M25 29L79 20Q87 19 89 27L89 79Q89 87 81 90L32 97Q23 98 21 89L19 40Q19 32 25 29Z"
          fill="#8e8069"
        />
        <path d="M32 33L83 25L84 79Q84 84 79 85L33 92Z" fill="#f6eedc" />
        <path
          d="M37 83L83 77M37 87L82 81"
          stroke="#c9bfa9"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <path
          d="M24 24L73 17Q81 16 81 24L81 78Q81 84 75 85L29 91Q21 92 21 83L19 34Q19 26 24 24Z"
          fill={`url(#${id}-cover)`}
          stroke="#c8baa0"
          strokeWidth="1.2"
        />
        <path
          d="M26 24L31 23L33 90L29 91Q21 92 21 83L19 34Q19 26 26 24Z"
          fill={`url(#${id}-spine)`}
        />
        <path
          d="M35 27L73 22M36 31L60 28"
          stroke="white"
          strokeOpacity="0.55"
          strokeLinecap="round"
        />
        <motion.g
          initial={false}
          animate={animated && working ? { y: [0, -3, 0] } : { y: 0 }}
          transition={
            animated && working
              ? { duration: 1.4, repeat: Infinity, repeatDelay: 3.5 }
              : { duration: 0 }
          }
        >
          <path d="M60 19L59 7Q59 5 62 5L72 6L74 22L70 20L67 23L64 20L61 23Z" fill="#80c99c" />
          <path
            d="M63 10L69 10.5M64 14L70 14.5"
            stroke="#3d7857"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </motion.g>
        <motion.g
          initial={false}
          animate={{ x: working ? 1.5 : 0, y: working ? -3 : 0 }}
          transition={{ duration: animated ? 0.35 : 0 }}
        >
          <motion.g
            initial={false}
            animate={animated ? { scaleY: [1, 1, 0.08, 1, 1] } : { scaleY: 1 }}
            transition={
              animated
                ? {
                    duration: 0.35,
                    times: [0, 0.15, 0.45, 0.7, 1],
                    repeat: Infinity,
                    repeatDelay: 6.5,
                    delay: 3,
                  }
                : { duration: 0 }
            }
            style={{ transformOrigin: "56px 52px", transformBox: "view-box" }}
          >
            {happy ? (
              <path
                d="M39 54Q43 46 47 53M60 51Q64 43 68 50"
                stroke="#302b24"
                strokeWidth="3.5"
                strokeLinecap="round"
              />
            ) : (
              <>
                <ellipse cx="43" cy="53" rx="5.3" ry="7" fill="#302b24" />
                <ellipse cx="65" cy="50" rx="5.3" ry="7" fill="#302b24" />
                <circle cx="44.5" cy="50.5" r="1.7" fill="#fffaf0" />
                <circle cx="66.5" cy="47.5" r="1.7" fill="#fffaf0" />
              </>
            )}
          </motion.g>
          <ellipse cx="37" cy="63" rx="4.5" ry="2.5" fill="#cb9980" opacity="0.4" />
          <ellipse cx="72" cy="59" rx="4.5" ry="2.5" fill="#cb9980" opacity="0.4" />
          <path
            d={happy ? "M50 65Q57 75 62 63" : "M51 65Q56 69 60 64"}
            stroke="#574535"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </motion.g>
        <path d="M40 78L57 76" stroke="#b7a689" strokeWidth="1.5" strokeLinecap="round" />
      </motion.g>
    </svg>
  );
}

function subscribeMotionPreference(notify: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
const motionReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}
const pageVisible = () => !document.hidden;
const serverReduced = () => true;
const serverVisible = () => false;

export function Ledge({
  workspace,
  replies,
  working,
}: {
  workspace: string;
  replies: number | null;
  working: boolean;
}) {
  const [paused, setPaused] = useLocalStorage("ledge-paused");
  const reduced = useSyncExternalStore(subscribeMotionPreference, motionReduced, serverReduced);
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible, serverVisible);
  const [state, dispatch] = useReducer(ledgeReducer, INITIAL_LEDGE);
  const animated = !paused && !reduced && visible;

  useEffect(() => {
    dispatch({ type: "observe", workspace, replies, working, animate: animated });
  }, [workspace, replies, working, animated]);
  useEffect(() => {
    if (!state.action) return;
    const timer = setTimeout(() => dispatch({ type: "settle" }), 1800);
    return () => clearTimeout(timer);
  }, [state.action]);

  return (
    <div className="flex shrink-0 flex-col items-center">
      <button
        type="button"
        aria-label="Wave to Ledge"
        aria-disabled={!animated}
        title="Ledge, your little ledger companion"
        onClick={() => {
          if (animated) dispatch({ type: "wave" });
        }}
        className="h-12 w-12 rounded-lg text-ink-cream focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink-receipt sm:h-16 sm:w-16"
      >
        <LedgeIllustration pose={ledgePose(state, animated)} animated={animated} />
      </button>
      <button
        type="button"
        onClick={() => setPaused(!paused)}
        aria-pressed={paused}
        aria-label="Pause Ledge animation"
        className="mt-1 min-h-6 px-1 font-mono text-[9px] text-ink-muted underline-offset-4 hover:text-ink-cream hover:underline focus-visible:outline-2 focus-visible:outline-ink-receipt"
      >
        {paused ? "resume" : "pause"}
      </button>
    </div>
  );
}
