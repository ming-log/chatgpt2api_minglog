"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchPptTasks, type PptSlide, type PptTask } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  getImageConversationStats,
  listImageConversations,
  type ImageConversation,
} from "@/store/image-conversations";

type TaskActivityStats = {
  queued: number;
  running: number;
};

const EMPTY_STATS: TaskActivityStats = { queued: 0, running: 0 };
const POLL_INTERVAL_MS = 3000;

function addStats(left: TaskActivityStats, right: TaskActivityStats): TaskActivityStats {
  return {
    queued: left.queued + right.queued,
    running: left.running + right.running,
  };
}

function countImageActivity(conversations: ImageConversation[]): TaskActivityStats {
  return conversations.reduce((total, conversation) => {
    const stats = getImageConversationStats(conversation);
    return addStats(total, stats);
  }, EMPTY_STATS);
}

function countSlidesActivity(slides: PptSlide[] | undefined): TaskActivityStats {
  return (slides || []).reduce(
    (total, slide) => {
      if (slide.status === "queued") {
        total.queued += 1;
      } else if (slide.status === "running") {
        total.running += 1;
      }
      return total;
    },
    { queued: 0, running: 0 },
  );
}

function countPptTaskActivity(task: PptTask): TaskActivityStats {
  const slideStats = countSlidesActivity(task.slides);
  if (slideStats.queued > 0 || slideStats.running > 0) {
    return slideStats;
  }
  if (task.status === "queued") {
    return { queued: 1, running: 0 };
  }
  if (task.status === "running" || task.status === "packaging") {
    return { queued: 0, running: 1 };
  }
  return EMPTY_STATS;
}

function countPptActivity(tasks: PptTask[]): TaskActivityStats {
  return tasks.reduce((total, task) => addStats(total, countPptTaskActivity(task)), EMPTY_STATS);
}

export function TaskActivityPill() {
  const [stats, setStats] = useState<TaskActivityStats>(EMPTY_STATS);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const [conversations, pptTasks] = await Promise.all([
          listImageConversations(),
          fetchPptTasks([]).then((result) => result.items),
        ]);
        if (!cancelled) {
          setStats(addStats(countImageActivity(conversations), countPptActivity(pptTasks)));
        }
      } catch {
        if (!cancelled) {
          const conversations = await listImageConversations().catch(() => []);
          if (!cancelled) {
            setStats(countImageActivity(conversations));
          }
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

  const total = stats.queued + stats.running;
  const title = useMemo(
    () => `运行 ${stats.running}，排队 ${stats.queued}`,
    [stats.queued, stats.running],
  );

  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] leading-none shadow-sm transition-colors sm:h-8",
        total > 0
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-border/70 bg-card text-muted-foreground",
      )}
      title={title}
      aria-label={title}
    >
      {total > 0 ? <LoaderCircle className="size-3 animate-spin" /> : null}
      <span className="font-data text-[10px] font-semibold tracking-[0.16em] uppercase">运行</span>
      <span className="font-data tabular-nums text-[12px] font-semibold text-foreground">{total}</span>
    </span>
  );
}
