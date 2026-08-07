import { useCallback, useEffect, useRef, useState } from "react";
import type { IRemoteVideoTrack } from "agora-rtc-sdk-ng";
import {
  AgoraRTC,
  AGORA_APP_ID,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type ILocalTrack,
} from "@/lib/agora";
import type { ConnectionState } from "@/types";

interface UseAgoraClientArgs {
  channel: string;
  isHost: boolean;
  /** For host: a pre-recorded video stream. For guest: camera stream opened manually. */
  localStream: MediaStream | null;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteEnd?: () => void;
  /** Fired when remote user publishes / re-publishes video (for foreground resume). */
  onRemoteVideoUpdate?: () => void;
}

export interface AgoraClient {
  state: ConnectionState;
  error: string | null;
  cleanup: () => void;
  toggleCamera: (on: boolean) => void;
  toggleMic: (on: boolean) => void;
  /** Call this when returning to foreground to resume remote video. */
  resumeRemoteVideo: () => void;
}

const MAX_JOIN_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

/**
 * Wait for a MediaStreamTrack to become "live", polling every 100ms up to
 * maxAttempts. Returns true if the track is live, false on timeout.
 */
async function waitForLiveTrack(
  track: MediaStreamTrack,
  maxAttempts = 50,
): Promise<boolean> {
  if ((track.readyState as string) === "live") return true;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((track.readyState as string) === "live") return true;
  }
  return (track.readyState as string) === "live";
}

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
  const remoteUsersRef = useRef<Map<string, IAgoraRTCRemoteUser>>(new Map());

  // Use refs for callbacks so joinChannel/scheduleRejoin don't depend on them
  // and we avoid stale-closure / circular-dependency issues.
  const onRemoteStreamRef = useRef(onRemoteStream);
  const onRemoteEndRef = useRef(onRemoteEnd);
  const onRemoteVideoUpdateRef = useRef(onRemoteVideoUpdate);

  useEffect(() => {
    onRemoteStreamRef.current = onRemoteStream;
  }, [onRemoteStream]);
  useEffect(() => {
    onRemoteEndRef.current = onRemoteEnd;
  }, [onRemoteEnd]);
  useEffect(() => {
    onRemoteVideoUpdateRef.current = onRemoteVideoUpdate;
  }, [onRemoteVideoUpdate]);

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
    remoteUsersRef.current.clear();
  }, [clearReconnectTimer, cleanupTracks]);

  // Forward declarations via refs so joinChannel and scheduleRejoin can
  // reference each other without a circular useCallback dependency.
  const joinChannelRef = useRef<() => Promise<void>>(async () => {});
  const scheduleRejoinRef = useRef<() => void>(() => {});

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
            remoteUsersRef.current.set(user.uid.toString(), user);
            const stream = new MediaStream();
            stream.addTrack(videoTrack.getMediaStreamTrack());
            onRemoteStreamRef.current?.(stream);
            onRemoteVideoUpdateRef.current?.();
          }
        }
        if (mediaType === "audio") {
          user.audioTrack?.play();
        }
      } catch (err) {
        console.error("[agora] subscribe error", err);
      }
    },
    [],
  );

  // BUG 5: user-unpublished(video) should NOT end the call.
  // Just clear the remote video; keep the call alive.
  const handleRemoteUserUnpublished = useCallback(
    (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      if (mediaType === "video") {
        remoteVideoTrackRef.current = null;
        onRemoteEndRef.current?.();
      }
    },
    [],
  );

  // BUG 5: user-left shows "waiting" — does NOT permanently end.
  // We clear remote video but keep the call alive so the user can wait.
  const handleRemoteUserLeft = useCallback(
    (user: IAgoraRTCRemoteUser) => {
      remoteUsersRef.current.delete(user.uid.toString());
      remoteVideoTrackRef.current = null;
      onRemoteEndRef.current?.();
    },
    [],
  );

  const scheduleRejoin = useCallback(() => {
    if (retryCountRef.current >= MAX_JOIN_RETRIES) {
      console.error("[agora] reconnect failed — max retries exceeded");
      setState("error");
      setError("Unable to reconnect. Please check your network.");
      return;
    }
    retryCountRef.current += 1;
    clearReconnectTimer();
    console.log("[agora] reconnecting — attempt", retryCountRef.current);
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
        joinChannelRef.current();
      }
    }, RETRY_DELAY_MS);
  }, [clearReconnectTimer, cleanupTracks]);

  // Keep the ref in sync so joinChannel can call scheduleRejoin.
  useEffect(() => {
    scheduleRejoinRef.current = scheduleRejoin;
  }, [scheduleRejoin]);

  const joinChannel = useCallback(async () => {
    if (!channelRef.current || !localStreamRef.current) return;
    if (joinedRef.current) return;

    // BUG 1: For host, ensure the stream has an active "live" video track
    // before creating the Agora client or joining the channel.
    if (isHostRef.current) {
      let attempts = 0;
      while (
        localStreamRef.current.getVideoTracks().length === 0 &&
        attempts < 100
      ) {
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
      }
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (!videoTrack) {
        setState("error");
        setError("Video stream not ready. Please try again.");
        return;
      }
      // Verify track.readyState === "live" before proceeding.
      const isLive = await waitForLiveTrack(videoTrack);
      if (!isLive) {
        setState("error");
        setError("Video track is not active. Please try again.");
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

      client.on("connection-state-change", (curState, _prevState, reason) => {
        if (curState === "CONNECTED") {
          console.log("[agora] reconnected");
          setState("connected");
          retryCountRef.current = 0;
        } else if (curState === "RECONNECTING") {
          console.log("[agora] reconnecting");
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
            scheduleRejoinRef.current();
          }
        }
      });

      client.on("exception", (event) => {
        console.warn("[agora] exception", event);
      });

      await client.join(AGORA_APP_ID, channelRef.current, null, null);
      joinedRef.current = true;
      setState("connecting");

      // BUG 1: Before publishing, verify the MediaStreamTrack exists and is
      // readyState === "live". Block publishing and wait if not ready.
      const publishLocalTracks = async () => {
        const stream = localStreamRef.current;
        if (!stream) return;

        const videoMediaTrack = stream.getVideoTracks()[0];
        if (videoMediaTrack) {
          // Wait for the track to be live before creating the Agora track.
          const live = await waitForLiveTrack(videoMediaTrack);
          if (!live) {
            console.warn("[agora] video track not live — skipping publish");
            return;
          }
          const vTrack = AgoraRTC.createCustomVideoTrack({
            mediaStreamTrack: videoMediaTrack,
          });
          videoTrackRef.current = vTrack;
          await client.publish(vTrack);
        }

        const audioMediaTrack = stream.getAudioTracks()[0];
        if (audioMediaTrack) {
          const liveAudio = await waitForLiveTrack(audioMediaTrack, 10);
          if (!liveAudio) {
            console.warn("[agora] audio track not live — skipping publish");
            return;
          }
          const aTrack = AgoraRTC.createCustomAudioTrack({
            mediaStreamTrack: audioMediaTrack,
          });
          audioTrackRef.current = aTrack;
          await client.publish(aTrack);
        }
      };

      await publishLocalTracks();

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
        scheduleRejoinRef.current();
      }
    }
  }, [handleRemoteUserPublished, handleRemoteUserUnpublished, handleRemoteUserLeft, cleanupTracks]);

  // Keep the ref in sync so scheduleRejoin can call joinChannel.
  useEffect(() => {
    joinChannelRef.current = joinChannel;
  }, [joinChannel]);

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
    // Re-emit the remote stream so the video element re-attaches and plays.
    if (remoteVideoTrackRef.current) {
      const stream = new MediaStream();
      stream.addTrack(remoteVideoTrackRef.current.getMediaStreamTrack());
      onRemoteStreamRef.current?.(stream);
      onRemoteVideoUpdateRef.current?.();
    }
  }, []);

  return {
    state,
    error,
    cleanup,
    toggleCamera,
    toggleMic,
    resumeRemoteVideo,
  };
}
