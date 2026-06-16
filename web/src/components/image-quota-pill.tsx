"use client";

import { Infinity as InfinityIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchImageAccountTypes } from "@/lib/api";

const POLL_INTERVAL_MS = 5000;

export function ImageQuotaPill() {
  const [quota, setQuota] = useState("--");

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const data = await fetchImageAccountTypes();
        if (!cancelled) {
          setQuota(data.available_quota ? String(data.available_quota) : "--");
        }
      } catch {
        if (!cancelled) {
          setQuota("--");
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(load, POLL_INTERVAL_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const title = useMemo(() => `可用额度 ${quota}`, [quota]);

  return (
    <span
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 text-[11px] leading-none text-muted-foreground shadow-sm sm:h-8"
      title={title}
      aria-label={title}
    >
      <span className="font-data text-[10px] font-semibold tracking-[0.16em] uppercase">额度</span>
      {quota === "∞" ? (
        <InfinityIcon className="size-3.5 text-foreground" strokeWidth={2.25} aria-label="不限额度" />
      ) : (
        <span className="font-data tabular-nums text-[12px] font-semibold text-foreground">{quota}</span>
      )}
    </span>
  );
}
