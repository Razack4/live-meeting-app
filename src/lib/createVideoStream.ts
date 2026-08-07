import type { VideoSelection } from "@/types";

/**
 * Creates a MediaStream from a pre-recorded video file using captureStream().
 * Returns a promise that resolves only when the video element has
 * readyState >= HAVE_ENOUGH_DATA and the MediaStream contains at least one
 * active video track (track.readyState === "live").
 */
export function createVideoStream(
  selection: VideoSelection,
): {
  stream: MediaStream;
  cleanup: () => void;
  ready: Promise<void>;
  /** Call when returning to foreground to resume the hidden source video. */
  resume: () => void;
} {
  const video = document.createElement("video");
  video.src = selection.url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";

  const stream = new MediaStream();

  let resolveReady: () => void;
  let rejectReady: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const HAVE_ENOUGH_DATA = 4;

  let settled = false;
  const markReady = () => {
    if (settled) return;
    settled = true;
    resolveReady();
  };

  const fail = (msg: string) => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(msg));
  };

  // Expose the source video element so callers (e.g. background handler) can
  // resume it after the browser pauses it during background tab switches.
  let capturedStream: MediaStream | null = null;

  const attachCapture = () => {
    if (capturedStream) return;
    if (video.readyState < HAVE_ENOUGH_DATA) return;
    try {
      const extended = video as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captured =
        extended.captureStream?.() ?? extended.mozCaptureStream?.();
      if (!captured) {
        fail("captureStream is not supported in this browser.");
        return;
      }
      capturedStream = captured;

      // Remove any stale tracks from previous attempts.
      stream.getTracks().forEach((t) => {
        stream.removeTrack(t);
      });

      captured.getVideoTracks().forEach((t) => stream.addTrack(t));
      captured.getAudioTracks().forEach((t) => stream.addTrack(t));

      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0 && videoTracks[0].readyState === "live") {
        markReady();
      }
    } catch {
      // captureStream not supported
    }
  };

  // Poll for readiness: some browsers deliver tracks asynchronously after
  // captureStream() returns, especially when the video is still buffering.
  const readyCheckInterval = window.setInterval(() => {
    if (settled) {
      window.clearInterval(readyCheckInterval);
      return;
    }
    if (video.readyState >= HAVE_ENOUGH_DATA) {
      attachCapture();
      // Re-check after attach — tracks may now be live.
      const vt = stream.getVideoTracks();
      if (!settled && vt.length > 0 && vt[0].readyState === "live") {
        markReady();
        window.clearInterval(readyCheckInterval);
      }
    }
  }, 100);

  video.addEventListener("loadeddata", () => {
    video.play().catch(() => {});
    attachCapture();
  });

  // Also listen for "canplay" and "playing" as backup readiness signals.
  video.addEventListener("canplay", () => {
    attachCapture();
  });

  video.addEventListener("playing", () => {
    attachCapture();
    if (!settled) {
      const vt = stream.getVideoTracks();
      if (vt.length > 0) {
        markReady();
      }
    }
  });

  video.addEventListener("error", () => {
    fail("Failed to load the video file.");
  });

  // Safety timeout: resolve or reject after 15 seconds.
  const safetyTimeout = window.setTimeout(() => {
    if (!settled) {
      if (stream.getVideoTracks().length > 0) {
        markReady();
      } else {
        fail("Timed out waiting for the video stream to become ready.");
      }
    }
  }, 15000);

  const cleanup = () => {
    window.clearInterval(readyCheckInterval);
    window.clearTimeout(safetyTimeout);
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (capturedStream) {
      capturedStream.getTracks().forEach((t) => t.stop());
    }
  };

  // BUG 3: Browsers pause <video> playback when the tab goes to background.
  // When returning to foreground, call this to resume the hidden source video
  // so it keeps feeding the MediaStream that Agora publishes.
  const resume = () => {
    if (video.paused) {
      video.play().catch(() => {});
    }
  };

  return { stream, cleanup, ready, resume };
}
