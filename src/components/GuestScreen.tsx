import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Phone, PhoneOff, Video } from "lucide-react";
import VideoCall from "@/components/VideoCall";
import { usePeerConnection } from "@/hooks/usePeerConnection";
import type { PeerStatus } from "@/hooks/usePeerConnection";

type GuestPhase = "incoming" | "connecting" | "active" | "ended";

interface ActiveSession {
  localStream: MediaStream;
  displayName: string;
}

export default function GuestScreen({ roomId }: { roomId: string }) {
  const [phase, setPhase] = useState<GuestPhase>(() => {
    try {
      return localStorage.getItem(`call_ended_${roomId}`) === "true"
        ? "ended"
        : "incoming";
    } catch {
      return "incoming";
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const handleRemoteStream = useCallback((s: MediaStream) => {
    setRemoteStream(s);
  }, []);

  const handleRemoteEnd = useCallback(() => {
    setRemoteStream(null);
    try {
      localStorage.setItem(`call_ended_${roomId}`, "true");
    } catch {
      // localStorage may be unavailable in private browsing
    }
    setPhase("ended");
  }, [roomId]);

  const { status: peerStatus, cleanup: peerCleanup } = usePeerConnection({
    roomId: session ? roomId : "",
    isHost: false,
    localStream: session?.localStream ?? null,
    onRemoteStream: handleRemoteStream,
    onRemoteEnd: handleRemoteEnd,
  });

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleJoin = async () => {
    setError(null);
    setPhase("connecting");

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera API is not available in this browser.");
      setPhase("incoming");
      return;
    }

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      setSession({ localStream: stream, displayName: "You" });
      setPhase("active");
    } catch (err) {
      const e = err as DOMException;
      if (e.name === "NotAllowedError" || e.name === "SecurityError") {
        setError("Camera access was denied. Please allow it to join the call.");
      } else if (e.name === "NotFoundError" || e.name === "OverconstrainedError") {
        setError("No camera device was found on this machine.");
      } else {
        setError(`Unable to access camera: ${e.message || e.name}`);
      }
      setPhase("incoming");
    }
  };

  const handleEnd = useCallback(() => {
    peerCleanup();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setRemoteStream(null);
    setSession(null);
    try {
      localStorage.setItem(`call_ended_${roomId}`, "true");
    } catch {
      // localStorage may be unavailable in private browsing
    }
    setPhase("ended");
  }, [peerCleanup, roomId]);

  // ---- Ended screen (non-interactive) ----
  if (phase === "ended") {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center gap-6">
        <div className="w-20 h-20 rounded-full bg-white/5 ring-1 ring-white/10 flex items-center justify-center">
          <PhoneOff className="w-9 h-9 text-white/40" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Call Ended
          </h1>
          <p className="mt-2 text-sm text-white/40">Appel terminé</p>
        </div>
      </div>
    );
  }

  // ---- Active call ----
  if (phase === "active" && session) {
    return (
      <VideoCall
        localStream={session.localStream}
        remoteStream={remoteStream}
        displayName={session.displayName}
        remoteLabel="Host"
        isHost={false}
        peerStatus={peerStatus}
        onEnd={handleEnd}
      />
    );
  }

  // ---- Incoming call screen ----
  return (
    <div className="min-h-dvh bg-black text-white flex flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-8">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-[1.6rem] bg-emerald-500/15 ring-1 ring-emerald-400/30">
          <Video className="w-10 h-10 text-emerald-400" strokeWidth={2} />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Incoming FaceTime Call…
          </h1>
          <p className="mt-2 text-sm text-white/40">
            Someone is inviting you to a video call
          </p>
        </div>

        {error && (
          <p className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 ring-1 ring-red-500/20 rounded-xl px-4 py-3 max-w-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <button
          onClick={handleJoin}
          disabled={phase === "connecting"}
          className="w-20 h-20 rounded-full bg-emerald-500 hover:bg-emerald-400 active:scale-95 flex items-center justify-center transition-all duration-200 shadow-lg shadow-emerald-500/30 disabled:opacity-50"
          aria-label="Join call"
        >
          {phase === "connecting" ? (
            <span className="w-8 h-8 border-2 border-black/30 border-t-black rounded-full animate-spin" />
          ) : (
            <Phone className="w-9 h-9 text-black" fill="currentColor" />
          )}
        </button>

        <p className="text-xs text-white/30">
          {phase === "connecting" ? "Requesting camera…" : "Tap to join"}
        </p>
      </div>
    </div>
  );
}
