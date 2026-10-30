/* GeneHub remote-desktop/1 reference client. Copy and edit with your project.
 * Transport is the existing Preview fetch/WebSocket bridge; no account SDK. */
class SessionSocket extends EventTarget {
  constructor(path) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.lastChallenge = null;
    this.socket = new WebSocket(path);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('服务连接超时')); this.close(); }, 15000);
      this.socket.onopen = () => { clearTimeout(timer); resolve(); };
      this.socket.onerror = () => { clearTimeout(timer); reject(new Error('服务连接失败')); };
      this.socket.onclose = () => {
        clearTimeout(timer);
        reject(new Error('服务连接已关闭'));
        this.closed = true;
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('会话已断开')); }
        this.pending.clear();
        this.dispatchEvent(new Event('close'));
      };
    });
    this.socket.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 262144) { this.close(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { this.close(); return; }
      if (message.event === 'challenge') {
        // Only this WS may renew its source-issued, single-use challenge.
        // Direct media traffic never keeps a disconnected session alive.
        const nonce = message.params?.nonce;
        if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) { this.close(); return; }
        if (nonce !== this.lastChallenge) {
          this.lastChallenge = nonce;
          this.socket.send(JSON.stringify({ method: 'renew', params: { nonce } }));
        }
      }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message || message.error.code));
        else waiter.resolve(message.result);
      } else if (message.event) this.dispatchEvent(new CustomEvent(message.event, { detail: message.params }));
    };
  }
  async request(method, params = {}) {
    await this.ready;
    if (this.closed || this.pending.size >= 8) throw new Error('会话关闭或请求过多');
    const id = `r-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('请求超时；请检查源端状态后重连')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { if (!this.closed) { this.closed = true; this.socket.close(); } }
}

export class RemoteDesktopClient extends EventTarget {
  constructor(video) {
    super(); this.video = video; this.epoch = 0; this.lease = null;
    this.video.playsInline = true;
  }
  status(message) { this.dispatchEvent(new CustomEvent('status', { detail: message })); }
  async pageState() {
    if (!window.genehubServicePreview) throw new Error('请在预览信息中允许本次登记服务访问');
    return window.genehubServicePreview.describe();
  }
  async connect() {
    this.close();
    const epoch = this.epoch;
    let view;
    try {
      const { descriptor } = await this.pageState();
      if (descriptor.media?.protocol !== 'remote-desktop/1') throw new Error('此登记服务不支持远程桌面');
      this.descriptor = descriptor;
      this.status('正在连接源端…');
      const { iceServers } = await window.genehubServicePreview.ice();
      if (epoch !== this.epoch) throw new Error('连接已取消');
      const peer = new RTCPeerConnection({ iceServers }); this.peer = peer;
      this.presentedFrames = 0;
      const presented = () => {
        if (epoch !== this.epoch) return;
        this.presentedFrames++;
        this.video.requestVideoFrameCallback?.(presented);
      };
      this.video.requestVideoFrameCallback?.(presented);
      this.controlChannel = peer.createDataChannel('gh-control-v1', { ordered: true });
      this.motionChannel = peer.createDataChannel('gh-motion-v1', { ordered: false, maxRetransmits: 0 });
      const inputClosed = () => {
        if (epoch !== this.epoch) return;
        this.releaseControl(); this.status('输入通道已关闭，画面可继续观看；请断开后重新连接以操作');
      };
      this.controlChannel.onclose = inputClosed; this.motionChannel.onclose = inputClosed;
      const stream = new MediaStream();
      peer.ontrack = event => {
        if (epoch !== this.epoch) return;
        stream.addTrack(event.track); this.video.srcObject = stream;
        void this.video.play().catch(() => this.status('画面已到达；点击播放以开启声音'));
      };
      peer.onconnectionstatechange = () => {
        if (epoch !== this.epoch) return;
        if (peer.connectionState === 'connected') this.status('已连接，默认仅观看');
        else if (peer.connectionState === 'failed') { this.close(); this.status('媒体连接失败；请检查网络或在外侧允许媒体中继'); }
      };
      // Apply the same authorized configuration to the actual source PC.
      const candidates = [], remoteCandidates = []; let answerSet = false;
      const sendCandidate = candidate => view.request('media.signal', {
        sessionId: session.sessionId, sessionToken: session.sessionToken,
        generation: 1, candidate,
      }).catch(() => { if (epoch === this.epoch) this.status('候选交换失败，请重新连接'); });
      peer.onicecandidate = event => {
        if (epoch !== this.epoch) return;
        const candidate = event.candidate?.toJSON() ?? null;
        if (answerSet) void sendCandidate(candidate);
        else if (candidates.length < 256) candidates.push(candidate);
        else { this.close(); this.status('媒体候选过多，已停止连接'); }
      };
      const remoteVideo = peer.addTransceiver('video', { direction: 'recvonly' });
      const remoteAudio = peer.addTransceiver('audio', { direction: 'recvonly' });
      for (const [kind, transceiver, mime] of [['video', remoteVideo, 'video/H264'], ['audio', remoteAudio, 'audio/opus']]) {
        const codecs = RTCRtpReceiver.getCapabilities?.(kind)?.codecs.filter(codec => codec.mimeType.toLowerCase() === mime.toLowerCase());
        if (codecs?.length && transceiver.setCodecPreferences) transceiver.setCodecPreferences(codecs);
      }
      // Cold browser RTC/OS preparation may block the renderer for seconds.
      // Finish it before opening the source's short-lived view authority.
      await peer.setLocalDescription(await peer.createOffer());
      if (epoch !== this.epoch) throw new Error('连接已取消');
      view = new SessionSocket(descriptor.media.sessionPath); this.view = view;
      let closeReason = '源端会话已断开，控制已停止续期';
      view.addEventListener('close', () => { if (this.view === view) { this.close(); this.status(closeReason); } });
      // Source facts (first real capture, audio availability, H.264 format) come
      // from the source itself; show them, do not infer them from the video element.
      view.addEventListener('media.status', event => { if (this.view === view) this.dispatchEvent(new CustomEvent('source', { detail: event.detail })); });
      view.addEventListener('session.closed', event => {
        if (this.view !== view) return;
        const reasons = {
          target_changed: '源端桌面已锁定、被系统安全桌面接管或显示器发生变化，已停止共享',
          desktop_unavailable: '源端桌面当前不可用（锁屏或未登录）',
          h264_profile_mismatch: '源端视频编码与协商的档位不一致，已拒绝发送',
          source_stopped_sharing: '源端已停止共享',
          app_stopping: '源端 Capture 正在退出',
        };
        const text = reasons[event.detail?.reason];
        if (text) closeReason = text;
      });
      const session = await view.request('session.open');
      if (epoch !== this.epoch) throw new Error('连接已取消');
      this.session = session;
      view.addEventListener('media.candidate', event => {
        if (epoch !== this.epoch || event.detail?.generation !== 1) return;
        if (answerSet) void peer.addIceCandidate(event.detail.candidate).catch(() => this.status('源端候选无效，请重新连接'));
        else if (remoteCandidates.length < 256) remoteCandidates.push(event.detail.candidate);
      });
      const response = await fetch(descriptor.media.offerPath, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'offer', sdp: peer.localDescription.sdp, iceServers,
          sessionId: session.sessionId, sessionToken: session.sessionToken, generation: 1 }),
      });
      if (!response.ok) throw new Error(`源端媒体协商失败（${response.status}）`);
      const answer = await response.json();
      if (epoch !== this.epoch) throw new Error('连接已取消');
      if (answer.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length > 131072) throw new Error('源端 SDP 无效');
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      answerSet = true;
      for (const candidate of remoteCandidates) await peer.addIceCandidate(candidate);
      for (const candidate of candidates) await sendCandidate(candidate);
      this.dispatchEvent(new CustomEvent('session', { detail: session }));
      this.statsTimer = setInterval(() => { void this.statistics().catch(() => {}); }, 1000);
      const deadline = setTimeout(() => {
        if (epoch === this.epoch && peer.connectionState !== 'connected') { this.close(); this.status('媒体连接超时，直连可能不可达'); }
      }, 25000);
      this.deadline = deadline;
      return session;
    } catch (error) {
      if (epoch === this.epoch) { this.close(); this.status(error.message || '连接失败'); }
      else view?.close();
      throw error;
    }
  }
  async acquireControl() {
    const { controlAllowed } = await this.pageState();
    if (!controlAllowed) throw new Error('请先在外侧工具栏允许本页接管');
    if (!this.session || !this.view || this.peer?.connectionState !== 'connected') throw new Error('请先连接画面');
    if (this.controlChannel?.readyState !== 'open' || this.motionChannel?.readyState !== 'open') throw new Error('输入通道尚未就绪，请稍后重试或重新连接');
    if (this.control) return this.lease;
    const epoch = this.epoch;
    const control = new SessionSocket(this.descriptor.media.controlPath); this.control = control;
    control.addEventListener('close', () => {
      if (this.control === control) { this.control = null; this.lease = null; this.dispatchEvent(new Event('released')); }
    });
    const granted = state => {
      if (epoch !== this.epoch || this.control !== control) return;
      if (state.state === 'granted') {
        if (this.lease?.epoch === state.epoch) return;
        this.lease = state; this.dispatchEvent(new CustomEvent('control', { detail: state }));
      }
      else if (state.state === 'released') this.releaseControl();
      else this.status('正在等待源端或 Agent 交还控制');
    };
    control.addEventListener('control.state', event => granted(event.detail));
    try {
      const state = await control.request('control.acquire', {
        sessionId: this.session.sessionId, sessionToken: this.session.sessionToken,
        targetGeneration: this.session.target.generation,
      });
      granted(state); return state;
    } catch (error) { if (this.control === control) this.releaseControl(); else control.close(); throw error; }
  }
  releaseControl() {
    const control = this.control; this.control = null; this.lease = null;
    // Closing the protected WS is authoritative even if the page never sends a
    // best-effort release RPC. Source watchdog is independent of this script.
    control?.close(); this.dispatchEvent(new Event('released'));
  }
  async statistics() {
    const peer = this.peer;
    if (!peer) return;
    const report = await peer.getStats(); const stats = {};
    report.forEach(row => {
      if (row.type === 'inbound-rtp' && row.kind === 'video') { stats.fps = row.framesPerSecond; stats.frames = row.framesDecoded; stats.lost = row.packetsLost; }
      if (row.type === 'transport' && row.selectedCandidatePairId) {
        const pair = report.get(row.selectedCandidatePairId);
        stats.rttMs = pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null;
        stats.path = [report.get(pair?.localCandidateId)?.candidateType, report.get(pair?.remoteCandidateId)?.candidateType].includes('relay') ? '中继' : '直连';
      }
    });
    if (this.peer === peer) this.dispatchEvent(new CustomEvent('stats', { detail: stats }));
    if (this.peer === peer && this.view && this.session) {
      const presentedFrames = this.video.requestVideoFrameCallback ? this.presentedFrames : stats.frames;
      await this.view.request('media.feedback', { sessionId: this.session.sessionId, sessionToken: this.session.sessionToken,
        presentedFrames: presentedFrames || 0 });
    }
  }
  close() {
    this.epoch++; clearInterval(this.statsTimer); clearTimeout(this.deadline);
    this.releaseControl();
    const session = this.session; this.session = null;
    if (session && this.descriptor) void fetch(this.descriptor.media.stopPath, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, sessionToken: session.sessionToken }) }).catch(() => {});
    const view = this.view; this.view = null; view?.close();
    this.peer?.close(); this.peer = null; this.video.srcObject = null;
  }
}
