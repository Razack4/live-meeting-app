import type { VideoSelection } from "@/types";

/**
 * Creates a MediaStream from a pre-recorded video file using captureStream().
 * The returned stream contains the video track from the playing file.
 * The caller is responsible for stopping tracks and revoking the blob URL.
 */
export function createVideoStream(
  selection: VideoSelection,
): { stream: MediaStream; cleanup: () => void } {
  const video = document.createElement("video");
  video.src = selection.url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.autoplay = true;

  const stream = new MediaStream();

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
      }
    } catch {
      // captureStream not supported — stream stays empty
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

  return { stream, cleanup };
}
