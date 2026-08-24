export interface ManagedService {
  name: string;
  origin?: string;
  stop(): Promise<void>;
}

export class ServiceManager {
  private readonly services: ManagedService[] = [];

  add(service: ManagedService): void {
    this.services.push(service);
  }

  async stopAll(): Promise<void> {
    for (const service of [...this.services].reverse()) {
      await service.stop();
    }
    this.services.length = 0;
  }
}
