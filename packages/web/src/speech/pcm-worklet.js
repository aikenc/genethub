class GeneHubPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const input = channels[channel];
      for (let frame = 0; frame < frames; frame += 1) mono[frame] += input[frame] / channels.length;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("genehub-pcm-capture", GeneHubPcmCaptureProcessor);
