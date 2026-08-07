import type { VideoSelection } from "@/types";

/**
 * Creates a MediaStream from a pre-recorded video file.
 *
 * Primary strategy: HTMLVideoElement.captureStream() (Chrome, Firefox, desktop Safari).
 * Fallback for iOS Safari (which lacks captureStream on media elements):
 *   - Draw video frames onto a <canvas> via rAF, then canvas.captureStream() for video.
 *   - Route audio through a Web Audio MediaStreamAudioDestinationNode.
 *
 * Returns a promise that resolves only when the MediaStream contains at least one
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
  video.preload = "auto";

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

  // Track resources for cleanup
  let capturedStream: MediaStream | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let canvasStream: MediaStream | null = null;
  let rafId: number | null = null;
  let audioCtx: AudioContext | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let readyCheckInterval: number | null = null;

  // ── Strategy 1: video.captureStream() ──────────────────────────────
  const tryCaptureStream = (): boolean => {
    const extended = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captured =
      extended.captureStream?.() ?? extended.mozCaptureStream?.();
    if (!captured) return false;

    capturedStream = captured;
    stream.getTracks().forEach((t) => stream.removeTrack(t));
    captured.getVideoTracks().forEach((t) => stream.addTrack(t));
    captured.getAudioTracks().forEach((t) => stream.addTrack(t));

    const vt = stream.getVideoTracks();
    if (vt.length > 0 && (vt[0].readyState as string) === "live") {
      markReady();
    }
    return true;
  };

  // ── Strategy 2: canvas + rAF fallback (iOS Safari) ──────────────────
  const tryCanvasFallback = (): boolean => {
    if (video.videoWidth === 0 || video.videoHeight === 0) return false;

    canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    try {
      canvasStream = canvas.captureStream(30);
    } catch {
      return false;
    }

    const drawFrame = () => {
      if (!ctx || !canvas) return;
      if (!video.paused && !video.ended) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      rafId = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    stream.getTracks().forEach((t) => stream.removeTrack(t));
    canvasStream.getVideoTracks().forEach((t) => stream.addTrack(t));

    // Audio via Web Audio API
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaElementSource(video);
      audioDest = audioCtx.createMediaStreamDestination();
      source.connect(audioDest);
      audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch {
      // No audio available — video-only is acceptable
    }

    const vt = stream.getVideoTracks();
    if (vt.length > 0 && (vt[0].readyState as string) === "live") {
      markReady();
    }
    return true;
  };

  const attachCapture = () => {
    if (settled) return;
    if (video.readyState < HAVE_ENOUGH_DATA) return;

    // Try native captureStream first
    if (tryCaptureStream()) return;

    // Fall back to canvas-based capture (iOS Safari)
    tryCanvasFallback();
  };

  // Poll for readiness
  readyCheckInterval = window.setInterval(() => {
    if (settled) {
      if (readyCheckInterval !== null) {
        window.clearInterval(readyCheckInterval);
        readyCheckInterval = null;
      }
      return;
    }
    if (video.readyState >= HAVE_ENOUGH_DATA) {
      attachCapture();
      if (!settled) {
        const vt = stream.getVideoTracks();
        if (vt.length > 0 && (vt[0].readyState as string) === "live") {
          markReady();
          if (readyCheckInterval !== null) {
            window.clearInterval(readyCheckInterval);
            readyCheckInterval = null;
          }
        }
      }
    }
  }, 100);

  video.addEventListener("loadeddata", () => {
    // user-gesture: play() was called from the click handler chain on desktop,
    // but on iOS we need the video playing for canvas drawImage to produce frames
    video.play().catch(() => {});
    attachCapture();
  });

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

  // Safety timeout: 15 seconds
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
    if (readyCheckInterval !== null) {
      window.clearInterval(readyCheckInterval);
      readyCheckInterval = null;
    }
    window.clearTimeout(safetyTimeout);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (capturedStream) {
      capturedStream.getTracks().forEach((t) => t.stop());
    }
    if (canvasStream) {
      canvasStream.getTracks().forEach((t) => t.stop());
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
    }
  };

  const resume = () => {
    if (video.paused) {
      video.play().catch(() => {});
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  };

  return { stream, cleanup, ready, resume };
}
