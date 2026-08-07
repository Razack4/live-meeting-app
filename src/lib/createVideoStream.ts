import type { VideoSelection } from "@/types";

/**
 * Creates a MediaStream from a pre-recorded video file using captureStream().
 * Returns a promise that resolves when the stream is ready with at least one video track.
 */
export function createVideoStream(
  selection: VideoSelection,
): { stream: MediaStream; cleanup: () => void; ready: Promise<void> } {
  const video = document.createElement("video");
  video.src = selection.url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;

  const stream = new MediaStream();

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const attachCapture = () => {
    try {
      const extended = video as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captured =
        extended.captureStream?.() ?? extended.mozCaptureStream?.();
      if (captured) {
        captured.getVideoTracks().forEach((t) => stream.addTrack(t));
        captured.getAudioTracks().forEach((t) => stream.addTrack(t));
        if (stream.getVideoTracks().length > 0) {
          resolveReady();
        }
      }
    } catch {
      // captureStream not supported
    }
  };

  video.addEventListener("loadeddata", () => {
    video.play().catch(() => {});
    attachCapture();
  });

  const cleanup = () => {
    video.pause();
    video.removeEventListener("loadeddata", attachCapture);
    video.removeAttribute("src");
    video.load();
  };

  return { stream, cleanup, ready };
}
