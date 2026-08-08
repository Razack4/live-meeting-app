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
  return Math.floor(Math.random() * 999_999_999) + 1;
}

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return base + Math.random() * 1000;
}

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
  const role = isHost ? "HOST" : "GUEST";
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const audioTrackRef = useRef<ILocalTrack | null>(null);
  const videoTrackRef = useRef<ILocalTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const joinedRef = useRef(false);
  const joiningRef = useRef(false);
  const joinGenerationRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const channelRef = useRef(channel);
  const isHostRef = useRef(isHost);
  const remoteVideoTrackRef = useRef<IRemoteVideoTrack | null>(null);
  const remoteUsersRef = useRef<Map<string, IAgoraRTCRemoteUser>>(new Map());
  const tokenRenewalTimerRef = useRef<number | null>(null);
  const uidRef = useRef<number>(generateUid());
  const streamWaitTimerRef = useRef<number | null>(null);

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

  const detachTracks = useCallback(() => {
    videoTrackRef.current = null;
    audioTrackRef.current = null;
    remoteVideoTrackRef.current = null;
  }, []);

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
    // Invalidate any in-flight join so it cannot install itself as active.
    joinGenerationRef.current += 1;
    joiningRef.current = false;
    intentionalDisconnectRef.current = true;
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

  const joinChannelRef = useRef<() => Promise<void>>(async () => {});
  const scheduleRejoinRef = useRef<() => void>(() => {});

  const handleRemoteUserPublished = useCallback(
    async (
      client: IAgoraRTCClient,
      user: IAgoraRTCRemoteUser,
      mediaType: "audio" | "video",
    ) => {
      console.log(`[${role}] subscribe — uid: ${user.uid}, mediaType: ${mediaType}`);
      try {
        await client.subscribe(user, mediaType);
        console.log(`[${role}] subscribe SUCCESS — uid: ${user.uid}, mediaType: ${mediaType}`);
        if (mediaType === "video") {
          const videoTrack = user.videoTrack;
          if (videoTrack) {
            remoteVideoTrackRef.current = videoTrack;
            remoteUsersRef.current.set(user.uid.toString(), user);
            const stream = new MediaStream();
            stream.addTrack(videoTrack.getMediaStreamTrack());
            console.log(`[${role}] remote video track attached, calling onRemoteStream`);
            onRemoteStreamRef.current?.(stream);
            onRemoteVideoUpdateRef.current?.();
          } else {
            console.warn(`[${role}] user.videoTrack is null after subscribe`);
          }
        }
        if (mediaType === "audio") {
          user.audioTrack?.play();
          console.log(`[${role}] remote audio track playing`);
        }
      } catch (err) {
        console.error(`[${role}] subscribe FAILED — uid: ${user.uid}, mediaType: ${mediaType}, error:`, err);
      }
    },
    [role],
  );

  const handleRemoteUserUnpublished = useCallback(
    (user: IAgoraRTCRemoteUser, mediaType: "audio" | "video") => {
      console.log(`[${role}] user-unpublished — uid: ${user.uid}, mediaType: ${mediaType}`);
      if (mediaType === "video") {
        remoteVideoTrackRef.current = null;
        onRemoteEndRef.current?.();
      }
    },
    [role],
  );

  const handleRemoteUserLeft = useCallback(
    (user: IAgoraRTCRemoteUser) => {
      console.log(`[${role}] user-left — uid: ${user.uid}`);
      remoteUsersRef.current.delete(user.uid.toString());
      remoteVideoTrackRef.current = null;
      onRemoteEndRef.current?.();
    },
    [role],
  );

  const scheduleRejoin = useCallback(() => {
    if (intentionalDisconnectRef.current) {
      console.log(`[${role}] scheduleRejoin aborted — intentional disconnect`);
      return;
    }
    if (retryCountRef.current >= MAX_JOIN_RETRIES) {
      console.error(`[${role}] reconnect FAILED — max retries exceeded`);
      setState("error");
      setError("Unable to reconnect. Please check your network.");
      return;
    }
    retryCountRef.current += 1;
    clearReconnectTimer();
    const delay = getRetryDelay(retryCountRef.current);
    console.log(`[${role}] reconnecting — attempt ${retryCountRef.current} in ${Math.round(delay)}ms`);
    reconnectTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current && !joinedRef.current && !joiningRef.current) {
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
  }, [clearReconnectTimer, detachTracks, role]);

  useEffect(() => {
    scheduleRejoinRef.current = scheduleRejoin;
  }, [scheduleRejoin]);

  const joinChannel = useCallback(async () => {
    if (!channelRef.current || !localStreamRef.current) {
      console.warn(`[${role}] join aborted — missing channel or localStream`);
      return;
    }
    if (joinedRef.current) {
      console.warn(`[${role}] join aborted — already joined`);
      return;
    }
    if (joiningRef.current) {
      console.warn(`[${role}] join aborted — join already in progress`);
      return;
    }

    // For host, ensure the stream has an active "live" video track before joining.
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
        console.error(`[${role}] no video track in stream`);
        setState("error");
        setError("Video stream not ready. Please try again.");
        return;
      }
      const isLive = await waitForLiveTrack(videoTrack);
      if (!isLive) {
        console.error(`[${role}] video track not live`);
        setState("error");
        setError("Video track is not active. Please try again.");
        return;
      }
      console.log(`[${role}] video track is live, proceeding`);
    }

    // Acquire the join guard and assign a generation for this attempt.
    joiningRef.current = true;
    const generation = joinGenerationRef.current;
    intentionalDisconnectRef.current = false;

    setState("initializing");
    setError(null);

    const guardStillValid = () =>
      mountedRef.current &&
      joinGenerationRef.current === generation &&
      !joinedRef.current;

    try {
      if (!mountedRef.current) {
        joiningRef.current = false;
        return;
      }

      const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      clientRef.current = client;
      console.log(`[${role}] Agora client created (gen ${generation})`);

      client.on("user-joined", (user) => {
        console.log(`[${role}] user-joined — uid: ${user.uid}`);
      });
      client.on("user-published", (user, mediaType) => {
        if (clientRef.current !== client) return;
        console.log(`[${role}] user-published — uid: ${user.uid}, mediaType: ${mediaType}`);
        if (mediaType === "audio" || mediaType === "video") {
          handleRemoteUserPublished(client, user, mediaType);
        }
      });
      client.on("user-unpublished", (user, mediaType) => {
        if (clientRef.current !== client) return;
        console.log(`[${role}] user-unpublished — uid: ${user.uid}, mediaType: ${mediaType}`);
        if (mediaType === "audio" || mediaType === "video") {
          handleRemoteUserUnpublished(user, mediaType);
        }
      });
      client.on("user-left", (user) => {
        if (clientRef.current !== client) return;
        console.log(`[${role}] user-left — uid: ${user.uid}`);
        handleRemoteUserLeft(user);
      });

      client.on("connection-state-change", (curState, _prevState, reason) => {
        if (clientRef.current !== client) return;
        console.log(`[${role}] connection-state-change — state: ${curState}, reason: ${reason}`);
        if (curState === "CONNECTED") {
          setState("connected");
          retryCountRef.current = 0;
        } else if (curState === "RECONNECTING") {
          setState("reconnecting");
        } else if (curState === "DISCONNECTED") {
          // If we initiated this disconnect (cleanup/leave), do NOT rejoin.
          if (intentionalDisconnectRef.current) {
            console.log(`[${role}] DISCONNECTED is intentional — skipping rejoin`);
            return;
          }
          // Genuine unexpected disconnection — attempt rejoin.
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
        console.warn(`[${role}] Agora exception:`, event);
      });

      client.on("token-privilege-will-expire", async () => {
        console.log(`[${role}] token-privilege-will-expire, renewing…`);
        try {
          const renewal = await fetchAgoraToken(channelRef.current, uidRef.current);
          await client.renewToken(renewal.token);
          console.log(`[${role}] token renewed via will-expire event`);
        } catch (err) {
          console.warn(`[${role}] token renewal (will-expire) failed:`, err);
        }
      });

      client.on("token-privilege-did-expire", async () => {
        console.warn(`[${role}] token expired, attempting renewal…`);
        try {
          const renewal = await fetchAgoraToken(channelRef.current, uidRef.current);
          await client.renewToken(renewal.token);
          console.log(`[${role}] token renewed after expiry`);
        } catch (err) {
          console.warn(`[${role}] token renewal (did-expire) failed:`, err);
        }
      });

      // Fetch RTC token from the edge function.
      const uid = uidRef.current;
      console.log(`[${role}] channel: ${channelRef.current}, uid: ${uid}`);
      console.log(`[${role}] requesting token…`);
      let tokenData;
      try {
        tokenData = await fetchAgoraToken(channelRef.current, uid);
        console.log(`[${role}] token received — appId: ${tokenData.appId}, channel: ${tokenData.channelName}, uid: ${tokenData.uid}, expireTs: ${tokenData.expireTs}`);
      } catch (tokenErr) {
        console.error(`[${role}] token fetch FAILED:`, tokenErr);
        throw new Error("Could not authenticate with the call service. Please try again.");
      }

      if (!guardStillValid()) {
        console.log(`[${role}] join aborted — stale generation after token fetch`);
        joiningRef.current = false;
        try { client.leave(); } catch {}
        return;
      }

      console.log(`[${role}] joining channel: ${tokenData.channelName}, uid: ${tokenData.uid}`);
      await client.join(
        tokenData.appId,
        tokenData.channelName,
        tokenData.token,
        tokenData.uid,
      );

      if (!guardStillValid()) {
        console.log(`[${role}] join aborted — stale generation after join`);
        joiningRef.current = false;
        try { client.leave(); } catch {}
        return;
      }

      joinedRef.current = true;
      joiningRef.current = false;
      console.log(`[${role}] join SUCCESS — channel: ${tokenData.channelName}, uid: ${tokenData.uid}`);
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
          console.log(`[${role}] token renewed (scheduled)`);
        } catch (err) {
          console.warn(`[${role}] token renewal (scheduled) failed:`, err);
        }
      }, renewIn);

      // Publish local tracks — video and audio independently.
      const publishLocalTracks = async () => {
        const stream = localStreamRef.current;
        if (!stream) {
          console.warn(`[${role}] no local stream — skipping publish`);
          return;
        }

        const stillActive = () =>
          mountedRef.current &&
          joinGenerationRef.current === generation &&
          clientRef.current === client;

        const published: string[] = [];

        const videoMediaTrack = stream.getVideoTracks()[0];
        if (videoMediaTrack) {
          const live = await waitForLiveTrack(videoMediaTrack);
          if (!live) {
            console.warn(`[${role}] video track not live — skipping video publish`);
          } else if (!stillActive()) {
            console.log(`[${role}] stale generation after video track check — skipping publish`);
            return;
          } else {
            const vTrack = AgoraRTC.createCustomVideoTrack({
              mediaStreamTrack: videoMediaTrack,
            });
            videoTrackRef.current = vTrack;
            await client.publish(vTrack);
            published.push("video");
            console.log(`[${role}] publish SUCCESS — video track published`);
          }
        } else {
          console.warn(`[${role}] no video track in stream`);
        }

        const audioMediaTrack = stream.getAudioTracks()[0];
        if (audioMediaTrack) {
          const liveAudio = await waitForLiveTrack(audioMediaTrack, 10);
          if (!liveAudio) {
            console.warn(`[${role}] audio track not live — skipping audio publish`);
          } else if (!stillActive()) {
            console.log(`[${role}] stale generation after audio track check — skipping publish`);
            if (videoTrackRef.current) {
              try { videoTrackRef.current.stop(); } catch {}
              videoTrackRef.current = null;
            }
            return;
          } else {
            const aTrack = AgoraRTC.createCustomAudioTrack({
              mediaStreamTrack: audioMediaTrack,
            });
            audioTrackRef.current = aTrack;
            await client.publish(aTrack);
            published.push("audio");
            console.log(`[${role}] publish SUCCESS — audio track published`);
          }
        } else {
          console.warn(`[${role}] no audio track in stream`);
        }

        console.log(`[${role}] publish complete — tracks: ${published.length ? published.join(", ") : "none"}`);
      };

      await publishLocalTracks();

      if (mountedRef.current && clientRef.current === client) {
        setState("connected");
        retryCountRef.current = 0;
        console.log(`[${role}] state: connected`);
      }
    } catch (err) {
      console.error(`[${role}] join FAILED:`, err);
      joiningRef.current = false;

      if (!mountedRef.current) return;

      if (retryCountRef.current < MAX_JOIN_RETRIES) {
        setState("reconnecting");
        scheduleRejoinRef.current();
      } else {
        const msg = err instanceof Error ? err.message : "Failed to join call";
        setError(msg);
        setState("error");
      }
    }
  }, [handleRemoteUserPublished, handleRemoteUserUnpublished, handleRemoteUserLeft, detachTracks, clearTokenRenewalTimer, role]);

  useEffect(() => {
    joinChannelRef.current = joinChannel;
  }, [joinChannel]);

  // Fix 1: Main connection effect depends on [channel] only, NOT localStream.
  // localStreamRef is kept in sync by a separate effect, so the Agora client
  // is never torn down and recreated merely because the MediaStream object
  // identity changed.
  useEffect(() => {
    if (!channel) return;

    // Wait until a local stream is available before joining.
    const startJoin = () => {
      if (!localStreamRef.current) {
        const id = window.setTimeout(startJoin, 100);
        streamWaitTimerRef.current = id;
        return;
      }
      joinChannel();
    };
    startJoin();

    const handleOnline = () => {
      if (mountedRef.current && !joinedRef.current && !joiningRef.current && clientRef.current === null) {
        retryCountRef.current = 0;
        joinChannel();
      }
    };
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
      if (streamWaitTimerRef.current !== null) {
        window.clearTimeout(streamWaitTimerRef.current);
        streamWaitTimerRef.current = null;
      }
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Fix 1 (cont.): When the local stream changes and we already have an active
  // client with published tracks, replace the published tracks in-place instead
  // of tearing down and rejoining. If not yet joined, just update the ref (the
  // main effect's startJoin loop will pick it up).
  useEffect(() => {
    localStreamRef.current = localStream;

    // If we have an active client with published video track, replace it.
    if (clientRef.current && joinedRef.current && videoTrackRef.current && localStream) {
      const newVideoTrack = localStream.getVideoTracks()[0];
      const oldTrack = videoTrackRef.current as unknown as { replaceTrack: (track: MediaStreamTrack, stopOldTrack: boolean) => Promise<void>; getMediaStreamTrack: () => MediaStreamTrack };
      if (newVideoTrack && oldTrack.getMediaStreamTrack() !== newVideoTrack) {
        (async () => {
          try {
            await oldTrack.replaceTrack(newVideoTrack, true);
            console.log(`[${role}] replaced video track in-place`);
          } catch (err) {
            console.warn(`[${role}] in-place track replace failed, leaving as-is:`, err);
          }
        })();
      }
    }
  }, [localStream, role]);

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
