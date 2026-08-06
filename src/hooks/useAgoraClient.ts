import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgoraRTC,
  AGORA_APP_ID,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type IMicrophoneAudioTrack,
  type ICameraVideoTrack,
} from "@/lib/agora";
import type { ConnectionState } from "@/types";

interface UseAgoraClientArgs {
  channel: string;
  isHost: boolean;
  /** For host: a pre-recorded video stream. For guest: null (uses real camera). */
  localStream: MediaStream | null;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteEnd?: () => void;
}

export interface AgoraClient {
  state: ConnectionState;
  error: string | null;
  cleanup: () => void;
  toggleCamera: (on: boolean) => void;
  toggleMic: (on: boolean) => void;
}

const MAX_JOIN_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

export function useAgoraClient({
  channel,
  isHost,
  localStream,
  onRemoteStream,
  onRemoteEnd,
}: UseAgoraClientArgs): AgoraClient {
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const audioTrackRef = useRef<IMicrophoneAudioTrack | null>(null);
  const videoTrackRef = useRef<ICameraVideoTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const joinedRef = useRef(false);
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const cleanupTracks = useCallback(() => {
    [audioTrackRef, videoTrackRef].forEach((ref) => {
      if (ref.current) {
        try {
          ref.current.stop();
        } catch {
          // ignore
        }
        ref.current = null;
      }
    });
  }, []);

  const cleanup = useCallback(() => {
    clearReconnectTimer();
    cleanupTracks();
    if (clientRef.current) {
      try {
        clientRef.current.leave();
      } catch {
        // ignore
      }
      clientRef.current = null;
    }
    joinedRef.current = false;
    retryCountRef.current = 0;
  }, [clearReconnectTimer, cleanupTracks]);

  const handleRemoteUserPublished = useCallback(
    async (
      client: IAgoraRTCClient,
      user: IAgoraRTCRemoteUser,
      mediaType: "audio" | "video",
    ) => {
      try {
        await client.subscribe(user, mediaType);
        if (mediaType === "video") {
          const videoTrack = user.videoTrack;
          if (videoTrack) {
            const stream = new MediaStream();
            stream.addTrack(videoTrack.getMediaStreamTrack());
            onRemoteStream?.(stream);
          }
        }
        if (mediaType === "audio") {
          user.audioTrack?.play();
        }
      } catch (err) {
        console.error("[agora] subscribe error", err);
      }
    },
    [onRemoteStream],
  );

  const handleRemoteUserUnpublished = useCallback(
    (_user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      if (mediaType === "video") {
        onRemoteEnd?.();
      }
    },
    [onRemoteEnd],
  );

  const handleRemoteUserLeft = useCallback(() => {
    onRemoteEnd?.();
  }, [onRemoteEnd]);

  const joinChannel = useCallback(async () => {
    if (!channel || !localStreamRef.current) return;
    if (joinedRef.current) return;

    setState("initializing");
    setError(null);

    try {
      if (!mountedRef.current) return;

      const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      clientRef.current = client;

      client.on("user-published", (user, mediaType) => {
        if (mediaType === "audio" || mediaType === "video") {
          handleRemoteUserPublished(client, user, mediaType);
        }
      });
      client.on("user-unpublished", (user, mediaType) => {
        if (mediaType === "audio" || mediaType === "video") {
          handleRemoteUserUnpublished(user, mediaType);
        }
      });
      client.on("user-left", handleRemoteUserLeft);

      client.on("connection-state-change", (curState) => {
        if (curState === "CONNECTED") {
          setState("connected");
        } else if (curState === "RECONNECTING") {
          setState("reconnecting");
        } else if (curState === "DISCONNECTED") {
          setState("disconnected");
        }
      });

      client.on("exception", (event) => {
        console.warn("[agora] exception", event);
      });

      await client.join(AGORA_APP_ID, channel, null, null);
      joinedRef.current = true;
      setState("connecting");

      if (isHost) {
        // Host: publish video from the pre-recorded stream
        const videoMediaTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoMediaTrack) {
          const vTrack = AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: videoMediaTrack,
          });
          videoTrackRef.current = vTrack as unknown as ICameraVideoTrack;
          await client.publish(vTrack);
        }
      } else {
        // Guest: use real camera + microphone
        const [micTrack, camTrack] =
          await AgoraRTC.createMicrophoneAndCameraTracks();
        audioTrackRef.current = micTrack;
        videoTrackRef.current = camTrack;
        await client.publish([micTrack, camTrack]);
      }

      if (mountedRef.current) {
        setState("connected");
        retryCountRef.current = 0;
      }
    } catch (err) {
      console.error("[agora] join failed", err);
      if (!mountedRef.current) return;

      const msg =
        err instanceof Error ? err.message : "Failed to join call";
      setError(msg);
      setState("error");

      // Auto-retry for transient failures
      if (retryCountRef.current < MAX_JOIN_RETRIES) {
        retryCountRef.current += 1;
        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          if (mountedRef.current && !joinedRef.current) {
            // Clean up any partial state before retrying
            cleanupTracks();
            if (clientRef.current) {
              try {
                clientRef.current.leave();
              } catch {
                // ignore
              }
              clientRef.current = null;
            }
            joinChannel();
          }
        }, RETRY_DELAY_MS);
      }
    }
  }, [
    channel,
    isHost,
    handleRemoteUserPublished,
    handleRemoteUserUnpublished,
    handleRemoteUserLeft,
    clearReconnectTimer,
    cleanupTracks,
  ]);

  useEffect(() => {
    if (!channel || !localStream) return;

    joinChannel();

    // Detect network recovery and trigger rejoin if needed
    const handleOnline = () => {
      if (mountedRef.current && !joinedRef.current && clientRef.current === null) {
        retryCountRef.current = 0;
        joinChannel();
      }
    };
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, localStream]);

  const toggleCamera = useCallback((on: boolean) => {
    if (videoTrackRef.current) {
      videoTrackRef.current.setEnabled(on);
    }
  }, []);

  const toggleMic = useCallback((on: boolean) => {
    if (audioTrackRef.current) {
      audioTrackRef.current.setEnabled(on);
    }
  }, []);

  return { state, error, cleanup, toggleCamera, toggleMic };
}
