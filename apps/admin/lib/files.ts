import { API, apiHeaders } from "./api";

// Opens an authenticated admin file (KYC document, request attachment) in a new tab.
export async function openAdminFile(path: string) {
  const res = await fetch(`${API}${path}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`Couldn't open the file (HTTP ${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function adminApi<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `HTTP ${res.status}`);
  return data as T;
}
