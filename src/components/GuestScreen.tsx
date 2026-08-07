import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Phone, Video } from "lucide-react";
import VideoCall from "@/components/VideoCall";
import { useAgoraClient } from "@/hooks/useAgoraClient";
import { FIXED_CHANNEL, type CallStatus, type ConnectionState } from "@/types";
import { supabase } from "@/lib/supabase";

type GuestPhase = "validating" | "incoming" | "connecting" | "active" | "ended";

interface ActiveSession {
  localStream: MediaStream;
  displayName: string;
}

export default function GuestScreen({ accessCode }: { accessCode: string }) {
  const [phase, setPhase] = useState<GuestPhase>("validating");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Validate the access code against Supabase on mount
  useEffect(() => {
    let cancelled = false;

    const validate = async () => {
      console.log("[GUEST] Validating access code:", accessCode);
      try {
        const { data, error: queryError } = await supabase
          .from("calls")
          .select("status, channel_name, host_display_name")
          .eq("access_code", accessCode)
          .maybeSingle();

        if (cancelled) return;

        if (queryError) {
          console.error("[GUEST] Validation query error:", queryError);
          setError("Could not verify the call. Please try again.");
          setPhase("incoming");
          return;
        }

        if (!data) {
          console.warn("[GUEST] No call found for code:", accessCode);
          setError("This call link is not valid.");
          setPhase("incoming");
          return;
        }

        const status = data.status as CallStatus;
        console.log("[GUEST] Call found — status:", status, "channel:", data.channel_name);

        if (status === "ended") {
          console.warn("[GUEST] Call has already ended");
          setPhase("ended");
          return;
        }

        // Call is waiting or active — show the incoming call screen
        setPhase("incoming");
      } catch (err) {
        console.error("[GUEST] Validation failed:", err);
        if (!cancelled) {
          setError("Could not verify the call. Please try again.");
          setPhase("incoming");
        }
      }
    };

    validate();
    return () => {
      cancelled = true;
    };
  }, [accessCode]);

  const handleRemoteStream = useCallback((s: MediaStream) => {
    console.log("[GUEST] Remote stream received from host");
    setRemoteStream(s);
  }, []);

  const handleRemoteEnd = useCallback(() => {
    console.log("[GUEST] Host left — waiting for rejoin");
    setRemoteStream(null);
  }, []);

  const {
    state: connectionState,
    error: agoraError,
    cleanup: agoraCleanup,
    toggleCamera,
    toggleMic,
    resumeRemoteVideo,
  } = useAgoraClient({
    channel: FIXED_CHANNEL,
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
      console.log("[GUEST] Camera stream acquired — tracks:", stream.getTracks().length);
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
    agoraCleanup();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setRemoteStream(null);
    setSession(null);
    setPhase("incoming");
  }, [agoraCleanup]);

  // ---- Ended call screen ----
  if (phase === "ended") {
    return (
      <div className="min-h-dvh bg-black text-white flex flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-[1.6rem] bg-red-500/15 ring-1 ring-red-400/30">
            <Phone className="w-10 h-10 text-red-400 rotate-[135deg]" strokeWidth={2} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Call Ended</h1>
            <p className="mt-2 text-sm text-white/40">
              This call has already ended and can no longer be joined.
            </p>
          </div>
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
        connectionState={connectionState as ConnectionState}
        onEnd={handleEnd}
        onToggleCamera={toggleCamera}
        onToggleMic={toggleMic}
        onResumeRemoteVideo={resumeRemoteVideo}
      />
    );
  }

  // ---- Validating ----
  if (phase === "validating") {
    return (
      <div className="min-h-dvh bg-black text-white flex flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4">
          <span className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          <p className="text-sm text-white/50">Verifying call link…</p>
        </div>
      </div>
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

        {(error || agoraError) && (
          <p className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 ring-1 ring-red-500/20 rounded-xl px-4 py-3 max-w-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {error || agoraError}
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
