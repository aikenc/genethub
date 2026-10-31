import {expect, it} from 'vitest';
import {htmlServiceMedia} from './serviceClient';
import type {ServicePreviewDescriptor} from '@genehub/proto/service-preview';

const descriptor = (media: Record<string, unknown> | null, routes = [{prefix: '/api/ue/', websocket: true}]) =>
  ({version: 1, name: 'x', runId: 'r', routes, media, iceServers: [], dataPolicy: 'auto'}) as unknown as ServicePreviewDescriptor;
const pixel = {offerPath: '/api/ue/ws', microphone: 'none', client: 'html', protocol: 'pixel-streaming/1', sessionPath: '/api/ue/ws'};

it('accepts an engine signalling route as the only required HTML media path', () => {
  expect(htmlServiceMedia(descriptor(pixel))?.protocol).toBe('pixel-streaming/1');
});
it('requires that route to be a registered WebSocket route under /api/', () => {
  expect(() => htmlServiceMedia(descriptor(pixel, [{prefix: '/api/ue/', websocket: false}]))).toThrow();
  expect(() => htmlServiceMedia(descriptor({...pixel, sessionPath: '/api/other/ws'}))).toThrow();
  expect(() => htmlServiceMedia(descriptor({...pixel, sessionPath: '/api/ue/%2e%2e/ws'}))).toThrow();
});
it('keeps the remote-desktop contract and refuses unknown protocols or a microphone', () => {
  expect(() => htmlServiceMedia(descriptor({...pixel, protocol: 'pixel-streaming/2'}))).toThrow();
  expect(() => htmlServiceMedia(descriptor({...pixel, protocol: 'remote-desktop/1'}))).toThrow(); // needs stop and control paths
  expect(() => htmlServiceMedia(descriptor({...pixel, microphone: 'webrtc'}))).toThrow();
  expect(htmlServiceMedia(descriptor({offerPath: '/api/ue/ws', microphone: 'none'}))).toBeNull();
});
