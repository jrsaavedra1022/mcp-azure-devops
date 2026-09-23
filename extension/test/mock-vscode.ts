// Contract-test seam, never included in the packaged extension.
interface MockAPI {
  window: unknown;
  workspace: unknown;
  env: unknown;
  Uri: unknown;
}
const mock = (globalThis as unknown as { mockVscode: MockAPI }).mockVscode;
export const window = mock.window;
export const workspace = mock.workspace;
export const env = mock.env;
export const Uri = mock.Uri;
export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}
