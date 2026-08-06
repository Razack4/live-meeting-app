import { useCallback, useEffect, useRef, useState } from "react";
import Peer, { type DataConnection, type MediaConnection } from "peerjs";

export type PeerStatus =
  | "idle"
  | "initializing"
  | "waiting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

interface UsePeerConnectionArgs {
  roomId: string;
  isHost: boolean;
  localStream: MediaStream | null;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteEnd?: () => void;
}

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:camshow.metered.live:80",
    username: "2bf9d2e7d7c917acd37da4cb",
    credential: "MqqqGjAPwjVbtP1B",
  },
  {
    urls: "turn:camshow.metered.live:443",
    username: "2bf9d2e7d7c917acd37da4cb",
    credential: "MqqqGjAPwjVbtP1B",
  },
  {
    urls: "turn:camshow.metered.live:443?transport=tcp",
    username: "2bf9d2e7d7c917acd37da4cb",
    credential: "MqqqGjAPwjVbtP1B",
  },
];

const HANDSHAKE_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;

/**
 * Manages a PeerJS peer-to-peer connection with Metered TURN servers
 * and auto-retry logic for cross-network signaling.
 */
export function usePeerConnection({
  roomId,
  isHost,
  localStream,
  onRemoteStream,
  onRemoteEnd,
}: UsePeerConnectionArgs) {
  const [status, setStatus] = useState<PeerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const mediaConnRef = useRef<MediaConnection | null>(null);
  const dataConnRef = useRef<DataConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const retryCountRef = useRef(0);
  const handshakeTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const connectedRef = useRef(false);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const clearHandshakeTimer = useCallback(() => {
    if (handshakeTimerRef.current !== null) {
      window.clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearHandshakeTimer();
    clearRetryTimer();
    if (mediaConnRef.current) {
      try {
        mediaConnRef.current.close();
      } catch {
        // ignore
      }
      mediaConnRef.current = null;
    }
    if (dataConnRef.current) {
      try {
        dataConnRef.current.close();
      } catch {
        // ignore
      }
      dataConnRef.current = null;
    }
    if (peerRef.current) {
      try {
        peerRef.current.destroy();
      } catch {
        // ignore
      }
      peerRef.current = null;
    }
    connectedRef.current = false;
    retryCountRef.current = 0;
  }, [clearHandshakeTimer, clearRetryTimer]);

  const sendData = useCallback((data: unknown) => {
    if (dataConnRef.current && dataConnRef.current.open) {
      dataConnRef.current.send(data);
    }
  }, []);

  useEffect(() => {
    if (!roomId || !localStream) return;

    setStatus("initializing");
    setError(null);
    connectedRef.current = false;
    retryCountRef.current = 0;

    const peerId = isHost
      ? roomId
      : `${roomId}-guest-${Math.random().toString(36).slice(2, 8)}`;

    const peer = new Peer(peerId, {
      debug: 2,
      config: {
        iceServers: ICE_SERVERS,
        iceTransportPolicy: "all" as const,
      },
    });
    peerRef.current = peer;

    const handleRemoteStream = (stream: MediaStream) => {
      connectedRef.current = true;
      clearHandshakeTimer();
      clearRetryTimer();
      onRemoteStream?.(stream);
    };

    const startHandshakeTimer = () => {
      clearHandshakeTimer();
      handshakeTimerRef.current = window.setTimeout(() => {
        if (!connectedRef.current) {
          // eslint-disable-next-line no-console
          console.warn("[peer] handshake timed out, retrying…");
          if (retryCountRef.current < MAX_RETRIES) {
            retryCountRef.current += 1;
            setStatus("connecting");
            // Close existing media connection but keep the peer alive
            if (mediaConnRef.current) {
              try {
                mediaConnRef.current.close();
              } catch {
                // ignore
              }
              mediaConnRef.current = null;
            }
            // Retry after short delay
            retryTimerRef.current = window.setTimeout(() => {
              if (!connectedRef.current && peerRef.current && !isHost) {
                // eslint-disable-next-line no-console
                console.log(
                  `[peer] retry #${retryCountRef.current} calling host…`,
                );
                const call = peerRef.current.call(
                  roomId,
                  localStreamRef.current!,
                  {
                    metadata: { type: "media", retry: retryCountRef.current },
                  },
                );
                if (call) {
                  mediaConnRef.current = call;
                  call.on("stream", (remoteStream) => {
                    handleRemoteStream(remoteStream);
                    setStatus("connected");
                  });
                  call.on("error", (err) => {
                    console.error("[peer] retry call error", err);
                  });
                  call.on("close", () => {
                    if (!connectedRef.current) {
                      setStatus("disconnected");
                      onRemoteEnd?.();
                    }
                  });
                }
                startHandshakeTimer();
              }
            }, 1500);
          } else {
            setError(
              "Connection is taking too long. Check your network or try again.",
            );
            setStatus("error");
          }
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };

    // ---- Host: wait for incoming call ----
    peer.on("open", (id) => {
      // eslint-disable-next-line no-console
      console.log("[peer] open as", id);
      setStatus(isHost ? "waiting" : "connecting");

      if (!isHost) {
        // Guest calls the host
        const conn = peer.connect(roomId, { reliable: true });
        dataConnRef.current = conn;
        conn.on("open", () => {
          // eslint-disable-next-line no-console
          console.log("[peer] data channel open (guest)");
        });
        conn.on("data", (data) => {
          if (data === "end") onRemoteEnd?.();
        });
        conn.on("error", (err) => {
          console.error("[peer] data conn error", err);
        });

        const call = peer.call(roomId, localStreamRef.current!, {
          metadata: { type: "media" },
        });
        if (call) {
          mediaConnRef.current = call;
          call.on("stream", (remoteStream) => {
            handleRemoteStream(remoteStream);
            setStatus("connected");
          });
          call.on("error", (err) => {
            // eslint-disable-next-line no-console
            console.error("[peer] call error", err);
            if (!connectedRef.current) {
              setError(
                `Connection failed: ${err.message || err.type || "unknown"}`,
              );
            }
          });
          call.on("close", () => {
            if (!connectedRef.current) {
              setStatus("disconnected");
              onRemoteEnd?.();
            }
          });
        }

        // Start handshake timer for the guest
        startHandshakeTimer();
      }
    });

    // ---- Host: answer incoming call ----
    peer.on("connection", (conn) => {
      // eslint-disable-next-line no-console
      console.log("[peer] incoming data connection");
      dataConnRef.current = conn;
      conn.on("open", () => {
        // eslint-disable-next-line no-console
        console.log("[peer] data channel open (host)");
      });
      conn.on("data", (data) => {
        if (data === "end") onRemoteEnd?.();
      });
      conn.on("close", () => {
        if (!connectedRef.current) {
          setStatus("disconnected");
          onRemoteEnd?.();
        }
      });
    });

    peer.on("call", (call) => {
      // eslint-disable-next-line no-console
      console.log("[peer] incoming media call");
      setStatus("connecting");
      mediaConnRef.current = call;
      call.answer(localStreamRef.current!, {
        sdpTransform: undefined,
      });
      call.on("stream", (remoteStream) => {
        handleRemoteStream(remoteStream);
        setStatus("connected");
      });
      call.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("[peer] answer error", err);
        if (!connectedRef.current) {
          setError(
            `Connection failed: ${err.message || err.type || "unknown"}`,
          );
        }
      });
      call.on("close", () => {
        if (!connectedRef.current) {
          setStatus("disconnected");
          onRemoteEnd?.();
        }
      });
    });

    peer.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[peer] peer error", err);
      const msg =
        err.type === "peer-unavailable"
          ? "The other person isn't in the room yet. Make sure they've opened the invitation link."
          : `Connection error: ${err.message || err.type || "unknown"}`;
      if (err.type === "peer-unavailable") {
        if (!isHost && retryCountRef.current < MAX_RETRIES) {
          // Guest: retry calling the host
          retryCountRef.current += 1;
          setStatus("connecting");
          // eslint-disable-next-line no-console
          console.log(
            `[peer] peer-unavailable, retry #${retryCountRef.current} in 3s…`,
          );
          retryTimerRef.current = window.setTimeout(() => {
            if (
              !connectedRef.current &&
              peerRef.current &&
              localStreamRef.current
            ) {
              const call = peerRef.current.call(
                roomId,
                localStreamRef.current,
                { metadata: { type: "media", retry: retryCountRef.current } },
              );
              if (call) {
                mediaConnRef.current = call;
                call.on("stream", (remoteStream) => {
                  handleRemoteStream(remoteStream);
                  setStatus("connected");
                });
                call.on("error", (e) =>
                  console.error("[peer] retry call error", e),
                );
                call.on("close", () => {
                  if (!connectedRef.current) {
                    setStatus("disconnected");
                    onRemoteEnd?.();
                  }
                });
              }
              startHandshakeTimer();
            }
          }, 3000);
        } else {
          setError(msg);
          setStatus(isHost ? "waiting" : "error");
        }
      } else if (err.type === "network" || err.type === "server-error") {
        // Transient errors — attempt reconnect
        try {
          peer.reconnect();
        } catch {
          // ignore
        }
        if (!connectedRef.current) {
          setStatus(isHost ? "waiting" : "connecting");
        }
      } else {
        setError(msg);
        if (!connectedRef.current) {
          setStatus("error");
        }
      }
    });

    peer.on("disconnected", () => {
      // eslint-disable-next-line no-console
      console.log("[peer] disconnected from signaling server");
      if (!connectedRef.current) {
        setStatus(isHost ? "waiting" : "connecting");
      }
      try {
        peer.reconnect();
      } catch {
        // ignore
      }
    });

    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, isHost, localStream]);

  return { status, error, cleanup, sendData };
}
