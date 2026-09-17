import { getLang, t } from './i18n.js';

export class ApiError extends Error {
  constructor(status, message, key, detail) {
    super(message);
    this.status = status;
    this.key = key;
    this.detail = detail;
  }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/** Appel REST : JSON, langue courante, en-tête anti-CSRF ; lève ApiError avec le message déjà traduit. */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'lkm-bo', 'X-Lang': getLang() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, t('errors.network'), 'errors.network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    if (res.status === 401 && e.key === 'errors.auth_required') onUnauthorized?.();
    throw new ApiError(res.status, e.message ?? t('errors.generic'), e.key, e.detail);
  }
  return data;
}

export const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
