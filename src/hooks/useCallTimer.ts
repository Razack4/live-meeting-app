import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/types";

export function useCallTimer(active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsed(0);
      return;
    }

    startRef.current = Date.now();
    const id = window.setInterval(() => {
      if (startRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);

    return () => window.clearInterval(id);
  }, [active]);

  return formatDuration(elapsed);
}
