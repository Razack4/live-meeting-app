import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileVideo,
  Link2,
  Upload,
  Video,
  X,
} from "lucide-react";
import VideoCall from "@/components/VideoCall";
import { useAgoraClient } from "@/hooks/useAgoraClient";
import {
  buildShareableLink,
  generateRoomId,
  isAcceptableVideo,
  type VideoSelection,
} from "@/types";
import { createVideoStream } from "@/lib/createVideoStream";

type HostPhase = "setup" | "active";

interface ActiveSession {
  localStream: MediaStream;
  displayName: string;
  roomId: string;
}

export default function HostScreen() {
  const [phase, setPhase] = useState<HostPhase>("setup");
  const [selection, setSelection] = useState<VideoSelection | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toastShow, setToastShow] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const [linkGenerated, setLinkGenerated] = useState(false);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const videoCleanupRef = useRef<(() => void) | null>(null);

  const revokeUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
  }, []);

  const loadVideo = useCallback(
    (file: File) => {
      setError(null);
      if (!isAcceptableVideo(file)) {
        setError("Unsupported file. Please choose an MP4, WebM, or MOV video.");
        return;
      }
      const url = URL.createObjectURL(file);
      setSelection((prev) => {
        if (prev) revokeUrl(prev.url);
        return { file, url };
      });
    },
    [revokeUrl],
  );

  useEffect(() => {
    setRoomId(generateRoomId());
    return () => {
      if (selection) revokeUrl(selection.url);
      if (videoCleanupRef.current) videoCleanupRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadVideo(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.ChangeEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadVideo(file);
  };

  const handleClearVideo = () => {
    if (selection) revokeUrl(selection.url);
    setSelection(null);
  };

  const handleCopyLink = async () => {
    const link = buildShareableLink(roomId);
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = link;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      document.body.removeChild(textarea);
    }
    setToastShow(true);
    window.setTimeout(() => setToastShow(false), 2500);
  };

  const handleGenerateLink = () => {
    if (!selection) return;
    setLinkGenerated(true);
  };

  const handleStartCall = () => {
    if (!selection) return;
    const { stream, cleanup } = createVideoStream(selection);
    videoCleanupRef.current = cleanup;
    const name = displayName.trim() || "Host";
    setSession({ localStream: stream, displayName: name, roomId });
    setPhase("active");
  };

  const handleRemoteStream = useCallback((s: MediaStream) => {
    setRemoteStream(s);
  }, []);

  const handleRemoteEnd = useCallback(() => {
    setRemoteStream(null);
  }, []);

  const {
    state: connectionState,
    error: agoraError,
    cleanup: agoraCleanup,
    toggleCamera,
    toggleMic,
  } = useAgoraClient({
    channel: session?.roomId ?? "",
    isHost: true,
    localStream: session?.localStream ?? null,
    onRemoteStream: handleRemoteStream,
    onRemoteEnd: handleRemoteEnd,
  });

  const handleEnd = useCallback(() => {
    agoraCleanup();
    if (session) {
      session.localStream.getTracks().forEach((t) => t.stop());
    }
    if (videoCleanupRef.current) {
      videoCleanupRef.current();
      videoCleanupRef.current = null;
    }
    setRemoteStream(null);
    setSession(null);
    setPhase("setup");
    setLinkGenerated(false);
    setRoomId(generateRoomId());
  }, [session, agoraCleanup]);

  if (phase === "active" && session) {
    return (
      <VideoCall
        localStream={session.localStream}
        remoteStream={remoteStream}
        displayName={session.displayName}
        remoteLabel="Guest"
        isHost={true}
        connectionState={connectionState}
        onEnd={handleEnd}
        onToggleCamera={toggleCamera}
        onToggleMic={toggleMic}
      />
    );
  }

  return (
    <div className="min-h-dvh bg-black text-white flex flex-col">
      <header className="px-6 pt-12 pb-6 sm:pt-16">
        <div className="max-w-md mx-auto text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-[1.3rem] bg-emerald-500/15 ring-1 ring-emerald-400/30 mb-4">
            <Video className="w-8 h-8 text-emerald-400" strokeWidth={2} />
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight">FaceTime</h1>
          <p className="mt-1.5 text-sm text-white/50 leading-relaxed">
            Select a pre-recorded video, generate a call link, and share it.
            Your clip is what the other person sees.
          </p>
        </div>
      </header>

      <main className="flex-1 px-6 pb-10">
        <div className="max-w-md mx-auto space-y-6">
          <div className="flex items-center justify-center">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 ring-1 ring-white/10 text-xs font-medium text-white/60">
              Host Mode
            </span>
          </div>

          {/* Step 1: File picker */}
          {!selection ? (
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`relative cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-200 px-6 py-10 text-center
                ${
                  dragOver
                    ? "border-emerald-400 bg-emerald-500/10 scale-[1.01]"
                    : "border-white/15 bg-white/5 hover:border-white/30 hover:bg-white/10"
                }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mp4,.webm,.mov"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="flex flex-col items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-white/10 flex items-center justify-center">
                  <Upload className="w-5 h-5 text-white/70" />
                </div>
                <p className="text-sm font-medium text-white/80">
                  Select your outgoing video
                </p>
                <p className="text-xs text-white/40">MP4, WebM, or MOV</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 overflow-hidden">
              <div className="relative bg-black aspect-video">
                <video
                  ref={previewRef}
                  src={selection.url}
                  muted
                  loop
                  playsInline
                  controls
                  className="w-full h-full object-contain"
                />
                <button
                  onClick={handleClearVideo}
                  className="absolute top-2 right-2 w-9 h-9 min-h-[44px] min-w-[44px] rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-colors"
                  aria-label="Remove video"
                >
                  <X className="w-4 h-4 text-white" />
                </button>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                <div className="min-w-0 flex items-center gap-2">
                  <FileVideo className="w-4 h-4 text-white/40 shrink-0" />
                  <p className="truncate text-white/70">
                    {selection.file.name}
                  </p>
                </div>
                <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-400/20 text-[11px] font-medium">
                  <CheckCircle2 className="w-3 h-3" />
                  Loaded
                </span>
              </div>
            </div>
          )}

          {/* Step 2: Generate link */}
          {selection && !linkGenerated && (
            <button
              onClick={handleGenerateLink}
              className="w-full min-h-[50px] rounded-full font-semibold text-[15px] bg-white/10 hover:bg-white/15 active:scale-[0.98] text-white transition-all duration-200"
            >
              Generate Call Link
            </button>
          )}

          {/* Step 3: Link display + start */}
          {selection && linkGenerated && (
            <>
              <div className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-xs font-medium text-white/40">
                    Invitation Link
                  </span>
                  <button
                    onClick={handleCopyLink}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 active:scale-95 text-xs font-medium text-emerald-400 ring-1 ring-emerald-400/20 transition-all"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    Copy Link
                  </button>
                </div>
                <p className="text-xs text-white/50 break-all font-mono">
                  {buildShareableLink(roomId)}
                </p>
              </div>

              <div>
                <label
                  htmlFor="displayName"
                  className="block text-xs font-medium text-white/40 mb-1.5"
                >
                  Display name
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Host"
                  maxLength={32}
                  className="w-full rounded-xl bg-white/5 ring-1 ring-white/10 focus:ring-2 focus:ring-emerald-400 outline-none px-4 py-3 text-sm text-white placeholder:text-white/30 transition-all"
                />
              </div>

              <button
                onClick={handleStartCall}
                className="w-full min-h-[50px] rounded-full font-semibold text-[15px] bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-black shadow-lg shadow-emerald-500/25 transition-all duration-200"
              >
                Start & Wait for Guest
              </button>
            </>
          )}

          {error && (
            <p className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 ring-1 ring-red-500/20 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </main>

      <footer className="px-6 pb-8 text-center">
        <p className="text-xs text-white/30">
          Powered by Agora · works on Wi-Fi, LTE, 4G, 5G
        </p>
      </footer>

      {toastShow && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-white/10 backdrop-blur-xl ring-1 ring-white/15 shadow-lg text-sm text-white">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Link copied to clipboard
          </div>
        </div>
      )}
    </div>
  );
}
