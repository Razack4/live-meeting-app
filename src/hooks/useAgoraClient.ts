import { useCallback, useEffect, useRef, useState } from "react";
import type { IRemoteVideoTrack } from "agora-rtc-sdk-ng";
import {
  AgoraRTC,
  AGORA_APP_ID,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type IMicrophoneAudioTrack,
  type ICameraVideoTrack,
  type ILocalTrack,
} from "@/lib/agora";
import type { ConnectionState } from "@/types";

interface UseAgoraClientArgs {
  channel: string;
  isHost: boolean;
  localStream: MediaStream | null;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteEnd?: () => void;
  onRemoteVideoUpdate?: () => void;
}

export interface AgoraClient {
  state: ConnectionState;
  error: string | null;
  cleanup: () => void;
  toggleCamera: (on: boolean) => void;
  toggleMic: (on: boolean) => void;
  resumeRemoteVideo: () => void;
}

const MAX_JOIN_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

export function useAgoraClient({
  channel,
  isHost,
  localStream,
  onRemoteStream,
  onRemoteEnd,
  onRemoteVideoUpdate,
}: UseAgoraClientArgs): AgoraClient {
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const audioTrackRef = useRef<ILocalTrack | null>(null);
  const videoTrackRef = useRef<ILocalTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const joinedRef = useRef(false);
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const channelRef = useRef(channel);
  const isHostRef = useRef(isHost);
  const remoteVideoTrackRef = useRef<IRemoteVideoTrack | null>(null);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

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
    remoteVideoTrackRef.current = null;
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
            remoteVideoTrackRef.current = videoTrack;
            const stream = new MediaStream();
            stream.addTrack(videoTrack.getMediaStreamTrack());
            onRemoteStream?.(stream);
            onRemoteVideoUpdate?.();
          }
        }
        if (mediaType === "audio") {
          user.audioTrack?.play();
        }
      } catch (err) {
        console.error("[agora] subscribe error", err);
      }
    },
    [onRemoteStream, onRemoteVideoUpdate],
  );

  const handleRemoteUserUnpublished = useCallback(
    (_user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      if (mediaType === "video") {
        remoteVideoTrackRef.current = null;
        onRemoteEnd?.();
      }
    },
    [onRemoteEnd],
  );

  const handleRemoteUserLeft = useCallback(() => {
    remoteVideoTrackRef.current = null;
    onRemoteEnd?.();
  }, [onRemoteEnd]);

  const joinChannel = useCallback(async () => {
    if (!channel || !localStreamRef.current) return;
    if (joinedRef.current) return;

    if (isHostRef.current) {
      let attempts = 0;
      while (
        localStreamRef.current.getVideoTracks().length === 0 &&
        attempts < 50
      ) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }
      if (localStreamRef.current.getVideoTracks().length === 0) {
        setState("error");
        setError("Video stream not ready. Please try again.");
        return;
      }
    }

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

      client.on("connection-state-change", (curState, prevState, reason) => {
        if (curState === "CONNECTED") {
          setState("connected");
          retryCountRef.current = 0;
        } else if (curState === "RECONNECTING") {
          setState("reconnecting");
        } else if (curState === "DISCONNECTED") {
          console.warn("[agora] DISCONNECTED", reason);
          setState("reconnecting");
          if (mountedRef.current && joinedRef.current) {
            joinedRef.current = false;
            cleanupTracks();
            if (clientRef.current) {
              try {
                clientRef.current.leave();
              } catch {
                // ignore
              }
              clientRef.current = null;
            }
            scheduleRejoin();
          }
        }
      });

      client.on("exception", (event) => {
        console.warn("[agora] exception", event);
      });

      await client.join(AGORA_APP_ID, channel, null, null);
      joinedRef.current = true;
      setState("connecting");

      if (isHostRef.current) {
        const videoMediaTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoMediaTrack) {
          const vTrack = AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: videoMediaTrack,
          });
          videoTrackRef.current = vTrack;
          await client.publish(vTrack);
        }
        const audioMediaTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioMediaTrack) {
          const aTrack = AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: audioMediaTrack,
          });
          audioTrackRef.current = aTrack;
          await client.publish(aTrack);
        }
      } else {
        const videoMediaTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoMediaTrack) {
          const vTrack = AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: videoMediaTrack,
          });
          videoTrackRef.current = vTrack;
          await client.publish(vTrack);
        }
        const audioMediaTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioMediaTrack) {
          const aTrack = AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: audioMediaTrack,
          });
          audioTrackRef.current = aTrack;
          await client.publish(aTrack);
        }
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

      if (retryCountRef.current < MAX_JOIN_RETRIES) {
        scheduleRejoin();
      }
    }
  }, [
    channel,
    handleRemoteUserPublished,
    handleRemoteUserUnpublished,
    handleRemoteUserLeft,
    clearReconnectTimer,
    cleanupTracks,
  ]);

  const scheduleRejoin = useCallback(() => {
    if (retryCountRef.current >= MAX_JOIN_RETRIES) {
      setState("error");
      setError("Unable to reconnect. Please check your network.");
      return;
    }
    retryCountRef.current += 1;
    clearReconnectTimer();
    reconnectTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current && !joinedRef.current) {
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
  }, [clearReconnectTimer, cleanupTracks, joinChannel]);

  useEffect(() => {
    if (!channel || !localStream) return;

    joinChannel();

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
      (videoTrackRef.current as { setEnabled: (v: boolean) => void }).setEnabled(on);
    }
  }, []);

  const toggleMic = useCallback((on: boolean) => {
    if (audioTrackRef.current) {
      (audioTrackRef.current as { setEnabled: (v: boolean) => void }).setEnabled(on);
    }
  }, []);

  const resumeRemoteVideo = useCallback(() => {
    if (remoteVideoTrackRef.current) {
      const stream = new MediaStream();
      stream.addTrack(remoteVideoTrackRef.current.getMediaStreamTrack());
      onRemoteStream?.(stream);
      onRemoteVideoUpdate?.();
    }
  }, [onRemoteStream, onRemoteVideoUpdate]);

  return {
    state,
    error,
    cleanup,
    toggleCamera,
    toggleMic,
    resumeRemoteVideo,
  };
}
