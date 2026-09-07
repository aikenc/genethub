import { useEffect, useRef, useState } from "react";
import type { ServicePreviewClient } from "./serviceClient";

/** Trusted UI owns both permission gestures and the native media objects. No
 * arbitrary application code is executed here and no track is sent to the iframe. */
export function ServiceMediaPanel({
  service,
}: {
  service: ServicePreviewClient;
}) {
  const [status, setStatus] = useState("尚未连接");
  const [connected, setConnected] = useState(false);
  const [mic, setMic] = useState(false);
  const [allowTurn, setAllowTurn] = useState(false);
  const [path, setPath] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const capture = useRef<MediaStream | null>(null);
  const epoch = useRef(0);
  const session = useRef<string | null>(null);
  const releaseSession = () => {
    const id = session.current;
    session.current = null;
    const path = service.descriptor.media?.stopPath;
    if (id && path)
      void service
        .fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: id }),
        })
        .then((r) => r.body?.cancel())
        .catch(() => {});
  };
  const abort = useRef<AbortController | null>(null);
  const stop = () => {
    releaseSession();
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
    pc.current?.close();
    pc.current = null;
    capture.current?.getTracks().forEach((t) => t.stop());
    capture.current = null;
    if (video.current) video.current.srcObject = null;
    setConnected(false);
    setMic(false);
    setPath("");
  };
  useEffect(
    () => () => {
      releaseSession();
      epoch.current++;
      abort.current?.abort();
      pc.current?.close();
      capture.current?.getTracks().forEach((t) => t.stop());
    },
    [service],
  );
  const connect = async (withMic: boolean) => {
    stop();
    const id = epoch.current;
    const controller = new AbortController();
    abort.current = controller;
    const current = () => id === epoch.current;
    try {
      if (!window.isSecureContext)
        throw new Error("音视频需要安全的 HTTPS 入口");
      const media = service.descriptor.media;
      if (!media) throw new Error("未配置媒体入口");
      setStatus(withMic ? "正在请求麦克风权限…" : "正在连接…");
      let local: MediaStream | null = null;
      if (withMic) {
        local = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        if (!current()) {
          local.getTracks().forEach((t) => t.stop());
          return;
        }
        capture.current = local;
        setMic(true);
      }
      const iceConfig = await service.ice(allowTurn);
      if (!current()) return;
      const iceServers = iceConfig
        .map((s) => ({
          urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) =>
            allowTurn ? /^(stun|turn|turns):/.test(u) : /^stun:/.test(u),
          ),
          ...(s.username ? { username: s.username } : {}),
          ...(s.credential ? { credential: s.credential } : {}),
        }))
        .filter((s) => s.urls.length);
      if (
        allowTurn &&
        !iceServers.some((s) => s.urls.some((u) => /^turns?:/.test(u)))
      )
        throw new Error("此运行未配置可用的 TURN 凭证");
      const peer = new RTCPeerConnection({ iceServers });
      pc.current = peer;
      const remote = new MediaStream();
      peer.ontrack = (event) => {
        if (current()) {
          remote.addTrack(event.track);
          if (video.current) {
            video.current.srcObject = remote;
            void video.current
              .play()
              .catch(() => setStatus("请点击视频播放声音"));
          }
        }
      };
      let disconnected: ReturnType<typeof setTimeout> | undefined;
      controller.signal.addEventListener(
        "abort",
        () => clearTimeout(disconnected),
        { once: true },
      );
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        clearTimeout(disconnected);
        if (peer.connectionState === "disconnected")
          disconnected = setTimeout(() => {
            if (current()) {
              stop();
              setStatus("媒体断开，可重新连接");
            }
          }, 15000);
        setStatus(
          peer.connectionState === "connected"
            ? "媒体已连接"
            : `媒体：${peer.connectionState}`,
        );
        setConnected(peer.connectionState === "connected");
        if (peer.connectionState === "failed") {
          stop();
          setStatus("媒体连接失败，可重新连接");
        }
      };
      peer.addTransceiver("video", { direction: "recvonly" });
      if (local)
        for (const track of local.getAudioTracks()) peer.addTrack(track, local);
      else peer.addTransceiver("audio", { direction: "recvonly" });
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", changed);
          controller.signal.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", changed);
          reject(new DOMException("取消", "AbortError"));
        };
        const changed = () => {
          if (peer.iceGatheringState === "complete") finish();
        };
        const timer = setTimeout(finish, 12000);
        peer.addEventListener("icegatheringstatechange", changed);
        controller.signal.addEventListener("abort", cancel, { once: true });
        changed();
      });
      if (!current()) return;
      const response = await service.fetch(media.offerPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sdp: peer.localDescription?.sdp,
          type: "offer",
          iceServers,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`媒体信令返回 ${response.status}`);
      const answer = await response.json();
      if (!current()) {
        if (typeof answer.sessionId === "string" && media.stopPath)
          void service
            .fetch(media.stopPath, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: answer.sessionId }),
            })
            .then((r) => r.body?.cancel())
            .catch(() => {});
        return;
      }
      if (
        typeof answer.sessionId === "string" &&
        answer.sessionId.length <= 128
      )
        session.current = answer.sessionId;
      if (typeof answer.sdp !== "string" || answer.sdp.length > 256 * 1024)
        throw new Error("媒体信令没有返回有效 SDP");
      if (!allowTurn && /a=candidate:.* typ relay(?: |\r?$)/m.test(answer.sdp))
        throw new Error("仅直连模式拒绝远端中继候选");
      if (!current()) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      const deadline = setTimeout(() => {
        if (current() && peer.connectionState !== "connected") {
          stop();
          setStatus("媒体建连超时，直连可能不可达");
        }
      }, 25000);
      const stats = setInterval(() => {
        void peer
          .getStats()
          .then((report) => {
            if (!current()) return;
            report.forEach((row) => {
              if (row.type === "transport" && row.selectedCandidatePairId) {
                const pair = report.get(row.selectedCandidatePairId);
                const a = report.get(pair?.localCandidateId);
                const b = report.get(pair?.remoteCandidateId);
                const relayed =
                  a?.candidateType === "relay" || b?.candidateType === "relay";
                if (relayed && !allowTurn) {
                  stop();
                  setStatus("已阻止未授权的中继路径");
                  return;
                }
                setPath(
                  `${relayed ? "TURN 中继" : "媒体直连"} · RTT ${Math.round((pair?.currentRoundTripTime ?? 0) * 1000)} ms`,
                );
              }
            });
          })
          .catch(() => {});
      }, 2000);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(deadline);
          clearInterval(stats);
        },
        { once: true },
      );
    } catch (e) {
      if (current()) {
        stop();
        setStatus(e instanceof Error ? e.message : "媒体连接失败");
      }
    }
  };
  if (!service.descriptor.media) return null;
  return (
    <section
      className="shrink-0 border-b border-line bg-surface p-3"
      aria-label="服务音视频"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <strong>{service.descriptor.name}</strong>
        <span role="status">{status}</span>
        <span>{path}</span>
        <button
          className="rounded border border-line px-2 py-1"
          onClick={() => void connect(false)}
        >
          连接音视频
        </button>
        {service.descriptor.media.microphone === "webrtc" ? (
          <button
            className="rounded border border-line px-2 py-1"
            onClick={() => void connect(true)}
          >
            {mic ? "重新连接麦克风" : "启用麦克风并连接"}
          </button>
        ) : null}
        <button
          className="rounded border border-line px-2 py-1"
          onClick={() => {
            stop();
            setStatus("已停止");
          }}
        >
          停止
        </button>
        <label>
          <input
            type="checkbox"
            checked={allowTurn}
            disabled={connected || mic}
            onChange={(e) => {
              stop();
              setAllowTurn(e.target.checked);
            }}
          />
          允许媒体中继
        </label>
        {mic ? <span className="text-red-500">麦克风正在使用</span> : null}
      </div>
      <video
        ref={video}
        controls
        playsInline
        className="mt-2 max-h-64 w-full bg-black"
      />
    </section>
  );
}
