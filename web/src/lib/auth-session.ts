"use client";

import { login } from "@/lib/api";
import {
  clearStoredAuthSession,
  getStoredAuthSession,
  setStoredAuthSession,
  type StoredAuthSession,
} from "@/store/auth";

let cachedSession: StoredAuthSession | null = null;
let hasValidatedOnce = false;

export function getCachedAuthSession(): StoredAuthSession | null {
  return cachedSession;
}

export function hasValidatedAuthSession(): boolean {
  return hasValidatedOnce;
}

export function primeAuthSessionCache(session: StoredAuthSession | null) {
  cachedSession = session;
  hasValidatedOnce = true;
}

export function clearAuthSessionCache() {
  cachedSession = null;
  hasValidatedOnce = false;
}

export async function getValidatedAuthSession(): Promise<StoredAuthSession | null> {
  const storedSession = await getStoredAuthSession();
  if (!storedSession) {
    primeAuthSessionCache(null);
    return null;
  }

  try {
    const data = await login(storedSession.key);
    const nextSession: StoredAuthSession = {
      key: storedSession.key,
      role: data.role,
      subjectId: data.subject_id,
      name: data.name,
    };
    await setStoredAuthSession(nextSession);
    primeAuthSessionCache(nextSession);
    return nextSession;
  } catch {
    await clearStoredAuthSession();
    primeAuthSessionCache(null);
    return null;
  }
}
