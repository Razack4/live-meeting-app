import { useCallback, useEffect, useRef, useState } from "react";
import type { IRemoteVideoTrack } from "agora-rtc-sdk-ng";
import {
  AgoraRTC,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type ILocalTrack,
} from "@/lib/agora";
import { fetchAgoraToken } from "@/lib/agoraToken";
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

const MAX_JOIN_RETRIES = 20;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

function generateUid(): number {
  // Agora UIDs are uint32. Use 1–999,999,999 to avoid 0 (auto-assign)
  // and collisions between host and guest.
  return Math.floor(Math.random() * 999_999_999) + 1;
}

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return base + Math.random() * 1000;
}

/**
 * Wait for a MediaStreamTrack to become "live", polling every 100ms up to
 * maxAttempts. Returns true if the track is live, false on timeout.
 */
async function waitForLiveTrack(
  track: MediaStreamTrack,
  maxAttempts = 50,
): Promise<boolean> {
  if ((track.readyState as string) === "live") return true;
  if ((track.readyState as string) === "ended") return false;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((track.readyState as string) === "live") return true;
    if ((track.readyState as string) === "ended") return false;
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
  const tokenRenewalTimerRef = useRef<number | null>(null);
  const uidRef = useRef<number>(generateUid());

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

  const clearTokenRenewalTimer = useCallback(() => {
    if (tokenRenewalTimerRef.current !== null) {
      window.clearTimeout(tokenRenewalTimerRef.current);
      tokenRenewalTimerRef.current = null;
    }
  }, []);

  // Clear track refs WITHOUT stopping underlying MediaStreamTracks.
  // Used during reconnection so tracks stay alive for re-publishing.
  const detachTracks = useCallback(() => {
    videoTrackRef.current = null;
    audioTrackRef.current = null;
    remoteVideoTrackRef.current = null;
  }, []);

  // Stop and clear all tracks. Used when the user ends the call.
  const destroyTracks = useCallback(() => {
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
    clearTokenRenewalTimer();
    destroyTracks();
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
  }, [clearReconnectTimer, clearTokenRenewalTimer, destroyTracks]);

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

  // user-unpublished(video) should NOT end the call.
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

  // user-left shows "waiting" — does NOT permanently end.
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
    const delay = getRetryDelay(retryCountRef.current);
    console.log(
      "[agora] reconnecting — attempt",
      retryCountRef.current,
      "in",
      Math.round(delay),
      "ms",
    );
    reconnectTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current && !joinedRef.current) {
        detachTracks();
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
    }, delay);
  }, [clearReconnectTimer, detachTracks]);

  // Keep the ref in sync so joinChannel can call scheduleRejoin.
  useEffect(() => {
    scheduleRejoinRef.current = scheduleRejoin;
  }, [scheduleRejoin]);

  const joinChannel = useCallback(async () => {
    if (!channelRef.current || !localStreamRef.current) return;
    if (joinedRef.current) return;

    // For host, ensure the stream has an active "live" video track
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
            detachTracks();
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

      client.on("token-privilege-will-expire", async () => {
        console.log("[agora] token-privilege-will-expire, renewing…");
        try {
          const renewal = await fetchAgoraToken(channelRef.current, uidRef.current);
          await client.renewToken(renewal.token);
          console.log("[agora] token renewed via will-expire event");
        } catch (err) {
          console.warn("[agora] token renewal (will-expire) failed", err);
        }
      });

      client.on("token-privilege-did-expire", async () => {
        console.warn("[agora] token expired, attempting renewal…");
        try {
          const renewal = await fetchAgoraToken(channelRef.current, uidRef.current);
          await client.renewToken(renewal.token);
          console.log("[agora] token renewed after expiry");
        } catch (err) {
          console.warn("[agora] token renewal (did-expire) failed", err);
        }
      });

      // Fetch a valid RTC token from the server before joining.
      // The Agora project has App Certificate enabled, so a static null
      // token triggers CAN_NOT_GET_GATEWAY_SERVER ("dynamic use static key").
      const uid = uidRef.current;
      console.log("[agora] joining channel:", channelRef.current, "uid:", uid, "isHost:", isHostRef.current);
      let tokenData;
      try {
        tokenData = await fetchAgoraToken(channelRef.current, uid);
      } catch (tokenErr) {
        console.error("[agora] token fetch failed", tokenErr);
        throw new Error(
          "Could not authenticate with the call service. Please try again.",
        );
      }

      // Use the exact UID + channel the token was generated for.
      await client.join(
        tokenData.appId,
        tokenData.channelName,
        tokenData.token,
        tokenData.uid,
      );
      joinedRef.current = true;
      setState("connecting");

      // Schedule token renewal 5 minutes before expiry
      const msUntilExpiry = (tokenData.expireTs - Math.floor(Date.now() / 1000)) * 1000;
      const renewIn = Math.max(msUntilExpiry - 300_000, 60_000);
      clearTokenRenewalTimer();
      tokenRenewalTimerRef.current = window.setTimeout(async () => {
        if (!joinedRef.current || !clientRef.current) return;
        try {
          const renewal = await fetchAgoraToken(channelRef.current, uidRef.current);
          await clientRef.current.renewToken(renewal.token);
          console.log("[agora] token renewed");
        } catch (err) {
          console.warn("[agora] token renewal failed", err);
        }
      }, renewIn);

      // Before publishing, verify the MediaStreamTrack exists and is
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

      if (retryCountRef.current < MAX_JOIN_RETRIES) {
        setState("reconnecting");
        scheduleRejoinRef.current();
      } else {
        const msg =
          err instanceof Error ? err.message : "Failed to join call";
        setError(msg);
        setState("error");
      }
    }
  }, [handleRemoteUserPublished, handleRemoteUserUnpublished, handleRemoteUserLeft, detachTracks, clearTokenRenewalTimer]);

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
