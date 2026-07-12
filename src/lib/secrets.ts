// Thin wrapper over the Rust keychain commands. Sensitive values (API keys,
// Vertex service-account JSON) live in the OS credential store, not localStorage.
import { invoke } from '@tauri-apps/api/core';

export const secretGet = (key: string): Promise<string | null> =>
  invoke<string | null>('secret_get', { key });

export const secretSet = (key: string, value: string): Promise<void> =>
  invoke<void>('secret_set', { key, value });

export const secretDelete = (key: string): Promise<void> =>
  invoke<void>('secret_delete', { key });
