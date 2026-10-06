import { useCallback, useEffect, useRef, useState } from "react";

// How far the user must keep scrolling in one direction before the header
// moves, so a finger resting on the screen doesn't make it flicker.
const TRAVEL_PX = 24;
// Near the top there is room for the header anyway; never hide it there.
const TOP_ZONE_PX = 64;

/**
 * Hide-on-scroll-down, show-on-scroll-up for a header. The window's scroll is
 * tracked by default; `report(y)` feeds another source, such as an artifact
 * iframe posting its own scroll position. CSS decides where hiding applies
 * (phone widths only), so this just tracks direction.
 */
export function useAutoHide(opts: { trackWindow: boolean; paused?: boolean }): {
  hidden: boolean;
  report: (y: number) => void;
} {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  const travel = useRef(0);
  const paused = !!opts.paused;

  const report = useCallback((y: number) => {
    const dy = y - last.current;
    last.current = y;
    if (y <= TOP_ZONE_PX) {
      travel.current = 0;
      setHidden(false);
      return;
    }
    // Restart the count whenever the direction flips.
    travel.current = Math.sign(dy) === Math.sign(travel.current) ? travel.current + dy : dy;
    if (travel.current > TRAVEL_PX) setHidden(true);
    else if (travel.current < -TRAVEL_PX) setHidden(false);
  }, []);

  useEffect(() => {
    if (!opts.trackWindow) return;
    last.current = window.scrollY;
    const onScroll = () => report(window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [opts.trackWindow, report]);

  // An open menu or sheet keeps the header on screen.
  useEffect(() => {
    if (paused) setHidden(false);
  }, [paused]);

  return { hidden: hidden && !paused, report };
}
