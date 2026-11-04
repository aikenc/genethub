import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetPreviewMetadata } from '@genehub/proto';
import type { Client, ConnectionState } from '../protocol/client';
import { ServiceHtmlDocument } from './AssetPreviewPage';
import { ServicePreviewClient, ServicePreviewQueryError } from './serviceClient';
import { useServiceBridge } from './serviceBridge';

vi.mock('./serviceBridge', async importOriginal => ({
  ...await importOriginal<typeof import('./serviceBridge')>(),
  useServiceBridge: vi.fn(),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function setup() {
  let listener: (state: ConnectionState) => void = () => {};
  const client = { identity: { features: ['service.preview.v1'] }, connectionState: 'ready',
    onStateChange(fn: typeof listener) { listener = fn; return () => {}; },
  } as unknown as Client;
  const close = vi.fn();
  const discover = vi.spyOn(ServicePreviewClient, 'discover').mockImplementation(async () => ({
    client, workspaceHandle: 'ws', entryPath: 'r_root/play.html', close,
    descriptor: { version: 1, runId: 'a'.repeat(32), name: 'UE', dataPolicy: 'auto',
      routes: [{ prefix: '/api/ue/', websocket: true }],
      media: { client: 'html', protocol: 'pixel-streaming/1', microphone: 'none', sessionPath: '/api/ue/ws', offerPath: '/api/ue/ws' },
    },
  } as unknown as ServicePreviewClient));
  const bytes = new TextEncoder().encode('<html><body>game</body></html>');
  render(<ServiceHtmlDocument client={client} workspaceHandle="ws" entryPath="r_root/play.html"
    bytes={bytes} metadata={{ kind: 'html', mediaType: 'text/html', sourceBytes: bytes.length } as AssetPreviewMetadata}
    fetchAsset={async () => null} />);
  const bridge = () => vi.mocked(useServiceBridge).mock.calls.at(-1);
  return { client, discover, close, bridge, state: (value: ConnectionState) => act(() => listener(value)) };
}

describe('registered preview automatic connection', () => {
  it('opens its bridge immediately with channel relay and no second grant', async () => {
    const t = setup();
    await waitFor(() => expect(t.bridge()?.[1]).not.toBeNull());
    expect(t.bridge()?.[3]?.allowTurn).toBe(true);
    expect(screen.queryByText('允许本次预览访问登记服务')).toBeNull();
    expect(screen.getByRole('checkbox', { name: '仅直连' })).not.toBeChecked();
    await waitFor(() => expect(screen.getByTitle<HTMLIFrameElement>('HTML 文件预览').getAttribute('srcdoc')?.includes('genehubServicePreview')).toBe(true));
  });

  it('changes the media path without requiring another grant', async () => {
    const t = setup();
    await screen.findByRole('checkbox', { name: '仅直连' });
    fireEvent.click(screen.getByRole('checkbox', { name: '仅直连' }));
    await waitFor(() => expect(t.discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(t.bridge()?.[1]).not.toBeNull());
    expect(t.bridge()?.[3]?.allowTurn).toBe(false);
  });

  it('rediscovers after reconnect but respects an explicit stop', async () => {
    const t = setup();
    await screen.findByRole('button', { name: '停止观看' });
    t.state('reconnecting');
    expect(t.bridge()?.[1]).toBeNull();
    t.state('ready');
    await waitFor(() => expect(t.discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(t.bridge()?.[1]).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '停止观看' }));
    expect(t.bridge()?.[1]).toBeNull();
    t.state('ready');
    await waitFor(() => expect(t.discover).toHaveBeenCalledTimes(3));
    expect(t.bridge()?.[1]).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(t.bridge()?.[1]).not.toBeNull());
  });

  it('rediscovers a replacement run after a bridge failure without a grant', async () => {
    const t = setup();
    await waitFor(() => expect(t.bridge()?.[1]).not.toBeNull());
    const old = t.bridge()?.[1];
    vi.useFakeTimers();
    try {
      act(() => t.bridge()?.[3]?.onUnavailable?.());
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(t.discover).toHaveBeenCalledTimes(2);
      expect(t.close).toHaveBeenCalled();
      expect(t.bridge()?.[1]).not.toBeNull();
      expect(t.bridge()?.[1]).not.toBe(old);
    } finally { vi.useRealTimers(); }
  });

  it('does not enable a service refused by the daemon', async () => {
    const t = setup();
    await screen.findByRole('button', { name: '停止观看' });
    t.discover.mockRejectedValue(new ServicePreviewQueryError('share cannot access service', 403, 'forbidden'));
    t.state('reconnecting'); t.state('ready');
    await waitFor(() => expect(t.discover).toHaveBeenCalledTimes(2));
    expect(t.bridge()?.[1]).toBeNull();
    expect(screen.queryByRole('button', { name: '停止观看' })).toBeNull();
  });
});
