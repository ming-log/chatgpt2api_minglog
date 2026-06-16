import axios, {AxiosError, type AxiosRequestConfig} from "axios";

import webConfig from "@/constants/common-env";
import {clearAuthSessionCache} from "@/lib/auth-session";
import {clearStoredAuthSession, getStoredAuthKey} from "@/store/auth";

type RequestConfig = AxiosRequestConfig & {
    redirectOnUnauthorized?: boolean;
};

type ErrorPayload = {
    detail?: unknown;
    error?: unknown;
    message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
}

function errorMessageFromValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (!isRecord(value)) {
        return "";
    }

    const item = value as { error?: unknown; message?: unknown };
    if (typeof item.message === "string") {
        return item.message;
    }
    return errorMessageFromValue(item.error);
}

async function parseErrorPayload(value: unknown): Promise<ErrorPayload | undefined> {
    let payload = value;
    if (typeof Blob !== "undefined" && payload instanceof Blob) {
        const text = await payload.text();
        if (!text) {
            return undefined;
        }
        payload = text;
    }
    if (typeof payload === "string") {
        const message = payload;
        try {
            payload = JSON.parse(message) as unknown;
        } catch {
            return {message};
        }
    }
    return isRecord(payload) ? (payload as ErrorPayload) : undefined;
}

export const request = axios.create({
    baseURL: webConfig.apiUrl.replace(/\/$/, ""),
});

request.interceptors.request.use(async (config) => {
    const nextConfig = {...config};
    const authKey = await getStoredAuthKey();
    const headers = {...(nextConfig.headers || {})} as Record<string, string>;
    if (authKey && !headers.Authorization) {
        headers.Authorization = `Bearer ${authKey}`;
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    nextConfig.headers = headers;
    return nextConfig;
});

request.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<ErrorPayload>) => {
        const status = error.response?.status;
        const shouldRedirect = (error.config as RequestConfig | undefined)?.redirectOnUnauthorized !== false;
        if (status === 401 && shouldRedirect && typeof window !== "undefined") {
            // Avoid redirect loop — only redirect if not already on /login
            if (!window.location.pathname.startsWith("/login")) {
                await clearStoredAuthSession();
                clearAuthSessionCache();
                window.location.replace("/login");
                // Return a never-resolving promise to prevent further error handling
                // while the browser navigates away
                return new Promise(() => {});
            }
        }

        const payload = await parseErrorPayload(error.response?.data);
        const message =
            errorMessageFromValue(payload?.detail) ||
            errorMessageFromValue(payload?.error) ||
            payload?.message ||
            error.message ||
            `请求失败 (${status || 500})`;
        return Promise.reject(new Error(message));
    },
);

type RequestOptions = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirectOnUnauthorized?: boolean;
    timeout?: number;
};

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
    const {method = "GET", body, headers, redirectOnUnauthorized = true, timeout} = options;
    const config: RequestConfig = {
        url: path,
        method,
        data: body,
        headers,
        redirectOnUnauthorized,
        timeout,
    };
    const response = await request.request<T>(config);
    return response.data;
}
