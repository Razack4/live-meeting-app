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

/**
 * Manages a PeerJS peer-to-peer connection.
 *
 * Host: creates a Peer with the roomId as its ID and waits for an incoming
 * media call from the guest. When the guest's media call arrives, it answers
 * with the host's local stream (the captured pre-recorded video).
 *
 * Guest: creates a Peer with a random ID and, once the host peer is open, calls
 * the host's roomId, sending the guest's live camera stream.
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

  // Keep the ref current so the host's call handler sees the latest stream.
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const cleanup = useCallback(() => {
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
  }, []);

  const sendData = useCallback((data: unknown) => {
    if (dataConnRef.current && dataConnRef.current.open) {
      dataConnRef.current.send(data);
    }
  }, []);

  useEffect(() => {
    if (!roomId || !localStream) return;

    setStatus("initializing");
    setError(null);

    const peerId = isHost ? roomId : `${roomId}-guest-${Math.random().toString(36).slice(2, 8)}`;
    const peer = new Peer(peerId, {
      debug: 1,
    });
    peerRef.current = peer;

    const handleRemoteStream = (stream: MediaStream) => {
      onRemoteStream?.(stream);
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

        const call = peer.call(roomId, localStreamRef.current!, {
          metadata: { type: "media" },
        });
        mediaConnRef.current = call;
        call.on("stream", (remoteStream) => {
          handleRemoteStream(remoteStream);
          setStatus("connected");
        });
        call.on("error", (err) => {
          // eslint-disable-next-line no-console
          console.error("[peer] call error", err);
          setError(`Connection failed: ${err.message || err.type || "unknown"}`);
          setStatus("error");
        });
        call.on("close", () => {
          setStatus("disconnected");
          onRemoteEnd?.();
        });
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
        setStatus("disconnected");
        onRemoteEnd?.();
      });
    });

    peer.on("call", (call) => {
      // eslint-disable-next-line no-console
      console.log("[peer] incoming media call");
      setStatus("connecting");
      mediaConnRef.current = call;
      call.answer(localStreamRef.current!);
      call.on("stream", (remoteStream) => {
        handleRemoteStream(remoteStream);
        setStatus("connected");
      });
      call.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("[peer] answer error", err);
        setError(`Connection failed: ${err.message || err.type || "unknown"}`);
        setStatus("error");
      });
      call.on("close", () => {
        setStatus("disconnected");
        onRemoteEnd?.();
      });
    });

    peer.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[peer] peer error", err);
      const msg =
        err.type === "peer-unavailable"
          ? "The other person isn't in the room yet. Make sure they've opened the invitation link."
          : `Connection error: ${err.message || err.type || "unknown"}`;
      setError(msg);
      if (err.type === "peer-unavailable") {
        setStatus(isHost ? "waiting" : "connecting");
      } else {
        setStatus("error");
      }
    });

    peer.on("disconnected", () => {
      // eslint-disable-next-line no-console
      console.log("[peer] disconnected from signaling server");
      // Try to reconnect to the signaling server
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
