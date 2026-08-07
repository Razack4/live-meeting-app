import { useEffect, useRef, useState } from "react";
import {
  FlipHorizontal2,
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
} from "lucide-react";
import { useCallTimer } from "@/hooks/useCallTimer";
import type { ConnectionState } from "@/types";

interface VideoCallProps {
  localStream: MediaStream;
  remoteStream: MediaStream | null;
  displayName: string;
  remoteLabel: string;
  isHost: boolean;
  connectionState: ConnectionState;
  onEnd: () => void;
  onToggleCamera: (on: boolean) => void;
  onToggleMic: (on: boolean) => void;
  onResumeRemoteVideo?: () => void;
  /** Called when returning to foreground to resume the hidden source video. */
  onResumeSourceVideo?: (() => void) | null;
}

export default function VideoCall({
  localStream,
  remoteStream,
  displayName,
  remoteLabel,
  isHost,
  connectionState,
  onEnd,
  onToggleCamera,
  onToggleMic,
  onResumeRemoteVideo,
  onResumeSourceVideo,
}: VideoCallProps) {
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(true);
  const [swapped, setSwapped] = useState(false);
  const elapsed = useCallTimer(connectionState === "connected");

  useEffect(() => {
    const v = mainVideoRef.current;
    if (!v) {
      console.warn("[VideoCall] mainVideoRef is null — cannot attach stream");
      return;
    }
    if (remoteStream && !swapped) {
      v.srcObject = remoteStream;
      v.muted = false;
      console.log("[VideoCall] main video ← remote stream");
    } else if (remoteStream && swapped) {
      v.srcObject = localStream;
      v.muted = true;
    } else {
      v.srcObject = localStream;
      v.muted = true;
    }
    v.play().catch((err) => console.warn("[VideoCall] main video play() failed:", err));
  }, [remoteStream, localStream, swapped]);

  useEffect(() => {
    const v = pipVideoRef.current;
    if (!v) return;
    if (swapped && remoteStream) {
      v.srcObject = remoteStream;
      v.muted = false;
    } else {
      v.srcObject = localStream;
      v.muted = true;
    }
    v.play().catch((err) => console.warn("[VideoCall] pip video play() failed:", err));
  }, [localStream, remoteStream, swapped]);

  useEffect(() => {
    onToggleMic(!muted);
  }, [muted, onToggleMic]);

  useEffect(() => {
    onToggleCamera(videoOn);
  }, [videoOn, onToggleCamera]);

  // BUG 3: resume video elements when returning from background.
  // Browsers pause <video> elements and throttle timers when tab is hidden.
  // pagehide = going TO background — do NOT resume there.
  // pageshow / visibilitychange(visible) = returning FROM background — resume.
  useEffect(() => {
    const resumeAllVideo = () => {
      [mainVideoRef.current, pipVideoRef.current].forEach((v) => {
        if (v && v.paused) {
          v.play().catch((err) => console.warn("[VideoCall] resume play() failed:", err));
        }
      });
      onResumeRemoteVideo?.();
      onResumeSourceVideo?.();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        resumeAllVideo();
      }
    };

    const handlePageShow = () => {
      resumeAllVideo();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [onResumeRemoteVideo, onResumeSourceVideo]);

  const handleEnd = () => {
    [mainVideoRef.current, pipVideoRef.current].forEach((v) => {
      if (v) {
        v.pause();
        v.removeAttribute("src");
        v.srcObject = null;
        v.load();
      }
    });
    onEnd();
  };

  const statusLabel: Record<ConnectionState, string> = {
    idle: "Idle",
    initializing: "Initializing…",
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    disconnected: "Disconnected",
    error: "Connection error",
  };

  return (
    <div className="fixed inset-0 bg-black flex flex-col select-none overflow-hidden">
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={mainVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover transition-all duration-500"
        />

        <div className="absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/10 ring-1 ring-white/15 text-xs font-semibold text-white shrink-0">
                {remoteLabel.charAt(0).toUpperCase()}
              </span>
              <span className="truncate text-sm font-medium text-white drop-shadow">
                {remoteLabel}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`px-2.5 py-1 rounded-full backdrop-blur-md text-xs font-medium ring-1 ring-white/10
                  ${
                    connectionState === "connected"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : connectionState === "error"
                        ? "bg-red-500/20 text-red-400"
                        : connectionState === "reconnecting"
                          ? "bg-amber-500/20 text-amber-400"
                          : "bg-black/40 text-white/70"
                  }`}
              >
                {statusLabel[connectionState]}
              </span>
              {connectionState === "connected" && (
                <span className="px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-md text-sm font-medium text-white ring-1 ring-white/10 tabular-nums">
                  {elapsed}
                </span>
              )}
            </div>
          </div>
        </div>

        {!remoteStream && connectionState !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 pointer-events-none">
            <div className="w-20 h-20 rounded-full bg-white/10 ring-2 ring-white/10 flex items-center justify-center text-2xl font-semibold text-white/60">
              {remoteLabel.charAt(0).toUpperCase()}
            </div>
            <p className="text-sm text-white/50">
              {isHost ? "Waiting for someone to join…" : "Connecting to host…"}
            </p>
            <p className="text-xs text-white/30">
              {isHost
                ? "Share the invitation link with another person"
                : "This should only take a moment"}
            </p>
          </div>
        )}

        <button
          onClick={() => setSwapped((s) => !s)}
          className="absolute bottom-28 right-4 w-28 sm:w-36 aspect-[3/4] rounded-2xl overflow-hidden ring-2 ring-white/20 shadow-2xl shadow-black/50 bg-slate-900 group transition-all duration-300 hover:ring-white/40 active:scale-95"
          aria-label="Swap views"
        >
          <video
            ref={pipVideoRef}
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover scale-x-[-1]"
          />
          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm text-[10px] text-white font-medium">
            {displayName}
          </span>
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
            <FlipHorizontal2 className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </button>
      </div>

      <div className="shrink-0 px-6 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-fit flex items-center gap-3 sm:gap-4 px-4 py-3 rounded-[2rem] bg-white/10 backdrop-blur-xl ring-1 ring-white/15 shadow-2xl">
          <ControlButton
            active={!muted}
            onClick={() => setMuted((m) => !m)}
            label={muted ? "Unmute" : "Mute"}
            Icon={muted ? MicOff : Mic}
          />
          <ControlButton
            active={videoOn}
            onClick={() => setVideoOn((v) => !v)}
            label={videoOn ? "Turn off camera" : "Turn on camera"}
            Icon={videoOn ? Video : VideoOff}
          />
          <ControlButton
            active
            onClick={() => setSwapped((s) => !s)}
            label="Swap views"
            Icon={FlipHorizontal2}
          />
          <button
            onClick={handleEnd}
            className="w-14 h-14 min-h-[44px] min-w-[44px] rounded-full bg-red-500 hover:bg-red-400 active:scale-95 flex items-center justify-center transition-all duration-150 shadow-lg shadow-red-500/30"
            aria-label="End call"
          >
            <PhoneOff className="w-6 h-6 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface ControlButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

function ControlButton({ active, onClick, label, Icon }: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`w-12 h-12 sm:w-14 sm:h-14 min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center transition-all duration-150 active:scale-95
        ${
          active
            ? "bg-white/15 hover:bg-white/25 text-white"
            : "bg-white/90 hover:bg-white text-slate-900"
        }`}
    >
      <Icon className="w-5 h-5 sm:w-6 sm:h-6" />
    </button>
  );
}
