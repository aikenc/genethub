/* Editable DOM → remote-desktop/1 input mapping. Physical keys use DOM code. */
export function attachInput(client, video) {
  let reliableSeq = 0, motionSeq = 0, dxTotal = 0, dyTotal = 0;
  const keys = new Set(), buttons = new Set();
  const removers = [];
  const on = (target, name, action, options) => { target.addEventListener(name, action, options); removers.push(() => target.removeEventListener(name, action, options)); };
  const packet = (channel, event, motion = false) => {
    const session = client.session, lease = client.lease;
    if (!session || !lease || channel?.readyState !== 'open') return false;
    if (channel.bufferedAmount > (motion ? 16384 : 65536)) { client.releaseControl(); client.status('输入拥塞，已交还控制'); return false; }
    try {
      channel.send(JSON.stringify({ sessionId: session.sessionId, epoch: lease.epoch,
        targetGeneration: lease.targetGeneration, seq: motion ? ++motionSeq : ++reliableSeq, event }));
      return true;
    } catch {
      client.releaseControl(); client.status('输入通道发送失败，已停止控制'); return false;
    }
  };
  const position = event => {
    const box = video.getBoundingClientRect(), w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(box.width / w, box.height / h);
    const x = (event.clientX - box.left - (box.width - w * scale) / 2) / (w * scale);
    const y = (event.clientY - box.top - (box.height - h * scale) / 2) / (h * scale);
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };
  const active = () => !!client.lease;
  on(client, 'control', () => { reliableSeq = 0; motionSeq = 0; dxTotal = 0; dyTotal = 0; keys.clear(); buttons.clear(); video.focus(); });
  on(client, 'released', () => { keys.clear(); buttons.clear(); });
  const heartbeat = setInterval(() => {
    if (active()) packet(client.controlChannel, { type: 'state', keys: [...keys], buttons: [...buttons] });
  }, 250);
  removers.push(() => clearInterval(heartbeat));
  on(video, 'pointermove', event => {
    if (!active()) return;
    if (document.pointerLockElement === video) {
      dxTotal += event.movementX; dyTotal += event.movementY;
      packet(client.motionChannel, { type: 'relative', dxTotal, dyTotal }, true);
    } else {
      const point = position(event);
      if (point) packet(client.motionChannel, { type: 'absolute', ...point }, true);
    }
  });
  for (const [name, down] of [['pointerdown', true], ['pointerup', false]]) on(video, name, event => {
    if (!active()) return;
    const point = position(event);
    if (down && !point && !document.pointerLockElement) return;
    event.preventDefault(); video.focus();
    if (down) video.setPointerCapture?.(event.pointerId);
    if (down) buttons.add(event.button); else buttons.delete(event.button);
    packet(client.controlChannel, { type: 'button', button: event.button, down,
      ...(point && !document.pointerLockElement ? point : {}) });
  });
  on(video, 'pointercancel', () => {
    keys.clear(); buttons.clear(); packet(client.controlChannel, { type: 'reset' }); client.releaseControl();
  });
  on(video, 'contextmenu', event => { if (active()) event.preventDefault(); });
  on(video, 'wheel', event => {
    if (!active()) return;
    event.preventDefault();
    packet(client.controlChannel, { type: 'wheel', dx: Math.max(-1200, Math.min(1200, event.deltaX)), dy: Math.max(-1200, Math.min(1200, event.deltaY)) });
  }, { passive: false });
  for (const [name, down] of [['keydown', true], ['keyup', false]]) on(video, name, event => {
    if (!active() || event.repeat) return;
    if (down) keys.add(event.code); else keys.delete(event.code);
    // Browser/OS-reserved combinations cannot all be forwarded.
    event.preventDefault(); packet(client.controlChannel, { type: 'key', code: event.code, down });
  });
  // Moving to this page's text/lock controls releases held state, while the
  // session stays eligible. Leaving the page/frame releases the lease itself.
  on(video, 'blur', () => { keys.clear(); buttons.clear(); packet(client.controlChannel, { type: 'reset' }); });
  on(window, 'blur', () => client.releaseControl());
  on(document, 'visibilitychange', () => { if (document.hidden) client.releaseControl(); });
  on(document, 'pointerlockchange', () => { if (!document.pointerLockElement) client.releaseControl(); });
  return {
    lock: () => { if (!active()) throw new Error('请先取得控制权'); video.focus(); return video.requestPointerLock(); },
    text: text => {
      if (typeof text === 'string' && text.length <= 4096) {
        // Text input releases native held state. Do not re-press old keys
        // or buttons with the next reliable state heartbeat.
        keys.clear(); buttons.clear(); packet(client.controlChannel, { type: 'text', text });
      }
    },
    dispose: () => { for (const remove of removers) remove(); client.releaseControl(); },
  };
}
