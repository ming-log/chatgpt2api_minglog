"use client";

import { type ChangeEvent, type FocusEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextImage from "next/image";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Clock3,
  Download,
  FilePenLine,
  FileText,
  History,
  ImageIcon,
  LoaderCircle,
  Maximize2,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import webConfig from "@/constants/common-env";
import {
  createPptPlan,
  createPptMasterTask,
  createPptTask,
  deletePptSlide,
  deletePptSlideReference,
  deletePptTask,
  downloadPptSlideImage,
  downloadPptTask,
  editPptSlideImage,
  fetchImageAccountTypes,
  fetchPptTasks,
  insertBlankPptSlide,
  packagePptTask,
  confirmPptMasterTask,
  regeneratePptSlide,
  resumePptTask,
  stopPptTask,
  testPptProvider,
  updatePptPlanTask,
  updatePptSlidePrompt,
  uploadPptSlideImage,
  uploadPptSlideReference,
  updatePptTaskName,
  type ImageAccountType,
  type PptImageProviderMode,
  type PptPlan,
  type PptProviderKind,
  type PptProviderTestResult,
  type PptSlide,
  type PptTask,
} from "@/lib/api";
import {
  normalizeImageQuality,
  normalizeImageResolution,
  maxImageOutputSizeForAspectRatio,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/image-generation-options";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const MIN_SLIDES = 1;
const MAX_SLIDES = 100;
const DEFAULT_SLIDES = 20;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 100;
const DEFAULT_CONCURRENCY = 10;
const MIN_TILE_SIZE = 240;
const MAX_TILE_SIZE = 640;
const DEFAULT_TILE_SIZE = 360;
const TILE_SIZE_STEP = 20;
const CONTENT_GRID_ROWS = 3;
const CONTENT_GRID_GAP_PX = 20;
const MIN_REASONABLE_PPT_IMAGE_BYTES = 128;
const DEFAULT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_PROVIDER_MODE: PptImageProviderMode = "builtin";
const DEFAULT_IMAGE_ACCOUNT_TYPE: ImageAccountType = "free";
const DEFAULT_IMAGE_RESOLUTION: ImageResolution = "1k";
const DEFAULT_IMAGE_QUALITY: ImageQuality = "auto";
const PPT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ACCOUNT_TYPE_ORDER: ImageAccountType[] = ["free", "paid"];
const PPT_PROVIDER_STORAGE_KEY = "chatgpt2api:ppt_provider_settings";
const PPT_MASTER_PAGE_COUNT = 8;
const ANCHOR_ACTION_HIDE_DELAY_MS = 300;
const subtleScrollbar =
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-300/60 hover:[&::-webkit-scrollbar-thumb]:bg-stone-400/70";
// 统一的视觉语言：纯白卡片 + 12px 圆角 + 柔和悬浮阴影（Linear / Vercel 风格）。
const PANEL_CLASS = "rounded-2xl border border-stone-200/70 bg-white shadow-soft";
// 核心动作按钮：曜石黑渐变 + 流光 + 悬浮上浮。
const CTA_CLASS =
  "cta-obsidian cta-shimmer rounded-xl text-white disabled:cursor-not-allowed disabled:opacity-100 disabled:[background-image:none] disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none";
// 轻量次级按钮：白底细边、hover 微微抬起，不抢主视线。
const SECONDARY_BTN_CLASS =
  "rounded-lg border-stone-200 bg-white text-stone-600 shadow-none transition hover:border-stone-300 hover:bg-stone-50 hover:text-stone-900";
const MASTER_LAYOUT_LABELS: Record<string, string> = {
  cover: "封面页（Cover）",
  agenda: "目录页（Agenda）",
  section_break: "章节过渡页（Section Break）",
  single_column: "单栏内容页（Single Column）",
  two_column: "双栏图文页（Two-column）",
  bento_card: "卡片布局页（Bento / Card）",
  dashboard: "数据图表页（Dashboard）",
  thank_you: "结束页（Thank You / Q&A）",
};
const DEFAULT_MASTER_STYLE_PROMPT =
  "高端商务科技风：深色或浓郁中性色背景，少量品牌强调色，清晰网格、大留白、轻微材质层次；避免浅黄色、黑白单调和无关线条。";
const PPT_STYLE_PRESETS = [
  {
    label: "深色科技",
    prompt: "深色科技风：石墨黑、深海蓝或深绿背景，电光蓝/青色少量点缀，玻璃质感与微弱光效，稳定栅格，大留白，禁止随机线条。",
  },
  {
    label: "金融咨询",
    prompt: "金融咨询风：炭黑、墨绿、象牙白与香槟金形成高级对比，严谨对齐、清晰编号、克制阴影，避免浅黄色泛底和装饰线堆叠。",
  },
  {
    label: "极简奢华",
    prompt: "极简奢华风：暖灰、深棕黑、金属灰和少量高亮色，材质细腻、标题醒目、留白充足，避免纯黑白单调和复杂纹理。",
  },
  {
    label: "品牌发布",
    prompt: "品牌发布会风：深色渐变或大色块背景，主标题有舞台感，少量高饱和品牌色，画面干净有冲击力，避免无意义线条。",
  },
];

type StoredPptProviderSettings = Partial<{
  textBaseUrl: string;
  textApiKey: string;
  textModel: string;
  imageBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  imageProviderMode: PptImageProviderMode;
  imageAccountType: ImageAccountType;
  imageResolution: ImageResolution;
  imageQuality: ImageQuality;
  concurrency: string;
  tileSize: string;
  masterStylePrompt: string;
  isTextConfigOpen: boolean;
  isImageConfigOpen: boolean;
}>;

type ImageEditPopoverPlacement = {
  top: number;
  left: number;
  width: number;
};

type AnchorActionPlacement = {
  top: number;
  left: number;
  width: number;
};

type ReferencePreview = {
  title: string;
  imageUrl: string;
};

type PptLightboxImage = {
  id: string;
  src: string;
  metadataLabel?: string;
  sizeLabel?: string;
  dimensions?: string;
  downloadName?: string;
  downloadTaskId?: string;
  downloadSlideId?: string;
};

type PptImageRuntimeMetadata = {
  size?: number;
  width?: number;
  height?: number;
};

type PptHistoryStepStatus = "pending" | "running" | "success" | "error";

type PptHistoryStep = {
  key: "master" | "plan" | "content" | "package";
  label: string;
  status: PptHistoryStepStatus;
};

type PptHistoryItem = {
  groupKey: string;
  displayTask: PptTask;
  taskIds: string[];
  steps: PptHistoryStep[];
  progressPercent: number;
  updatedAt: string;
};

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function normalizeSlideCount(value: string) {
  const parsed = Math.floor(Number(value) || DEFAULT_SLIDES);
  return Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, parsed));
}

function normalizeConcurrency(value: string) {
  const parsed = Math.floor(Number(value) || DEFAULT_CONCURRENCY);
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, parsed));
}

function normalizeTileSize(value: string) {
  const parsed = Math.floor(Number(value) || DEFAULT_TILE_SIZE);
  return Math.min(MAX_TILE_SIZE, Math.max(MIN_TILE_SIZE, parsed));
}

function parseImageAccountType(value: unknown): ImageAccountType | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/[-\s/]+/g, "_");
  if (normalized === "free") return "free";
  return ["paid", "team", "plus", "pro", "prolite", "business", "enterprise", "edu", "team_plus_pro"].includes(normalized)
    ? "paid"
    : null;
}

function normalizeImageAccountType(value: unknown): ImageAccountType {
  return parseImageAccountType(value) ?? DEFAULT_IMAGE_ACCOUNT_TYPE;
}

function normalizeImageAccountTypes(values: unknown[]): ImageAccountType[] {
  const found = new Set(values.map(parseImageAccountType).filter((item): item is ImageAccountType => item !== null));
  return IMAGE_ACCOUNT_TYPE_ORDER.filter((item) => found.has(item));
}

function normalizeImageProviderMode(value: unknown): PptImageProviderMode {
  return value === "external" ? "external" : DEFAULT_IMAGE_PROVIDER_MODE;
}

function imageResolutionFromPptSize(value: unknown): ImageResolution {
  const clean = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  if (clean === "3840x2160" || clean === "4k") return "4k";
  if (clean === "2048x1152" || clean === "2k") return "2k";
  return "1k";
}

function defaultBackendBaseUrl() {
  const configured = webConfig.apiUrl.replace(/\/$/, "");
  if (configured) return configured;
  return typeof window !== "undefined" ? window.location.origin : "";
}

function canonicalBaseUrl(value: string) {
  const clean = value.trim().replace(/\/+$/, "");
  if (!clean) return "";
  try {
    const url = new URL(clean);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return clean.toLowerCase();
  }
}

function comparableProjectBaseUrl(value: string) {
  const clean = value.trim();
  if (!clean) return "";
  try {
    const url = new URL(clean);
    const hostAliases = new Set(["localhost", "127.0.0.1", "::1"]);
    const host = hostAliases.has(url.hostname) ? "localhost" : url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${path}`.replace(/\/+$/, "");
  } catch {
    return canonicalBaseUrl(clean).replace(/\/v1$/i, "");
  }
}

function isLegacyImageServiceDefaultBaseUrl(value: string) {
  const clean = value.trim();
  if (!clean) return false;
  try {
    const url = new URL(clean);
    const hostAliases = new Set(["localhost", "127.0.0.1"]);
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return hostAliases.has(url.hostname) && url.port === "9296" && (!path || path === "/v1");
  } catch {
    return false;
  }
}

function isCurrentProjectBaseUrl(value: string, backendBaseUrl: string) {
  const clean = comparableProjectBaseUrl(value);
  if (!clean) return true;
  const candidates = [backendBaseUrl, typeof window !== "undefined" ? window.location.origin : ""]
    .map((item) => comparableProjectBaseUrl(item))
    .filter(Boolean);
  return candidates.includes(clean);
}

function normalizeStoredProviderBaseUrl(value: unknown, backendBaseUrl: string, legacyImageDefault = false) {
  if (typeof value !== "string") return "";
  if (legacyImageDefault && isLegacyImageServiceDefaultBaseUrl(value)) return "";
  return isCurrentProjectBaseUrl(value, backendBaseUrl) ? "" : value;
}

function providerRequestBaseUrl(value: string, backendBaseUrl: string) {
  return isCurrentProjectBaseUrl(value, backendBaseUrl) ? "" : value.trim();
}

function readStoredPptProviderSettings(): StoredPptProviderSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PPT_PROVIDER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function taskHasActiveWork(task: PptTask | null) {
  if (!task) return false;
  if (task.status === "queued" || task.status === "running" || task.status === "packaging") return true;
  return task.slides.some((slide) => slide.status === "queued" || slide.status === "running");
}

function slideHasActiveWork(slide: PptSlide) {
  return slide.status === "queued" || slide.status === "running";
}

function formatBytes(value: unknown) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatImageDimensions(width: unknown, height: unknown) {
  const normalizedWidth = Number(width) || 0;
  const normalizedHeight = Number(height) || 0;
  return normalizedWidth > 0 && normalizedHeight > 0 ? `${normalizedWidth} x ${normalizedHeight}` : "";
}

function cleanMetadataTitle(value: unknown, fallback: string) {
  return String(value || "").replace(/\s+/g, " ").trim() || fallback;
}

function pptImageMetadataLabel(prefix: string, title: unknown, size: unknown, dimensions: string) {
  return [prefix, cleanMetadataTitle(title, "未命名页面"), formatBytes(size) || "图片大小获取中", dimensions || "图片尺寸获取中"].join(" · ");
}

function isImageResponse(headers: Headers) {
  const contentType = String(headers.get("content-type") || "").toLowerCase();
  return !contentType || contentType.startsWith("image/") || contentType === "application/octet-stream";
}

function safeImageDownloadName(prefix: string, title: unknown) {
  const safeTitle = cleanMetadataTitle(title, "PPT").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  return `${prefix}-${safeTitle}.png`;
}

function formatElapsedTime(startedAt: string | undefined, nowMs: number) {
  const startedMs = new Date(startedAt || "").getTime();
  if (!Number.isFinite(startedMs)) return "";
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function slideTaskKey(taskId: string, slideId: string) {
  return `${taskId}:${slideId}`;
}

function statusStyle(status: PptSlide["status"] | PptTask["status"]) {
  if (status === "draft") {
    return { label: "待生成", className: "border-stone-200 bg-stone-50 text-stone-600" };
  }
  if (status === "success" || status === "packaged") {
    return { label: status === "packaged" ? "已打包" : "成功", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  }
  if (status === "running" || status === "packaging") {
    return { label: status === "packaging" ? "打包中" : "生成中", className: "border-sky-200 bg-sky-50 text-sky-700" };
  }
  if (status === "queued") {
    return { label: "排队中", className: "border-slate-200 bg-slate-50 text-slate-600" };
  }
  if (status === "stopped") {
    return { label: "已停止", className: "border-stone-200 bg-stone-100 text-stone-600" };
  }
  return { label: "失败", className: "border-rose-200 bg-rose-50 text-rose-700" };
}

function taskStatusStyle(task: PptTask) {
  const progress = taskProgress(task);
  if (task.status === "error" && progress.success > 0 && progress.failed > 0) {
    return { label: "部分失败", className: "border-amber-200 bg-amber-50 text-amber-800" };
  }
  return statusStyle(task.status);
}

function slideNumberStyle(status?: PptSlide["status"] | "draft") {
  if (status === "draft") return "border-stone-200 bg-stone-50 text-stone-600";
  if (status === "success") return "border-emerald-200 bg-emerald-100 text-emerald-800";
  if (status === "running") return "border-sky-200 bg-sky-100 text-sky-800";
  if (status === "queued") return "border-amber-200 bg-amber-100 text-amber-800";
  if (status === "stopped") return "border-stone-200 bg-stone-100 text-stone-700";
  if (status === "error") return "border-rose-200 bg-rose-100 text-rose-800";
  return "border-stone-200 bg-white text-stone-600";
}

function taskToPlan(task: PptTask): PptPlan {
  return {
    slide_count: task.slide_count,
    design_concept: task.design_concept,
    global_style_prompt: task.global_style_prompt,
    chapters: task.chapters,
    slides: task.slides.map((slide) => ({
      slide_id: slide.slide_id,
      title: slide.title,
      layout_type: slide.layout_type,
      chapter_no: slide.chapter_no,
      chapter_title: slide.chapter_title,
      slide_prompt: slide.current_prompt || slide.original_prompt,
    })),
  };
}

function taskProgress(task: PptTask | null) {
  const slides = task?.slides ?? [];
  const total = slides.length || task?.slide_count || 0;
  const success = slides.filter((slide) => slide.status === "success").length;
  const running = slides.filter((slide) => slide.status === "running").length;
  const queued = slides.filter((slide) => slide.status === "queued").length;
  const failed = slides.filter((slide) => slide.status === "error").length;
  const stopped = slides.filter((slide) => slide.status === "stopped").length;
  return {
    total,
    success,
    running,
    queued,
    failed,
    stopped,
    percent: total > 0 ? Math.round((success / total) * 100) : 0,
  };
}

function pptWorkflowKey(task: PptTask) {
  return task.task_type === "master" ? task.id : task.master_task_id || task.id;
}

function taskStageRank(task: PptTask) {
  if (task.task_type === "master") return 1;
  if (task.task_type === "plan") return 2;
  return 3;
}

function taskStepStatus(task: PptTask | null): PptHistoryStepStatus {
  if (!task) return "pending";
  if (taskHasActiveWork(task)) return "running";
  if (task.status === "error") return "error";
  if (task.status === "success" || task.status === "packaged") return "success";
  return "pending";
}

function pickLatestTask(tasks: PptTask[]) {
  return [...tasks].sort((a, b) => {
    const stageDiff = taskStageRank(b) - taskStageRank(a);
    if (stageDiff !== 0) return stageDiff;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  })[0];
}

function buildPptHistoryItems(tasks: PptTask[]): PptHistoryItem[] {
  const groups = new Map<string, PptTask[]>();
  for (const item of tasks) {
    const key = pptWorkflowKey(item);
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  return Array.from(groups.entries())
    .map(([groupKey, groupTasks]) => {
      const displayTask = pickLatestTask(groupTasks);
      const master = groupTasks.find((item) => item.task_type === "master") || null;
      const plan = groupTasks.find((item) => item.task_type === "plan") || null;
      const content = pickLatestTask(groupTasks.filter((item) => item.task_type !== "master" && item.task_type !== "plan")) || null;
      const masterSnapshotReady = groupTasks.some((item) => item.master_slides?.length && item.master_slides.every((slide) => slide.status === "success" && slide.image_url));
      const steps: PptHistoryStep[] = [
        { key: "master", label: "生成母版", status: master ? taskStepStatus(master) : masterSnapshotReady ? "success" : "pending" },
        { key: "plan", label: "生成方案", status: plan ? taskStepStatus(plan) : content ? "success" : "pending" },
        { key: "content", label: "生成PPT", status: content ? taskStepStatus(content) : "pending" },
        {
          key: "package",
          label: "打包PPT",
          status: content?.status === "packaging" ? "running" : content?.pptx_ready || content?.status === "packaged" ? "success" : "pending",
        },
      ];
      const completed = steps.filter((step) => step.status === "success").length;
      const running = steps.some((step) => step.status === "running") ? 0.5 : 0;
      return {
        groupKey,
        displayTask,
        taskIds: groupTasks.map((item) => item.id),
        steps,
        progressPercent: Math.round(((completed + running) / steps.length) * 100),
        updatedAt: groupTasks.map((item) => item.updated_at || "").sort().at(-1) || displayTask.updated_at || "",
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function historyStepDotClass(status: PptHistoryStepStatus) {
  if (status === "success") return "border-stone-950 bg-stone-950";
  if (status === "running") return "border-sky-500 bg-sky-500";
  if (status === "error") return "border-rose-500 bg-rose-500";
  return "border-stone-300 bg-white";
}

function historyStepTextClass(status: PptHistoryStepStatus) {
  if (status === "success") return "text-stone-900";
  if (status === "running") return "text-sky-700";
  if (status === "error") return "text-rose-700";
  return "text-stone-400";
}

function taskToRestoredMasterTask(task: PptTask): PptTask | null {
  const masterSlides = task.master_slides ?? [];
  if (!masterSlides.length) return null;
  const allReady = masterSlides.every((slide) => slide.status === "success" && slide.image_url);
  return {
    id: task.master_task_id || `${task.id}:master`,
    name: `${task.name || task.id} 母版`,
    task_type: "master",
    master_confirmed: allReady,
    status: allReady ? "success" : "error",
    slide_count: masterSlides.length,
    design_concept: "PPT 母版审阅",
    global_style_prompt: task.global_style_prompt,
    master_style_prompt: task.master_style_prompt,
    model: task.model,
    size: task.size,
    concurrency: task.concurrency,
    image_base_url: task.image_base_url,
    created_at: task.created_at,
    updated_at: task.updated_at,
    pptx_ready: false,
    slides: masterSlides,
  };
}

function SlideSkeleton({ title, elapsed }: { title: string; elapsed?: string }) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-sky-100 bg-gradient-to-br from-white via-sky-50/70 to-emerald-50/50 p-4 sm:p-6">
      <div className="mb-3 flex shrink-0 flex-col items-center gap-1.5">
        <div className="max-w-full truncate text-center text-xs font-medium text-sky-700">{title}</div>
        {elapsed ? (
          <div className="flex items-center justify-center gap-1 text-[11px] text-sky-700/70">
            <Clock3 className="size-3" />
            耗时 {elapsed}
          </div>
        ) : null}
        <div className="h-2 w-24 rounded-full bg-sky-200/70" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.15fr] gap-4 sm:gap-6">
        <div className="flex flex-col justify-center gap-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3">
              <div className="h-8 w-14 rounded-lg bg-white shadow-sm ring-1 ring-sky-100" />
              <div className="h-px flex-1 bg-sky-200" />
              <div className="size-8 rounded-full bg-sky-100 shadow-inner" />
            </div>
          ))}
        </div>
        <div className="flex items-end gap-3 rounded-lg border border-white/70 bg-white/65 p-4 shadow-sm">
          {[42, 68, 54, 82, 63].map((height, index) => (
            <div key={index} className="flex flex-1 flex-col justify-end">
              <div className="rounded-t-md bg-sky-300/70" style={{ height: `${height}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 shrink-0">
        <div className="h-2 overflow-hidden rounded-full bg-stone-200/70">
          <div className="h-full w-2/3 animate-pulse rounded-full bg-sky-500/70" />
        </div>
      </div>
    </div>
  );
}

function SlideActionControls({
  disabled,
  compact = false,
  onInsertBefore,
  onDelete,
  onInsertAfter,
}: {
  disabled?: boolean;
  compact?: boolean;
  onInsertBefore: () => void;
  onDelete: () => void;
  onInsertAfter: () => void;
}) {
  const buttonClass = compact
    ? "size-7 rounded-md border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
    : "size-9 rounded-lg border-stone-200 bg-white text-stone-700 hover:bg-stone-50";
  const iconClass = compact ? "size-3.5" : "size-4";
  return (
    <div className="inline-flex items-center gap-1">
      <Button type="button" variant="outline" size="icon" className={buttonClass} disabled={disabled} title="在前面新增空白页" onClick={onInsertBefore}>
        <Plus className={iconClass} />
      </Button>
      <Button type="button" variant="outline" size="icon" className={cn(buttonClass, "text-rose-600 hover:bg-rose-50 hover:text-rose-700")} disabled={disabled} title="删除本页" onClick={onDelete}>
        <Trash2 className={iconClass} />
      </Button>
      <Button type="button" variant="outline" size="icon" className={buttonClass} disabled={disabled} title="在后面新增空白页" onClick={onInsertAfter}>
        <Plus className={iconClass} />
      </Button>
    </div>
  );
}

function PptPageContent() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slideImageUploadInputRef = useRef<HTMLInputElement>(null);
  const masterImageUploadInputRef = useRef<HTMLInputElement>(null);
  const referenceImageUploadInputRef = useRef<HTMLInputElement>(null);
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);
  const slideRefs = useRef<Record<string, HTMLElement | null>>({});
  const contentGridContainerRef = useRef<HTMLDivElement>(null);
  const imageEditButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const anchorButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dirtySlideIdsRef = useRef<Set<string>>(new Set());
  const planSaveTimeoutRef = useRef<number | null>(null);
  const lastSavedPlanJsonRef = useRef("");
  const anchorHoverTimeoutRef = useRef<number | null>(null);
  const pendingScrollSlideIdRef = useRef<string | null>(null);
  const pendingUploadSlideIdRef = useRef<string | null>(null);
  const pendingMasterUploadSlideIdRef = useRef<string | null>(null);
  const pendingReferenceUploadRef = useRef<{ taskId: string; slideId: string; mode: "master" | "content" } | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [markdownFileName, setMarkdownFileName] = useState("");
  const [slideCountMode, setSlideCountMode] = useState<"auto" | "manual">("auto");
  const [slideCount, setSlideCount] = useState(String(DEFAULT_SLIDES));
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY));
  const [tileSize, setTileSize] = useState(String(DEFAULT_TILE_SIZE));
  const [masterStylePrompt, setMasterStylePrompt] = useState(DEFAULT_MASTER_STYLE_PROMPT);
  const [textBaseUrl, setTextBaseUrl] = useState("");
  const [textApiKey, setTextApiKey] = useState("");
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [imageBaseUrl, setImageBaseUrl] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [imageProviderMode, setImageProviderMode] = useState<PptImageProviderMode>(DEFAULT_IMAGE_PROVIDER_MODE);
  const [imageAccountType, setImageAccountType] = useState<ImageAccountType>(DEFAULT_IMAGE_ACCOUNT_TYPE);
  const [imageResolution, setImageResolution] = useState<ImageResolution>(DEFAULT_IMAGE_RESOLUTION);
  const [imageQuality, setImageQuality] = useState<ImageQuality>(DEFAULT_IMAGE_QUALITY);
  const [masterTask, setMasterTask] = useState<PptTask | null>(null);
  const [plan, setPlan] = useState<PptPlan | null>(null);
  const [planTask, setPlanTask] = useState<PptTask | null>(null);
  const [task, setTask] = useState<PptTask | null>(null);
  const [savedTasks, setSavedTasks] = useState<PptTask[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<"grid" | "focus">("grid");
  const [reviewMode, setReviewMode] = useState<"master" | "content">("master");
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [selectedMasterSlideId, setSelectedMasterSlideId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isFullscreenEditorOpen, setIsFullscreenEditorOpen] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isCreatingMaster, setIsCreatingMaster] = useState(false);
  const [isConfirmingMaster, setIsConfirmingMaster] = useState(false);
  const [isCreatingPlan, setIsCreatingPlan] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<PptTask | null>(null);
  const [editingTaskNameId, setEditingTaskNameId] = useState<string | null>(null);
  const [taskNameDraft, setTaskNameDraft] = useState("");
  const [savingTaskNameId, setSavingTaskNameId] = useState<string | null>(null);
  const [isResumingTask, setIsResumingTask] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [isTextConfigOpen, setIsTextConfigOpen] = useState(false);
  const [isImageConfigOpen, setIsImageConfigOpen] = useState(false);
  const [providerSettingsLoaded, setProviderSettingsLoaded] = useState(false);
  const [backendBaseUrlHint, setBackendBaseUrlHint] = useState("");
  const [testingProvider, setTestingProvider] = useState<PptProviderKind | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<Partial<Record<PptProviderKind, PptProviderTestResult>>>({});
  const [regeneratingSlideId, setRegeneratingSlideId] = useState<string | null>(null);
  const [regeneratingMasterSlideId, setRegeneratingMasterSlideId] = useState<string | null>(null);
  const [mutatingSlideAction, setMutatingSlideAction] = useState<string | null>(null);
  const [hoveredAnchorSlideId, setHoveredAnchorSlideId] = useState<string | null>(null);
  const [anchorActionPlacement, setAnchorActionPlacement] = useState<AnchorActionPlacement | null>(null);
  const [imageEditSlideId, setImageEditSlideId] = useState<string | null>(null);
  const [imageEditPrompt, setImageEditPrompt] = useState("");
  const [isEditingSlideImage, setIsEditingSlideImage] = useState(false);
  const [imageEditPopoverPlacement, setImageEditPopoverPlacement] = useState<ImageEditPopoverPlacement | null>(null);
  const [imageEditPopoverCompact, setImageEditPopoverCompact] = useState(false);
  const [imageEditingSlideKeys, setImageEditingSlideKeys] = useState<Set<string>>(() => new Set());
  const [imageEditingSlidePrompts, setImageEditingSlidePrompts] = useState<Record<string, string>>({});
  const [uploadingSlideId, setUploadingSlideId] = useState<string | null>(null);
  const [uploadingMasterSlideId, setUploadingMasterSlideId] = useState<string | null>(null);
  const [uploadingReferenceKey, setUploadingReferenceKey] = useState<string | null>(null);
  const [deletingReferenceKey, setDeletingReferenceKey] = useState<string | null>(null);
  const [referencePreview, setReferencePreview] = useState<ReferencePreview | null>(null);
  const [isPackaging, setIsPackaging] = useState(false);
  const [contentPage, setContentPage] = useState(1);
  const [contentGridWidth, setContentGridWidth] = useState(0);
  const [pptLightboxScope, setPptLightboxScope] = useState<"master" | "content">("content");
  const [pptLightboxIndex, setPptLightboxIndex] = useState(0);
  const [pptLightboxOpen, setPptLightboxOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pptImageMetadata, setPptImageMetadata] = useState<Record<string, PptImageRuntimeMetadata>>({});

  const parsedSlideCount = useMemo(() => normalizeSlideCount(slideCount), [slideCount]);
  const parsedConcurrency = useMemo(() => normalizeConcurrency(concurrency), [concurrency]);
  const parsedTileSize = useMemo(() => normalizeTileSize(tileSize), [tileSize]);
  const isExternalImageProvider = imageProviderMode === "external";
  const imageProviderBaseUrl = isExternalImageProvider ? providerRequestBaseUrl(imageBaseUrl, backendBaseUrlHint) : "";
  const effectiveImageQuality = normalizeImageQuality(imageQuality);
  const effectivePptImageSize = maxImageOutputSizeForAspectRatio(PPT_IMAGE_ASPECT_RATIO);
  const imageProviderConfig = useMemo(
    () => ({
      imageBaseUrl: imageProviderBaseUrl,
      imageApiKey,
      imageModel,
      imageAccountType,
      imageSize: effectivePptImageSize,
      imageQuality: effectiveImageQuality,
    }),
    [effectiveImageQuality, effectivePptImageSize, imageAccountType, imageApiKey, imageModel, imageProviderBaseUrl],
  );
  const historyItems = useMemo(() => buildPptHistoryItems(savedTasks), [savedTasks]);
  const masterSlidesReady = Boolean(
    masterTask?.slides.length === PPT_MASTER_PAGE_COUNT &&
      masterTask.slides.every((slide) => slide.status === "success" && slide.image_url),
  );
  const masterConfirmed = Boolean(masterTask?.master_confirmed && masterSlidesReady);
  const planReady = Boolean(
    plan &&
      plan.slides.length === plan.slide_count &&
      plan.slides.every((slide) => slide.title.trim() && slide.slide_prompt.trim()),
  );
  const allSlidesSuccess = Boolean(task?.slides.length && task.slides.every((slide) => slide.status === "success"));
  const canPackage = Boolean(allSlidesSuccess && task?.status !== "packaging");
  const canResumeTask = Boolean(
    task &&
      !taskHasActiveWork(task) &&
      task.slides.some((slide) => slide.status !== "success" || !slide.image_url),
  );
  const progress = useMemo(() => taskProgress(task), [task]);
  const masterProgress = useMemo(() => taskProgress(masterTask), [masterTask]);
  const taskStatus = task ? taskStatusStyle(task) : null;
  const masterTaskStatus = masterTask ? taskStatusStyle(masterTask) : null;
  const masterElapsed = masterTask && taskHasActiveWork(masterTask) ? formatElapsedTime(masterTask.started_at || masterTask.created_at, nowMs) : "";
  const contentElapsed = task && taskHasActiveWork(task) ? formatElapsedTime(task.started_at || task.created_at, nowMs) : "";
  const anchors =
    task?.slides.map((slide, index) => ({ slide_id: slide.slide_id, title: slide.title, status: slide.status, displayIndex: index + 1 })) ??
    plan?.slides.map((slide, index) => ({ slide_id: slide.slide_id, title: slide.title, status: undefined, displayIndex: index + 1 })) ??
    [];
  const masterAnchors =
    masterTask?.slides.map((slide, index) => ({ slide_id: slide.slide_id, title: MASTER_LAYOUT_LABELS[slide.layout_type || slide.slide_id] || slide.title, status: slide.status, displayIndex: index + 1 })) ??
    [];
  const selectedSlideIndex = task?.slides.findIndex((slide) => slide.slide_id === selectedSlideId) ?? -1;
  const selectedSlide = selectedSlideIndex >= 0 ? task?.slides[selectedSlideIndex] : task?.slides[0];
  const selectedMasterSlideIndex = masterTask?.slides.findIndex((slide) => slide.slide_id === selectedMasterSlideId) ?? -1;
  const selectedMasterSlide = selectedMasterSlideIndex >= 0 ? masterTask?.slides[selectedMasterSlideIndex] : masterTask?.slides[0];
  const contentGridColumns = useMemo(() => {
    if (!contentGridWidth) return 1;
    return Math.max(1, Math.floor((contentGridWidth + CONTENT_GRID_GAP_PX) / (parsedTileSize + CONTENT_GRID_GAP_PX)));
  }, [contentGridWidth, parsedTileSize]);
  const contentPageSize = contentGridColumns * CONTENT_GRID_ROWS;
  const contentPageCount = Math.max(1, Math.ceil((task?.slides.length ?? 0) / contentPageSize));
  const safeContentPage = Math.min(contentPage, contentPageCount);
  const contentPageSlides = task?.slides.slice((safeContentPage - 1) * contentPageSize, safeContentPage * contentPageSize) ?? [];
  const masterLightboxImages = useMemo<PptLightboxImage[]>(
    () =>
      masterTask?.slides.flatMap((slide, index) =>
        slide.image_url
          ? (() => {
              const size = slide.image_size || pptImageMetadata[slide.image_url]?.size;
              const dimensions = formatImageDimensions(slide.image_width || pptImageMetadata[slide.image_url]?.width, slide.image_height || pptImageMetadata[slide.image_url]?.height);
              const title = MASTER_LAYOUT_LABELS[slide.layout_type || slide.slide_id] || slide.title;
              const prefix = `母版 ${index + 1}`;
              return [
                {
                  id: slide.slide_id,
                  src: slide.image_url,
                  metadataLabel: pptImageMetadataLabel(prefix, title, size, dimensions),
                  downloadName: safeImageDownloadName(prefix, title),
                  downloadTaskId: masterTask.id,
                  downloadSlideId: slide.slide_id,
                },
              ];
            })()
          : [],
      ) ?? [],
    [masterTask?.id, masterTask?.slides, pptImageMetadata],
  );
  const contentLightboxImages = useMemo<PptLightboxImage[]>(
    () =>
      task?.slides.flatMap((slide, index) =>
        slide.image_url
          ? (() => {
              const size = slide.image_size || pptImageMetadata[slide.image_url]?.size;
              const dimensions = formatImageDimensions(slide.image_width || pptImageMetadata[slide.image_url]?.width, slide.image_height || pptImageMetadata[slide.image_url]?.height);
              const prefix = `第 ${index + 1} 页`;
              return [
                {
                  id: slide.slide_id,
                  src: slide.image_url,
                  metadataLabel: pptImageMetadataLabel(prefix, slide.title, size, dimensions),
                  downloadName: safeImageDownloadName(prefix, slide.title),
                  downloadTaskId: task.id,
                  downloadSlideId: slide.slide_id,
                },
              ];
            })()
          : [],
      ) ?? [],
    [task?.id, task?.slides, pptImageMetadata],
  );
  const pptLightboxImages = pptLightboxScope === "master" ? masterLightboxImages : contentLightboxImages;
  const imageEditSlide = task?.slides.find((slide) => slide.slide_id === imageEditSlideId) ?? null;
  const markdownLabel = markdownFileName || (markdown.trim() ? "手动编辑的 Markdown" : "未导入 Markdown");

  const closeImageEdit = useCallback(() => {
    if (isEditingSlideImage) return;
    setImageEditSlideId(null);
    setImageEditPrompt("");
    setImageEditPopoverPlacement(null);
  }, [isEditingSlideImage]);

  const placeImageEditPopover = useCallback((anchor: HTMLElement, compact: boolean) => {
    const rect = anchor.getBoundingClientRect();
    const preferredWidth = compact ? 192 : 320;
    const viewportWidth = typeof window === "undefined" ? preferredWidth + 24 : window.innerWidth;
    const width = Math.max(160, Math.min(preferredWidth, viewportWidth - 24));
    const minLeft = 12;
    const maxLeft = Math.max(minLeft, viewportWidth - width - 12);
    const centeredLeft = rect.left + rect.width / 2 - width / 2;
    setImageEditPopoverPlacement({
      top: Math.max(12, rect.bottom + 8),
      left: Math.min(maxLeft, Math.max(minLeft, centeredLeft)),
      width,
    });
  }, []);

  const updateImageEditPopoverPosition = useCallback(() => {
    if (!imageEditSlideId) return;
    const anchor = imageEditButtonRefs.current[imageEditSlideId];
    if (!anchor) return;
    placeImageEditPopover(anchor, imageEditPopoverCompact);
  }, [imageEditPopoverCompact, imageEditSlideId, placeImageEditPopover]);

  const placeAnchorActions = useCallback((anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const preferredWidth = 112;
    const viewportWidth = typeof window === "undefined" ? preferredWidth + 24 : window.innerWidth;
    const width = Math.max(96, Math.min(preferredWidth, viewportWidth - 24));
    const minLeft = 12;
    const maxLeft = Math.max(minLeft, viewportWidth - width - 12);
    const centeredLeft = rect.left + rect.width / 2 - width / 2;
    setAnchorActionPlacement({
      top: Math.max(8, rect.top - 44),
      left: Math.min(maxLeft, Math.max(minLeft, centeredLeft)),
      width,
    });
  }, []);

  const updateAnchorActionPlacement = useCallback(() => {
    if (!hoveredAnchorSlideId) return;
    const anchor = anchorButtonRefs.current[hoveredAnchorSlideId];
    if (!anchor) return;
    placeAnchorActions(anchor);
  }, [hoveredAnchorSlideId, placeAnchorActions]);

  const handleNonImageEditInputFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target || !target.matches("input, textarea")) return;
    if (target.closest("[data-ppt-image-edit-popover='true']")) return;
    closeImageEdit();
  }, [closeImageEdit]);

  const updatePptImageMetadata = useCallback((src: string | undefined, patch: PptImageRuntimeMetadata) => {
    const key = String(src || "").trim();
    if (!key) return;
    setPptImageMetadata((current) => {
      const previous = current[key] || {};
      const next = { ...previous, ...patch };
      if (previous.size === next.size && previous.width === next.width && previous.height === next.height) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  const loadPptImageSize = useCallback(async (src: string) => {
    const key = src.trim();
    const cachedSize = Number(pptImageMetadata[key]?.size) || 0;
    if (!key || cachedSize > MIN_REASONABLE_PPT_IMAGE_BYTES) return;
    if (key.startsWith("data:")) {
      const payload = key.split(",", 2)[1] || "";
      const normalized = payload.replace(/\s/g, "");
      const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
      updatePptImageMetadata(key, { size: Math.max(0, Math.floor((normalized.length * 3) / 4) - padding) });
      return;
    }
    try {
      const head = await fetch(key, { method: "HEAD" });
      const length = Number(head.headers.get("content-length") || 0);
      if (head.ok && isImageResponse(head.headers) && Number.isFinite(length) && length > 0) {
        updatePptImageMetadata(key, { size: length });
        return;
      }
    } catch {
      // Some image endpoints do not allow HEAD; fall back to a blob request below.
    }
    try {
      const response = await fetch(key);
      if (!response.ok || !isImageResponse(response.headers)) {
        updatePptImageMetadata(key, {});
        return;
      }
      const blob = await response.blob();
      if (blob.size > 0) {
        updatePptImageMetadata(key, { size: blob.size });
      }
    } catch {
      updatePptImageMetadata(key, {});
    }
  }, [pptImageMetadata, updatePptImageMetadata]);

  useEffect(() => {
    const baseUrl = defaultBackendBaseUrl();
    const stored = readStoredPptProviderSettings();
    setBackendBaseUrlHint(baseUrl);
    setTextBaseUrl(normalizeStoredProviderBaseUrl(stored?.textBaseUrl, baseUrl));
    setTextApiKey(typeof stored?.textApiKey === "string" ? stored.textApiKey : "");
    setTextModel(typeof stored?.textModel === "string" && stored.textModel.trim() ? stored.textModel : DEFAULT_TEXT_MODEL);
    const storedImageBaseUrl = normalizeStoredProviderBaseUrl(stored?.imageBaseUrl, baseUrl, true);
    setImageBaseUrl(storedImageBaseUrl);
    setImageApiKey(typeof stored?.imageApiKey === "string" ? stored.imageApiKey : "");
    setImageModel(typeof stored?.imageModel === "string" && stored.imageModel.trim() ? stored.imageModel : DEFAULT_IMAGE_MODEL);
    setImageProviderMode(stored?.imageProviderMode ? normalizeImageProviderMode(stored.imageProviderMode) : storedImageBaseUrl ? "external" : DEFAULT_IMAGE_PROVIDER_MODE);
    setImageAccountType(normalizeImageAccountType(stored?.imageAccountType));
    setImageResolution(normalizeImageResolution(stored?.imageResolution));
    setImageQuality(normalizeImageQuality(stored?.imageQuality));
    setConcurrency(typeof stored?.concurrency === "string" && stored.concurrency.trim() ? stored.concurrency : String(DEFAULT_CONCURRENCY));
    setTileSize(typeof stored?.tileSize === "string" && stored.tileSize.trim() ? String(normalizeTileSize(stored.tileSize)) : String(DEFAULT_TILE_SIZE));
    setMasterStylePrompt(typeof stored?.masterStylePrompt === "string" && stored.masterStylePrompt.trim() ? stored.masterStylePrompt : DEFAULT_MASTER_STYLE_PROMPT);
    setIsTextConfigOpen(Boolean(stored?.isTextConfigOpen));
    setIsImageConfigOpen(Boolean(stored?.isImageConfigOpen));
    setProviderSettingsLoaded(true);
  }, []);

  const loadImageAccountTypes = useCallback(async () => {
    try {
      const data = await fetchImageAccountTypes();
      const nextTypes = normalizeImageAccountTypes(data.items);
      setImageAccountType((current) => (nextTypes.includes(current) ? current : nextTypes[0] ?? DEFAULT_IMAGE_ACCOUNT_TYPE));
    } catch {
      setImageAccountType(DEFAULT_IMAGE_ACCOUNT_TYPE);
    }
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      void loadImageAccountTypes();
    };

    void loadImageAccountTypes();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadImageAccountTypes]);

  useEffect(() => {
    if (!taskHasActiveWork(masterTask) && !taskHasActiveWork(task)) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [masterTask, task]);

  useEffect(() => {
    const urls = [
      ...(masterTask?.slides ?? []),
      ...(task?.slides ?? []),
    ]
      .map((slide) => slide.image_url || "")
      .filter(Boolean);
    for (const url of urls) {
      void loadPptImageSize(url);
    }
  }, [loadPptImageSize, masterTask?.slides, task?.slides]);

  useEffect(() => {
    if (!providerSettingsLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(
      PPT_PROVIDER_STORAGE_KEY,
      JSON.stringify({
        textBaseUrl: providerRequestBaseUrl(textBaseUrl, backendBaseUrlHint),
        textApiKey,
        textModel,
        imageBaseUrl: providerRequestBaseUrl(imageBaseUrl, backendBaseUrlHint),
        imageApiKey,
        imageModel,
        imageProviderMode,
        imageAccountType,
        imageResolution,
        imageQuality,
        concurrency,
        tileSize,
        masterStylePrompt,
        isTextConfigOpen,
        isImageConfigOpen,
      } satisfies StoredPptProviderSettings),
    );
  }, [
    concurrency,
    imageApiKey,
    imageAccountType,
    imageBaseUrl,
    imageProviderMode,
    imageQuality,
    imageModel,
    imageResolution,
    isImageConfigOpen,
    isTextConfigOpen,
    masterStylePrompt,
    backendBaseUrlHint,
    providerSettingsLoaded,
    textApiKey,
    textBaseUrl,
    textModel,
    tileSize,
  ]);

  useEffect(() => {
    const textarea = fullscreenTextareaRef.current;
    if (!textarea || !isFullscreenEditorOpen) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(520, textarea.scrollHeight)}px`;
  }, [markdown, isFullscreenEditorOpen]);

  const mergeTaskHistory = useCallback((nextTask: PptTask) => {
    setSavedTasks((current) => {
      const rest = current.filter((item) => item.id !== nextTask.id);
      return [nextTask, ...rest].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    });
  }, []);

  const applyTask = useCallback((nextTask: PptTask, preserveDirty = true) => {
    setTask(nextTask);
    mergeTaskHistory(nextTask);
    setPromptDrafts((current) => {
      const nextDrafts = { ...current };
      for (const slide of nextTask.slides) {
        const isDirty = dirtySlideIdsRef.current.has(slide.slide_id);
        if (!preserveDirty || !isDirty || nextDrafts[slide.slide_id] === undefined) {
          nextDrafts[slide.slide_id] = slide.current_prompt || "";
        }
      }
      return nextDrafts;
    });
  }, [mergeTaskHistory]);

  const applyMasterTask = useCallback((nextTask: PptTask) => {
    setMasterTask(nextTask);
    if (nextTask.master_style_prompt) {
      setMasterStylePrompt(nextTask.master_style_prompt);
    }
    mergeTaskHistory(nextTask);
  }, [mergeTaskHistory]);

  const applyPlanTask = useCallback((nextTask: PptTask) => {
    setPlanTask(nextTask);
    lastSavedPlanJsonRef.current = JSON.stringify(taskToPlan(nextTask));
    mergeTaskHistory(nextTask);
  }, [mergeTaskHistory]);

  const refreshTaskHistory = useCallback(async (silent = false) => {
    if (!silent) setIsLoadingTasks(true);
    try {
      const data = await fetchPptTasks([]);
      setSavedTasks(data.items);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "读取 PPT 历史任务失败");
    } finally {
      if (!silent) setIsLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    void refreshTaskHistory(true);
  }, [refreshTaskHistory]);

  useEffect(() => {
    return () => {
      if (anchorHoverTimeoutRef.current !== null) {
        window.clearTimeout(anchorHoverTimeoutRef.current);
      }
      if (planSaveTimeoutRef.current !== null) {
        window.clearTimeout(planSaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!imageEditSlideId) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-ppt-image-edit-popover='true'], [data-ppt-image-edit-trigger='true']")) return;
      closeImageEdit();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeImageEdit, imageEditSlideId]);

  useEffect(() => {
    if (!imageEditSlideId) return;
    updateImageEditPopoverPosition();
    window.addEventListener("resize", updateImageEditPopoverPosition);
    window.addEventListener("scroll", updateImageEditPopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updateImageEditPopoverPosition);
      window.removeEventListener("scroll", updateImageEditPopoverPosition, true);
    };
  }, [imageEditSlideId, updateImageEditPopoverPosition]);

  useEffect(() => {
    if (!hoveredAnchorSlideId) return;
    updateAnchorActionPlacement();
    window.addEventListener("resize", updateAnchorActionPlacement);
    window.addEventListener("scroll", updateAnchorActionPlacement, true);
    return () => {
      window.removeEventListener("resize", updateAnchorActionPlacement);
      window.removeEventListener("scroll", updateAnchorActionPlacement, true);
    };
  }, [hoveredAnchorSlideId, updateAnchorActionPlacement]);

  useEffect(() => {
    if (!taskHasActiveWork(task) || !task?.id) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await fetchPptTasks([task.id]);
        const nextTask = data.items[0];
        if (!cancelled && nextTask) applyTask(nextTask, true);
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "同步 PPT 任务失败");
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyTask, task, task?.id, task?.status, task?.updated_at]);

  useEffect(() => {
    if (!taskHasActiveWork(masterTask) || !masterTask?.id) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await fetchPptTasks([masterTask.id]);
        const nextTask = data.items[0];
        if (!cancelled && nextTask) applyMasterTask(nextTask);
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "同步母版任务失败");
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyMasterTask, masterTask, masterTask?.id, masterTask?.status, masterTask?.updated_at]);

  useEffect(() => {
    if (!planTask?.id || !plan || task) return;
    const serialized = JSON.stringify(plan);
    if (serialized === lastSavedPlanJsonRef.current) return;
    if (planSaveTimeoutRef.current !== null) {
      window.clearTimeout(planSaveTimeoutRef.current);
    }
    planSaveTimeoutRef.current = window.setTimeout(async () => {
      try {
        const nextTask = await updatePptPlanTask(planTask.id, plan);
        applyPlanTask(nextTask);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "保存方案修改失败");
      } finally {
        planSaveTimeoutRef.current = null;
      }
    }, 700);
    return () => {
      if (planSaveTimeoutRef.current !== null) {
        window.clearTimeout(planSaveTimeoutRef.current);
        planSaveTimeoutRef.current = null;
      }
    };
  }, [applyPlanTask, plan, planTask?.id, task]);

  useEffect(() => {
    if (!task?.slides.length) {
      setSelectedSlideId(null);
      return;
    }
    if (!selectedSlideId || !task.slides.some((slide) => slide.slide_id === selectedSlideId)) {
      setSelectedSlideId(task.slides[0].slide_id);
    }
  }, [task?.id, task?.slides, selectedSlideId]);

  useEffect(() => {
    if (!masterTask?.slides.length) {
      setSelectedMasterSlideId(null);
      return;
    }
    if (!selectedMasterSlideId || !masterTask.slides.some((slide) => slide.slide_id === selectedMasterSlideId)) {
      setSelectedMasterSlideId(masterTask.slides[0].slide_id);
    }
  }, [masterTask?.id, masterTask?.slides, selectedMasterSlideId]);

  useEffect(() => {
    setContentPage(1);
  }, [task?.id]);

  useEffect(() => {
    setContentPage((current) => Math.min(Math.max(1, current), contentPageCount));
  }, [contentPageCount]);

  useEffect(() => {
    if (reviewMode !== "content" || !task) return;
    const node = contentGridContainerRef.current;
    if (!node) return;

    const updateWidth = () => setContentGridWidth(node.clientWidth);
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, [parsedTileSize, reviewMode, task?.id, task]);

  useEffect(() => {
    const slideId = pendingScrollSlideIdRef.current;
    if (!slideId) return;
    const node = slideRefs.current[slideId];
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    pendingScrollSlideIdRef.current = null;
  }, [contentPageSlides, safeContentPage]);

  useEffect(() => {
    if (!pptLightboxOpen) return;
    if (pptLightboxImages.length === 0) {
      setPptLightboxOpen(false);
      return;
    }
    setPptLightboxIndex((current) => Math.min(current, pptLightboxImages.length - 1));
  }, [pptLightboxImages.length, pptLightboxOpen]);

  useEffect(() => {
    if (!task) {
      setImageEditingSlideKeys((current) => (current.size ? new Set() : current));
      setImageEditingSlidePrompts((current) => (Object.keys(current).length ? {} : current));
      return;
    }
    const activeKeys = new Set(task.slides.filter(slideHasActiveWork).map((slide) => slideTaskKey(task.id, slide.slide_id)));
    setImageEditingSlideKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        if (activeKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setImageEditingSlidePrompts((current) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [key, prompt] of Object.entries(current)) {
        if (activeKeys.has(key)) {
          next[key] = prompt;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [task]);

  const moveSelectedSlide = useCallback((direction: -1 | 1) => {
    if (!task?.slides.length) return;
    const currentIndex = Math.max(0, task.slides.findIndex((slide) => slide.slide_id === selectedSlideId));
    const nextIndex = (currentIndex + direction + task.slides.length) % task.slides.length;
    setSelectedSlideId(task.slides[nextIndex].slide_id);
  }, [selectedSlideId, task?.slides]);

  const moveSelectedMasterSlide = useCallback((direction: -1 | 1) => {
    if (!masterTask?.slides.length) return;
    const currentIndex = Math.max(0, masterTask.slides.findIndex((slide) => slide.slide_id === selectedMasterSlideId));
    const nextIndex = (currentIndex + direction + masterTask.slides.length) % masterTask.slides.length;
    setSelectedMasterSlideId(masterTask.slides[nextIndex].slide_id);
  }, [masterTask?.slides, selectedMasterSlideId]);

  useEffect(() => {
    if (viewMode !== "focus" || reviewMode !== "content" || !task?.slides.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelectedSlide(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelectedSlide(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [moveSelectedSlide, reviewMode, task?.slides.length, viewMode]);

  useEffect(() => {
    if (viewMode !== "focus" || reviewMode !== "master" || !masterTask?.slides.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelectedMasterSlide(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelectedMasterSlide(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [masterTask?.slides.length, moveSelectedMasterSlide, reviewMode, viewMode]);

  const handlePickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setMarkdown(await file.text());
      setMarkdownFileName(file.name);
      toast.success("已读取 Markdown");
    } catch {
      toast.error("读取 Markdown 失败");
    } finally {
      event.target.value = "";
    }
  };

  const handleMarkdownChange = (value: string) => {
    setMarkdown(value);
    if (!markdownFileName && value.trim()) {
      setMarkdownFileName("手动编辑的 Markdown");
    }
  };

  const ensureImageProviderReady = () => {
    if (!isExternalImageProvider) return true;
    if (!imageProviderBaseUrl || !imageApiKey.trim()) {
      setIsImageConfigOpen(true);
      toast.error("使用外部 API 服务时，请填写图片接口地址和 API Key");
      return false;
    }
    return true;
  };

  const handleCreateMasterTask = async () => {
    if (!ensureImageProviderReady()) return;
    const count = parsedConcurrency;
    const clientTaskId = `ppt-master-${createId()}`;
    setConcurrency(String(count));
    setIsCreatingMaster(true);
    try {
      const nextTask = await createPptMasterTask(
        clientTaskId,
        count,
        imageProviderConfig,
        { name: markdownFileName ? `${markdownFileName} 母版` : "PPT 母版", stylePrompt: masterStylePrompt.trim() },
      );
      applyMasterTask(nextTask);
      setPlan(null);
      setPlanTask(null);
      setTask(null);
      setReviewMode("master");
      setSelectedSlideId(null);
      dirtySlideIdsRef.current.clear();
      setPromptDrafts({});
      toast.success(`已创建 ${PPT_MASTER_PAGE_COUNT} 张 PPT 母版`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建母版任务失败");
    } finally {
      setIsCreatingMaster(false);
    }
  };

  const handleConfirmMaster = async () => {
    if (!masterTask) return;
    setIsConfirmingMaster(true);
    try {
      const nextTask = await confirmPptMasterTask(masterTask.id);
      applyMasterTask(nextTask);
      setReviewMode("content");
      toast.success("母版已确认，可以生成内容方案");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认母版失败");
    } finally {
      setIsConfirmingMaster(false);
    }
  };

  const handleCreatePlan = async () => {
    const source = markdown.trim();
    if (!source) {
      toast.error("请先输入 Markdown");
      return;
    }
    if (!masterConfirmed || !masterTask) {
      toast.error(`请先在母版审阅中确认 ${PPT_MASTER_PAGE_COUNT} 张母版`);
      setReviewMode("master");
      return;
    }
    const count = slideCountMode === "auto" ? "auto" : parsedSlideCount;
    if (slideCountMode === "manual") {
      setSlideCount(String(parsedSlideCount));
    }
    const clientTaskId = `ppt-plan-${createId()}`;
    setIsCreatingPlan(true);
    try {
      const data = await createPptPlan(
        source,
        count,
        {
          textBaseUrl: providerRequestBaseUrl(textBaseUrl, backendBaseUrlHint),
          textApiKey,
          textModel,
        },
        masterTask.id,
        {
          clientTaskId,
          name: markdownFileName ? `${markdownFileName} 方案` : "PPT 方案",
          markdownFileName,
        },
      );
      setPlan(data.plan);
      if (data.task) {
        applyPlanTask(data.task);
      } else {
        setPlanTask(null);
        lastSavedPlanJsonRef.current = "";
      }
      setTask(null);
      setSelectedSlideId(null);
      setViewMode("grid");
      setReviewMode("content");
      dirtySlideIdsRef.current.clear();
      setPromptDrafts({});
      toast.success(`已生成 ${data.plan.slide_count} 页设计方案`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "生成方案失败");
    } finally {
      setIsCreatingPlan(false);
    }
  };

  const handleCreateTask = async () => {
    if (!plan || !masterTask) return;
    if (!ensureImageProviderReady()) return;
    if (!masterConfirmed) {
      toast.error("请先确认母版");
      setReviewMode("master");
      return;
    }
    const count = parsedConcurrency;
    const clientTaskId = `ppt-${createId()}`;
    setConcurrency(String(count));
    setIsCreatingTask(true);
    try {
      if (planTask?.id) {
        const serialized = JSON.stringify(plan);
        if (serialized !== lastSavedPlanJsonRef.current) {
          if (planSaveTimeoutRef.current !== null) {
            window.clearTimeout(planSaveTimeoutRef.current);
            planSaveTimeoutRef.current = null;
          }
          const savedPlanTask = await updatePptPlanTask(planTask.id, plan);
          applyPlanTask(savedPlanTask);
        }
      }
      const nextTask = await createPptTask(
        clientTaskId,
        plan,
        count,
        imageProviderConfig,
        {
          name: markdownFileName || plan.slides[0]?.title || clientTaskId,
          markdown,
          markdownFileName,
          masterTaskId: masterTask.id,
        },
      );
      dirtySlideIdsRef.current.clear();
      applyTask(nextTask, false);
      toast.success("已开始逐页生成图片");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 PPT 任务失败");
    } finally {
      setIsCreatingTask(false);
    }
  };

  const requestDeleteTask = (event: MouseEvent, item: PptTask) => {
    event.stopPropagation();
    setPendingDeleteTask(item);
  };

  const handleDeleteTask = async () => {
    const targetTask = pendingDeleteTask;
    if (!targetTask) return;
    const groupKey = pptWorkflowKey(targetTask);
    const taskIds = Array.from(
      new Set(savedTasks.filter((item) => pptWorkflowKey(item) === groupKey).map((item) => item.id)),
    );
    const deleteIds = taskIds.length > 0 ? taskIds : [targetTask.id];
    setDeletingTaskId(targetTask.id);
    try {
      for (const taskId of deleteIds) {
        await deletePptTask(taskId);
      }
      setSavedTasks((current) => current.filter((item) => !deleteIds.includes(item.id)));
      if (masterTask?.id && deleteIds.includes(masterTask.id)) {
        setMasterTask(null);
        setSelectedMasterSlideId(null);
        setReviewMode("master");
      }
      if (planTask?.id && deleteIds.includes(planTask.id)) {
        setPlanTask(null);
        setPlan(null);
        lastSavedPlanJsonRef.current = "";
      }
      if (task?.id && deleteIds.includes(task.id)) {
        setTask(null);
        setPlan(null);
        setSelectedSlideId(null);
      }
      toast.success("历史任务已删除");
      setPendingDeleteTask(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除 PPT 任务失败");
    } finally {
      setDeletingTaskId(null);
    }
  };

  const handleResumeTask = async () => {
    if (!task) return;
    if (!ensureImageProviderReady()) return;
    setIsResumingTask(true);
    try {
      const nextTask = await resumePptTask(task.id, parsedConcurrency, {
        ...imageProviderConfig,
      });
      applyTask(nextTask, false);
      toast.success("已继续生成未完成页面");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复继续生成失败");
    } finally {
      setIsResumingTask(false);
    }
  };

  const handleStopTask = async (targetTask: PptTask | null, mode: "master" | "content") => {
    if (!targetTask) return;
    setStoppingTaskId(targetTask.id);
    try {
      const nextTask = await stopPptTask(targetTask.id);
      if (mode === "master") {
        applyMasterTask(nextTask);
      } else {
        applyTask(nextTask, false);
      }
      toast.success("已停止任务");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "停止任务失败");
    } finally {
      setStoppingTaskId(null);
    }
  };

  const saveMasterPromptDraft = async (slide: PptSlide, ownerTask = masterTask) => {
    if (!ownerTask || taskHasActiveWork(ownerTask)) return ownerTask;
    if (!dirtySlideIdsRef.current.has(slide.slide_id)) return ownerTask;
    const prompt = (promptDrafts[slide.slide_id] || "").trim();
    if (!prompt || prompt === (slide.current_prompt || "").trim()) {
      dirtySlideIdsRef.current.delete(slide.slide_id);
      return ownerTask;
    }
    const nextTask = await updatePptSlidePrompt(ownerTask.id, slide.slide_id, prompt);
    dirtySlideIdsRef.current.delete(slide.slide_id);
    applyMasterTask(nextTask);
    return nextTask;
  };

  const saveAllMasterPromptDrafts = async () => {
    if (!masterTask) return masterTask;
    let nextTask = masterTask;
    for (const slide of masterTask.slides) {
      const savedTask = await saveMasterPromptDraft(slide, nextTask);
      if (!savedTask) break;
      nextTask = savedTask;
    }
    return nextTask;
  };

  const handleStartMasterGeneration = async () => {
    if (!masterTask) return;
    if (!ensureImageProviderReady()) return;
    setIsResumingTask(true);
    try {
      const savedMasterTask = await saveAllMasterPromptDrafts();
      if (!savedMasterTask) return;
      const nextTask = await resumePptTask(savedMasterTask.id, parsedConcurrency, {
        ...imageProviderConfig,
      });
      applyMasterTask(nextTask);
      setReviewMode("master");
      toast.success("已开始生成母版图片");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "开始生成母版失败");
    } finally {
      setIsResumingTask(false);
    }
  };

  const handleRestoreTask = (nextTask: PptTask) => {
    dirtySlideIdsRef.current.clear();
    if (nextTask.task_type === "master") {
      setMarkdown("");
      setMarkdownFileName("");
      setPlan(null);
      setPlanTask(null);
      setTask(null);
      applyMasterTask(nextTask);
      setConcurrency(String(nextTask.concurrency || DEFAULT_CONCURRENCY));
      setImageBaseUrl(nextTask.image_base_url || "");
      setImageModel(nextTask.model || DEFAULT_IMAGE_MODEL);
      setImageProviderMode(nextTask.image_base_url ? "external" : "builtin");
      setImageAccountType(normalizeImageAccountType(nextTask.account_type));
      setImageResolution(imageResolutionFromPptSize(nextTask.size));
      setImageQuality(normalizeImageQuality(nextTask.quality));
      setSlideCountMode("auto");
      setSlideCount(String(DEFAULT_SLIDES));
      setSelectedSlideId(null);
      setSelectedMasterSlideId(nextTask.slides[0]?.slide_id ?? null);
      setReviewMode("master");
      closeImageEdit();
      toast.success("已恢复 PPT 母版任务");
      return;
    }
    if (nextTask.task_type === "plan") {
      const restoredMasterTask = taskToRestoredMasterTask(nextTask);
      setMarkdown(nextTask.markdown || "");
      setMarkdownFileName(nextTask.markdown_file_name || (nextTask.markdown ? "恢复的 Markdown" : ""));
      setPlan(taskToPlan(nextTask));
      applyPlanTask(nextTask);
      setMasterTask(restoredMasterTask);
      if (restoredMasterTask?.master_style_prompt) {
        setMasterStylePrompt(restoredMasterTask.master_style_prompt);
      }
      setTask(null);
      setConcurrency(String(nextTask.concurrency || DEFAULT_CONCURRENCY));
      setImageBaseUrl("");
      setImageModel(DEFAULT_IMAGE_MODEL);
      setImageProviderMode(DEFAULT_IMAGE_PROVIDER_MODE);
      setImageAccountType(DEFAULT_IMAGE_ACCOUNT_TYPE);
      setImageResolution(DEFAULT_IMAGE_RESOLUTION);
      setImageQuality(DEFAULT_IMAGE_QUALITY);
      setSlideCountMode("manual");
      setSlideCount(String(nextTask.slide_count || DEFAULT_SLIDES));
      setSelectedSlideId(nextTask.slides[0]?.slide_id ?? null);
      setSelectedMasterSlideId(restoredMasterTask?.slides[0]?.slide_id ?? null);
      setReviewMode("content");
      setViewMode("grid");
      closeImageEdit();
      toast.success("已恢复 PPT 方案任务");
      return;
    }
    setMarkdown(nextTask.markdown || "");
    setMarkdownFileName(nextTask.markdown_file_name || (nextTask.markdown ? "恢复的 Markdown" : ""));
    setPlan(taskToPlan(nextTask));
    setPlanTask(null);
    const restoredMasterTask = taskToRestoredMasterTask(nextTask);
    setMasterTask(restoredMasterTask);
    if (restoredMasterTask?.master_style_prompt) {
      setMasterStylePrompt(restoredMasterTask.master_style_prompt);
    }
    setConcurrency(String(nextTask.concurrency || DEFAULT_CONCURRENCY));
    setImageBaseUrl(nextTask.image_base_url || "");
    setImageModel(nextTask.model || DEFAULT_IMAGE_MODEL);
    setImageProviderMode(nextTask.image_base_url ? "external" : "builtin");
    setImageAccountType(normalizeImageAccountType(nextTask.account_type));
    setImageResolution(imageResolutionFromPptSize(nextTask.size));
    setImageQuality(normalizeImageQuality(nextTask.quality));
    setSlideCountMode("manual");
    setSlideCount(String(nextTask.slide_count || DEFAULT_SLIDES));
    setSelectedSlideId(nextTask.slides[0]?.slide_id ?? null);
    setSelectedMasterSlideId(restoredMasterTask?.slides[0]?.slide_id ?? null);
    setReviewMode("content");
    closeImageEdit();
    applyTask(nextTask, false);
    toast.success("已恢复 PPT 任务");
  };

  const handleNewTask = () => {
    dirtySlideIdsRef.current.clear();
    setMarkdown("");
    setMarkdownFileName("");
    setSlideCountMode("auto");
    setSlideCount(String(DEFAULT_SLIDES));
    setMasterStylePrompt(DEFAULT_MASTER_STYLE_PROMPT);
    setMasterTask(null);
    setPlan(null);
    setPlanTask(null);
    setTask(null);
    setPromptDrafts({});
    setSelectedSlideId(null);
    setSelectedMasterSlideId(null);
    setViewMode("grid");
    setReviewMode("master");
    setRegeneratingSlideId(null);
    setRegeneratingMasterSlideId(null);
    setMutatingSlideAction(null);
    setHoveredAnchorSlideId(null);
    setImageEditingSlideKeys(new Set());
    setImageEditingSlidePrompts({});
    setUploadingSlideId(null);
    setUploadingMasterSlideId(null);
    setUploadingReferenceKey(null);
    setDeletingReferenceKey(null);
    setReferencePreview(null);
    closeImageEdit();
    toast.success("已进入新任务");
  };

  const handleStartEditTaskName = (event: MouseEvent, item: PptTask) => {
    event.stopPropagation();
    closeImageEdit();
    setEditingTaskNameId(item.id);
    setTaskNameDraft(item.name || item.id);
  };

  const handleCancelEditTaskName = () => {
    setEditingTaskNameId(null);
    setTaskNameDraft("");
  };

  const handleSubmitTaskName = async (taskId: string) => {
    const name = taskNameDraft.trim();
    if (!name) {
      toast.error("请输入任务名称");
      return;
    }
    const currentName = savedTasks.find((item) => item.id === taskId)?.name || taskId;
    if (name === currentName) {
      handleCancelEditTaskName();
      return;
    }
    setSavingTaskNameId(taskId);
    try {
      const nextTask = await updatePptTaskName(taskId, name);
      mergeTaskHistory(nextTask);
      if (task?.id === taskId) {
        setTask(nextTask);
      }
      if (masterTask?.id === taskId) {
        setMasterTask(nextTask);
      }
      if (planTask?.id === taskId) {
        setPlanTask(nextTask);
      }
      handleCancelEditTaskName();
      toast.success("任务名称已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新任务名称失败");
    } finally {
      setSavingTaskNameId(null);
    }
  };

  const handlePromptDraftChange = (slideId: string, value: string) => {
    dirtySlideIdsRef.current.add(slideId);
    setPromptDrafts((current) => ({ ...current, [slideId]: value }));
  };

  const handlePlanTextChange = (field: "design_concept", value: string) => {
    setPlan((current) => (current ? { ...current, [field]: value } : current));
  };

  const handlePlanSlideChange = (slideId: string, field: "title" | "slide_prompt", value: string) => {
    setPlan((current) => {
      if (!current) return current;
      return {
        ...current,
        slides: current.slides.map((slide) => (slide.slide_id === slideId ? { ...slide, [field]: value } : slide)),
      };
    });
  };

  const handleRegenerateSlide = async (slide: PptSlide) => {
    if (!task) return;
    const prompt = (promptDrafts[slide.slide_id] || "").trim();
    if (!prompt) {
      toast.error("请输入这一页的提示词");
      return;
    }
    setRegeneratingSlideId(slide.slide_id);
    try {
      const nextTask = await regeneratePptSlide(task.id, slide.slide_id, prompt);
      dirtySlideIdsRef.current.delete(slide.slide_id);
      applyTask(nextTask, false);
      toast.success(`第 ${slide.slide_id} 页已重新加入队列`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新生成失败");
    } finally {
      setRegeneratingSlideId(null);
    }
  };

  const handleRegenerateMasterSlide = async (slide: PptSlide) => {
    if (!masterTask) return;
    const prompt = (promptDrafts[slide.slide_id] || slide.current_prompt || "").trim();
    if (!prompt) {
      toast.error("请输入母版提示词");
      return;
    }
    setRegeneratingMasterSlideId(slide.slide_id);
    try {
      const nextTask = await regeneratePptSlide(masterTask.id, slide.slide_id, prompt);
      dirtySlideIdsRef.current.delete(slide.slide_id);
      applyMasterTask(nextTask);
      toast.success(`${MASTER_LAYOUT_LABELS[slide.layout_type || slide.slide_id] || slide.title} 已重新加入队列`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新生成母版失败");
    } finally {
      setRegeneratingMasterSlideId(null);
    }
  };

  const handleInsertBlankSlide = async (slideId: string, position: "before" | "after") => {
    if (!task) return;
    const actionKey = `${slideId}:insert:${position}`;
    setMutatingSlideAction(actionKey);
    try {
      const nextTask = await insertBlankPptSlide(task.id, slideId, position);
      const insertedSlide = nextTask.slides.find((slide) => !task.slides.some((current) => current.slide_id === slide.slide_id));
      dirtySlideIdsRef.current.clear();
      applyTask(nextTask, false);
      if (insertedSlide) {
        setSelectedSlideId(insertedSlide.slide_id);
      }
      toast.success(position === "before" ? "已在前面新增空白页" : "已在后面新增空白页");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新增空白页失败");
    } finally {
      setMutatingSlideAction(null);
    }
  };

  const handleDeleteSlide = async (slideId: string) => {
    if (!task) return;
    const actionKey = `${slideId}:delete`;
    const currentIndex = task.slides.findIndex((slide) => slide.slide_id === slideId);
    setMutatingSlideAction(actionKey);
    try {
      const nextTask = await deletePptSlide(task.id, slideId);
      dirtySlideIdsRef.current.delete(slideId);
      applyTask(nextTask, false);
      if (selectedSlideId === slideId) {
        const nextIndex = Math.min(Math.max(currentIndex, 0), nextTask.slides.length - 1);
        setSelectedSlideId(nextTask.slides[nextIndex]?.slide_id ?? null);
      }
      toast.success("已删除本页");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除页面失败");
    } finally {
      setMutatingSlideAction(null);
    }
  };

  const showAnchorActions = (slideId: string) => {
    if (anchorHoverTimeoutRef.current !== null) {
      window.clearTimeout(anchorHoverTimeoutRef.current);
      anchorHoverTimeoutRef.current = null;
    }
    setHoveredAnchorSlideId(slideId);
    const anchor = anchorButtonRefs.current[slideId];
    if (anchor) placeAnchorActions(anchor);
  };

  const scheduleHideAnchorActions = () => {
    if (anchorHoverTimeoutRef.current !== null) {
      window.clearTimeout(anchorHoverTimeoutRef.current);
    }
    anchorHoverTimeoutRef.current = window.setTimeout(() => {
      setHoveredAnchorSlideId(null);
      setAnchorActionPlacement(null);
      anchorHoverTimeoutRef.current = null;
    }, ANCHOR_ACTION_HIDE_DELAY_MS);
  };

  const handleOpenImageEdit = (slide: PptSlide, anchor: HTMLButtonElement, compact: boolean) => {
    if (!slide.image_url) return;
    setImageEditPopoverCompact(compact);
    placeImageEditPopover(anchor, compact);
    if (imageEditSlideId === slide.slide_id) return;
    setImageEditSlideId(slide.slide_id);
    setImageEditPrompt("");
  };

  const handleSubmitImageEdit = async () => {
    if (!task || !imageEditSlide) return;
    const prompt = imageEditPrompt.trim();
    if (!prompt) {
      toast.error("请输入图生图描述");
      return;
    }
    const editingKey = slideTaskKey(task.id, imageEditSlide.slide_id);
    setImageEditingSlideKeys((current) => new Set(current).add(editingKey));
    setImageEditingSlidePrompts((current) => ({ ...current, [editingKey]: prompt }));
    setIsEditingSlideImage(true);
    try {
      const nextTask = await editPptSlideImage(task.id, imageEditSlide.slide_id, prompt);
      applyTask(nextTask, true);
      setSelectedSlideId(imageEditSlide.slide_id);
      setImageEditSlideId(null);
      setImageEditPrompt("");
      toast.success("已提交图生图生成");
    } catch (error) {
      setImageEditingSlideKeys((current) => {
        if (!current.has(editingKey)) return current;
        const next = new Set(current);
        next.delete(editingKey);
        return next;
      });
      setImageEditingSlidePrompts((current) => {
        if (!(editingKey in current)) return current;
        const { [editingKey]: _removed, ...rest } = current;
        return rest;
      });
      toast.error(error instanceof Error ? error.message : "图生图失败");
    } finally {
      setIsEditingSlideImage(false);
    }
  };

  const handleStartSlideUpload = (slideId: string) => {
    pendingUploadSlideIdRef.current = slideId;
    slideImageUploadInputRef.current?.click();
  };

  const handleStartMasterUpload = (slideId: string) => {
    pendingMasterUploadSlideIdRef.current = slideId;
    masterImageUploadInputRef.current?.click();
  };

  const handleStartReferenceUpload = (ownerTask: PptTask | null, slideId: string, mode: "master" | "content") => {
    if (!ownerTask) return;
    if (taskHasActiveWork(ownerTask)) {
      toast.error("图片生成过程中不能修改参考图");
      return;
    }
    pendingReferenceUploadRef.current = { taskId: ownerTask.id, slideId, mode };
    referenceImageUploadInputRef.current?.click();
  };

  const handleSlideImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const slideId = pendingUploadSlideIdRef.current;
    event.target.value = "";
    pendingUploadSlideIdRef.current = null;
    if (!task || !slideId || !file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    setUploadingSlideId(slideId);
    try {
      const dataUrl = await fileToDataUrl(file);
      const nextTask = await uploadPptSlideImage(task.id, slideId, dataUrl);
      applyTask(nextTask, false);
      setSelectedSlideId(slideId);
      toast.success("图片已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传图片失败");
    } finally {
      setUploadingSlideId(null);
    }
  };

  const handleMasterImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const slideId = pendingMasterUploadSlideIdRef.current;
    event.target.value = "";
    pendingMasterUploadSlideIdRef.current = null;
    if (!masterTask || !slideId || !file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    setUploadingMasterSlideId(slideId);
    try {
      const dataUrl = await fileToDataUrl(file);
      const nextTask = await uploadPptSlideImage(masterTask.id, slideId, dataUrl);
      applyMasterTask(nextTask);
      toast.success("母版图片已上传");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传母版图片失败");
    } finally {
      setUploadingMasterSlideId(null);
    }
  };

  const handleReferenceImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const pending = pendingReferenceUploadRef.current;
    event.target.value = "";
    pendingReferenceUploadRef.current = null;
    if (!pending || !file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    const actionKey = `${pending.taskId}:${pending.slideId}:upload-reference`;
    setUploadingReferenceKey(actionKey);
    try {
      const dataUrl = await fileToDataUrl(file);
      const nextTask = await uploadPptSlideReference(pending.taskId, pending.slideId, dataUrl, file.name || "用户参考图");
      if (pending.mode === "master") {
        applyMasterTask(nextTask);
      } else {
        applyTask(nextTask, false);
      }
      toast.success("参考图已添加");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传参考图失败");
    } finally {
      setUploadingReferenceKey(null);
    }
  };

  const handleDeleteReference = async (ownerTask: PptTask | null, slideId: string, referenceId: string, mode: "master" | "content") => {
    if (!ownerTask) return;
    const targetSlide = ownerTask.slides.find((slide) => slide.slide_id === slideId);
    if (taskHasActiveWork(ownerTask) || (targetSlide && slideHasActiveWork(targetSlide))) {
      toast.error("图片生成过程中不能移除参考图");
      return;
    }
    const actionKey = `${ownerTask.id}:${slideId}:${referenceId}`;
    setDeletingReferenceKey(actionKey);
    try {
      const nextTask = await deletePptSlideReference(ownerTask.id, slideId, referenceId);
      if (mode === "master") {
        applyMasterTask(nextTask);
      } else {
        applyTask(nextTask, false);
      }
      toast.success("参考图已移除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除参考图失败");
    } finally {
      setDeletingReferenceKey(null);
    }
  };

  const handlePackage = async () => {
    if (!task) return;
    setIsPackaging(true);
    try {
      const nextTask = await packagePptTask(task.id);
      applyTask(nextTask, false);
      await downloadPptTask(nextTask.id);
      toast.success("PPTX 已打包");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打包 PPTX 失败");
    } finally {
      setIsPackaging(false);
    }
  };

  const handleDownload = async () => {
    if (!task) return;
    try {
      await downloadPptTask(task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载 PPTX 失败");
    }
  };

  const scrollToSlide = (slideId: string) => {
    setSelectedSlideId(slideId);
    const slideIndex = task?.slides.findIndex((slide) => slide.slide_id === slideId) ?? -1;
    if (slideIndex >= 0) {
      setContentPage(Math.floor(slideIndex / contentPageSize) + 1);
    }
    pendingScrollSlideIdRef.current = slideId;
  };

  const openContentLightbox = (slideId: string) => {
    const index = contentLightboxImages.findIndex((item) => item.id === slideId);
    if (index < 0) return;
    setSelectedSlideId(slideId);
    setPptLightboxScope("content");
    setPptLightboxIndex(index);
    setPptLightboxOpen(true);
  };

  const openMasterLightbox = (slideId: string) => {
    const index = masterLightboxImages.findIndex((item) => item.id === slideId);
    if (index < 0) return;
    setSelectedMasterSlideId(slideId);
    setPptLightboxScope("master");
    setPptLightboxIndex(index);
    setPptLightboxOpen(true);
  };

  const handlePptLightboxDownload = useCallback(async (image: PptLightboxImage) => {
    if (!image.downloadTaskId || !image.downloadSlideId) {
      throw new Error("缺少图片下载信息");
    }
    await downloadPptSlideImage(image.downloadTaskId, image.downloadSlideId, image.downloadName);
  }, []);

  const handleResetProvider = (kind: PptProviderKind) => {
    if (kind === "text") {
      setTextBaseUrl("");
      setTextApiKey("");
      setTextModel(DEFAULT_TEXT_MODEL);
    } else {
      setImageBaseUrl("");
      setImageApiKey("");
      setImageModel(DEFAULT_IMAGE_MODEL);
      setImageProviderMode(DEFAULT_IMAGE_PROVIDER_MODE);
      setImageAccountType(DEFAULT_IMAGE_ACCOUNT_TYPE);
      setImageResolution(DEFAULT_IMAGE_RESOLUTION);
      setImageQuality(DEFAULT_IMAGE_QUALITY);
    }
    setProviderTestResults((current) => {
      const next = { ...current };
      delete next[kind];
      return next;
    });
    toast.success(`${kind === "text" ? "文本服务" : "图片服务"}已恢复默认`);
  };

  const handleTestProvider = async (kind: PptProviderKind) => {
    const isText = kind === "text";
    setTestingProvider(kind);
    try {
      const data = await testPptProvider(kind, {
        baseUrl: isText ? providerRequestBaseUrl(textBaseUrl, backendBaseUrlHint) : imageProviderBaseUrl,
        apiKey: isText ? textApiKey : imageApiKey,
        model: isText ? textModel : imageModel,
      });
      setProviderTestResults((current) => ({ ...current, [kind]: data.result }));
      if (data.result.ok) {
        toast.success(`${isText ? "文本服务" : "图片服务"}：${data.result.message || "服务可访问"}`);
      } else {
        toast.error(data.result.message || `${isText ? "文本服务" : "图片服务"}不可用`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "服务测试失败";
      setProviderTestResults((current) => ({
        ...current,
        [kind]: {
          ok: false,
          kind,
          mode: (isText ? providerRequestBaseUrl(textBaseUrl, backendBaseUrlHint) : imageProviderBaseUrl) ? "external" : "current_project",
          status: 0,
          latency_ms: 0,
          model: isText ? textModel : imageModel,
          message,
          error: message,
        },
      }));
      toast.error(message);
    } finally {
      setTestingProvider(null);
    }
  };

  const imageQualityOptions: Array<{ value: ImageQuality; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
  ];

  const providerBaseSummary = (baseUrl: string) => (isCurrentProjectBaseUrl(baseUrl, backendBaseUrlHint) ? "当前项目内置 API" : baseUrl.trim());
  const providerSummary = (baseUrl: string, model: string) => `${providerBaseSummary(baseUrl)} · ${model.trim() || "默认模型"}`;
  const providerPlaceholder = backendBaseUrlHint ? `留空使用当前项目：${backendBaseUrlHint}` : "留空使用当前项目模型";

  const renderProviderTestStatus = (kind: PptProviderKind) => {
    const result = providerTestResults[kind];
    if (!result) return null;
    const message = result.message || (result.ok ? "服务可访问" : result.error || "服务不可用");
    const Icon = result.ok ? CheckCircle2 : CircleAlert;
    return (
      <span
        title={message}
        className={cn(
          "hidden max-w-[180px] items-center gap-1 truncate rounded-md border px-2 py-1 text-xs font-medium md:inline-flex",
          result.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{message}</span>
      </span>
    );
  };

  const renderSlideImageCenterAction = (slide: PptSlide, compact = false) => {
    const isUploading = uploadingSlideId === slide.slide_id;
    const isTextToImageInProgress = Boolean(!slide.image_url && (slideHasActiveWork(slide) || task?.status === "running"));
    const isImageEditing = Boolean(task && imageEditingSlideKeys.has(slideTaskKey(task.id, slide.slide_id)) && slideHasActiveWork(slide));
    const isImageEditOpen = imageEditSlideId === slide.slide_id;
    if (isImageEditing) return null;
    const buttonClass = cn(
      "pointer-events-auto inline-flex items-center gap-2 rounded-lg border border-white/70 bg-white/90 text-stone-900 shadow-lg backdrop-blur transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60",
      compact ? "px-3 py-2 text-xs" : "px-4 py-2 text-sm",
    );
    return (
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-3 transition",
          slide.image_url ? (isImageEditOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100") : "opacity-100",
        )}
      >
        {slide.image_url ? (
          <div className="pointer-events-none flex max-w-full items-center justify-center">
            <button
              ref={(node) => {
                imageEditButtonRefs.current[slide.slide_id] = node;
              }}
              data-ppt-image-edit-trigger="true"
              type="button"
              className={buttonClass}
              onClick={(event) => {
                event.stopPropagation();
                handleOpenImageEdit(slide, event.currentTarget, compact);
              }}
              title="图片编辑"
            >
              <FilePenLine className={compact ? "size-4" : "size-5"} />
              图片编辑
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={buttonClass}
            disabled={isUploading || isTextToImageInProgress}
            onClick={(event) => {
              event.stopPropagation();
              handleStartSlideUpload(slide.slide_id);
            }}
            title={isTextToImageInProgress ? "文生图进行中，暂不能上传参考图" : "上传参考图"}
          >
            {isUploading ? <LoaderCircle className={cn(compact ? "size-4" : "size-5", "animate-spin")} /> : <Upload className={compact ? "size-4" : "size-5"} />}
            上传参考图
          </button>
        )}
      </div>
    );
  };

  const renderSlideImageEditingOverlay = (slide: PptSlide, compact = false) => {
    const editingKey = task ? slideTaskKey(task.id, slide.slide_id) : "";
    const isImageEditing = Boolean(editingKey && imageEditingSlideKeys.has(editingKey) && slideHasActiveWork(slide));
    const editingPrompt = editingKey ? imageEditingSlidePrompts[editingKey] || "" : "";
    if (!isImageEditing) return null;
    return (
      <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/55 text-stone-900 backdrop-blur-[1px]">
        <div className={cn("max-w-[86%] rounded-lg border border-white/80 bg-white/85 px-4 py-3 text-center shadow-sm", compact ? "text-xs" : "text-sm")}>
          <div className="inline-flex items-center justify-center gap-2 font-medium">
            <LoaderCircle className={cn(compact ? "size-4" : "size-5", "animate-spin")} />
            图片编辑中，请稍等...
          </div>
          {editingPrompt ? <div className="mt-2 line-clamp-3 text-xs leading-5 text-stone-600">{editingPrompt}</div> : null}
        </div>
      </div>
    );
  };

  const renderImageEditPopover = () => {
    if (!imageEditSlide || !imageEditPopoverPlacement || typeof document === "undefined") return null;
    return createPortal(
      <div
        data-ppt-image-edit-popover="true"
        className="fixed z-[9999] rounded-lg border border-white/80 bg-white/95 p-3 text-left text-stone-900 shadow-2xl backdrop-blur"
        style={{
          top: imageEditPopoverPlacement.top,
          left: imageEditPopoverPlacement.left,
          width: imageEditPopoverPlacement.width,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <Textarea
          autoFocus
          rows={imageEditPopoverCompact ? 3 : 4}
          value={imageEditPrompt}
          onChange={(event) => setImageEditPrompt(event.target.value)}
          className={cn(
            "min-h-0 resize-none rounded-lg border-stone-200 text-xs leading-5",
            imageEditPopoverCompact ? "h-[72px]" : "h-[104px]",
          )}
          placeholder="输入图片修改要求"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            className={cn("rounded-lg border-stone-200 bg-white px-2 text-stone-700", imageEditPopoverCompact ? "h-8 text-xs" : "h-9 text-xs")}
            disabled={isEditingSlideImage}
            onClick={(event) => {
              event.stopPropagation();
              closeImageEdit();
            }}
          >
            取消
          </Button>
          <Button
            className={cn("rounded-lg bg-stone-950 px-2 text-white hover:bg-stone-800", imageEditPopoverCompact ? "h-8 text-xs" : "h-9 text-xs")}
            disabled={isEditingSlideImage}
            onClick={(event) => {
              event.stopPropagation();
              void handleSubmitImageEdit();
            }}
          >
            {isEditingSlideImage ? <LoaderCircle className="size-3.5 animate-spin" /> : <FilePenLine className="size-3.5" />}
            {imageEditPopoverCompact ? "提交" : "提交图生图"}
          </Button>
        </div>
      </div>,
      document.body,
    );
  };

  const renderAnchorActionControls = () => {
    const slideId = hoveredAnchorSlideId;
    if (!task || !slideId || !anchorActionPlacement || typeof document === "undefined") return null;
    return createPortal(
      <div
        className="fixed z-[9999]"
        style={{
          top: anchorActionPlacement.top,
          left: anchorActionPlacement.left,
          width: anchorActionPlacement.width,
        }}
        onMouseEnter={() => showAnchorActions(slideId)}
        onMouseLeave={scheduleHideAnchorActions}
      >
        <div className="rounded-lg border border-stone-200 bg-white/95 p-1 shadow-xl backdrop-blur">
          <SlideActionControls
            compact
            disabled={Boolean(mutatingSlideAction)}
            onInsertBefore={() => void handleInsertBlankSlide(slideId, "before")}
            onDelete={() => void handleDeleteSlide(slideId)}
            onInsertAfter={() => void handleInsertBlankSlide(slideId, "after")}
          />
        </div>
      </div>,
      document.body,
    );
  };

  const renderReferenceImages = (ownerTask: PptTask | null, slide: PptSlide, mode: "master" | "content", compact = false) => {
    const references = slide.reference_images?.filter((item) => item.image_url) ?? [];
    const uploadKey = ownerTask ? `${ownerTask.id}:${slide.slide_id}:upload-reference` : "";
    const uploadBlocked = Boolean(ownerTask && (taskHasActiveWork(ownerTask) || slideHasActiveWork(slide)));
    const isUploadingReference = Boolean(uploadKey && uploadingReferenceKey === uploadKey);
    return (
      <div className={cn("rounded-lg border border-stone-200 bg-stone-50", compact ? "p-1.5" : "p-2")}>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-stone-600">参考图</span>
          <span className="text-[11px] text-stone-400">{references.length ? `${references.length} 张` : "无"}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {references.map((reference) => {
            const actionKey = ownerTask ? `${ownerTask.id}:${slide.slide_id}:${reference.id}` : "";
            const isDeleting = deletingReferenceKey === actionKey;
            const deleteBlocked = Boolean(ownerTask && (taskHasActiveWork(ownerTask) || slideHasActiveWork(slide)));
            return (
              <div key={reference.id} className="group relative">
                <button
                  type="button"
                  className={cn("relative overflow-hidden rounded-md border border-stone-200 bg-white", compact ? "size-10" : "size-12")}
                  title={reference.title || "查看参考图"}
                  onClick={(event) => {
                    event.stopPropagation();
                    setReferencePreview({ title: reference.title || "参考图", imageUrl: reference.image_url });
                  }}
                >
                  <NextImage src={reference.image_url} alt={reference.title || "参考图"} fill sizes="48px" className="object-cover" unoptimized />
                </button>
                <button
                  type="button"
                  className="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-white text-rose-600 shadow-sm ring-1 ring-stone-200 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                  title={deleteBlocked ? "图片生成过程中不能移除参考图" : "移除参考图"}
                  disabled={!ownerTask || isDeleting || deleteBlocked}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteReference(ownerTask, slide.slide_id, reference.id, mode);
                  }}
                >
                  {isDeleting ? <LoaderCircle className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className={cn("inline-flex shrink-0 items-center justify-center rounded-md border border-dashed border-stone-300 bg-white text-stone-500 transition hover:border-stone-500 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-60", compact ? "size-10" : "size-12")}
            title={uploadBlocked ? "图片生成过程中不能添加参考图" : "添加参考图"}
            disabled={!ownerTask || uploadBlocked || isUploadingReference}
            onClick={(event) => {
              event.stopPropagation();
              handleStartReferenceUpload(ownerTask, slide.slide_id, mode);
            }}
          >
            {isUploadingReference ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
          </button>
        </div>
      </div>
    );
  };

  const renderReferencePreview = () => {
    if (!referencePreview) return null;
    return (
      <Dialog open={Boolean(referencePreview)} onOpenChange={(open) => !open && setReferencePreview(null)}>
        <DialogContent className="h-[88dvh] w-[min(94vw,1080px)] max-w-none grid-rows-[auto_minmax(0,1fr)] rounded-lg p-0">
          <DialogHeader className="border-b border-stone-100 px-5 py-4">
            <DialogTitle className="text-base">{referencePreview.title}</DialogTitle>
          </DialogHeader>
          <div className="relative min-h-0 bg-stone-100">
            <NextImage src={referencePreview.imageUrl} alt={referencePreview.title} fill sizes="94vw" className="object-contain" unoptimized />
          </div>
        </DialogContent>
      </Dialog>
    );
  };

  const renderMasterReview = () => {
    if (!masterTask) {
      return (
        <div className="flex min-h-[520px] flex-1 flex-col items-center justify-start gap-6 px-6 pt-12">
          <div className="max-w-md text-center text-sm leading-6 text-stone-500">
            先生成 {PPT_MASTER_PAGE_COUNT} 张 PPT 母版，确认后再进入内容方案和具体页面生成。
          </div>
          <div className="grid w-full max-w-2xl gap-4 text-left">
            <label className="grid gap-2">
              <span className="text-xs font-medium text-stone-600">母版风格</span>
              <Textarea
                value={masterStylePrompt}
                onChange={(event) => setMasterStylePrompt(event.target.value)}
                placeholder={DEFAULT_MASTER_STYLE_PROMPT}
                className="min-h-28 resize-none rounded-2xl border-stone-200 bg-white text-xs leading-5 shadow-sm transition focus-visible:border-stone-300 focus-visible:ring-[3px] focus-visible:ring-stone-200/70"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {PPT_STYLE_PRESETS.map((preset) => {
                const active = masterStylePrompt.trim() === preset.prompt;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={cn(
                      "inline-flex h-8 items-center rounded-full border px-3.5 text-xs font-medium transition-all",
                      active
                        ? "border-stone-900 bg-stone-900 text-white shadow-sm"
                        : "border-stone-200 bg-white text-stone-600 hover:-translate-y-px hover:border-stone-400 hover:text-stone-950 hover:shadow-sm",
                    )}
                    onClick={() => setMasterStylePrompt(preset.prompt)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Button
            className={cn(CTA_CLASS, "h-11 px-6 text-sm font-semibold")}
            disabled={isCreatingMaster}
            onClick={() => void handleCreateMasterTask()}
          >
            {isCreatingMaster ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            生成母版
          </Button>
        </div>
      );
    }
    const renderMasterImageUploadOverlay = (slide: PptSlide, compact = false) => {
      const isGenerating = slide.status === "running" || slide.status === "queued";
      const isUploading = uploadingMasterSlideId === slide.slide_id;
      if (isGenerating) return null;
      return (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-stone-950/0 opacity-0 transition group-hover:bg-stone-950/10 group-hover:opacity-100 focus-within:opacity-100">
          <Button
            type="button"
            variant="outline"
            className={cn("pointer-events-auto rounded-lg border-white/70 bg-white/92 text-stone-900 shadow-lg backdrop-blur hover:bg-white", compact ? "h-9 px-3 text-xs" : "h-10 px-4")}
            disabled={isUploading}
            onClick={(event) => {
              event.stopPropagation();
              handleStartMasterUpload(slide.slide_id);
            }}
          >
            {isUploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
            更换图片
          </Button>
        </div>
      );
    };
    const renderMasterCard = (slide: PptSlide, compact = false, showImage = true) => {
      const promptValue = promptDrafts[slide.slide_id] ?? slide.current_prompt ?? "";
      const isGenerating = slide.status === "running" || slide.status === "queued";
      const isRegenerating = regeneratingMasterSlideId === slide.slide_id;
      const label = MASTER_LAYOUT_LABELS[slide.layout_type || slide.slide_id] || slide.title;
      const elapsedLabel = isGenerating ? formatElapsedTime(slide.started_at || masterTask.started_at || masterTask.created_at, nowMs) : "";
      return (
        <article key={slide.slide_id} className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <div className={cn("space-y-4 p-4", compact ? "space-y-3 p-3" : "")}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-stone-900">{label}</div>
                <div className="mt-0.5 text-xs text-stone-500">{slide.slide_id}</div>
              </div>
              <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-xs font-semibold", statusStyle(slide.status).className)}>
                {statusStyle(slide.status).label}
              </span>
            </div>
            {showImage ? (
              <div className="group relative aspect-video overflow-hidden rounded-lg bg-stone-100">
                {slide.image_url ? (
                  <NextImage
                    src={slide.image_url}
                    alt={slide.title}
                    fill
                    sizes={compact ? `${parsedTileSize}px` : "(min-width: 1024px) 75vw, 100vw"}
                    className="object-contain"
                    unoptimized
                    onLoad={(event) => updatePptImageMetadata(slide.image_url, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                  />
                ) : (
                  <SlideSkeleton title={label || "生成中"} elapsed={elapsedLabel} />
                )}
                {renderMasterImageUploadOverlay(slide, compact)}
                {slide.image_url ? (
                  <button
                    type="button"
                    className="absolute right-3 top-3 z-40 inline-flex size-9 items-center justify-center rounded-lg bg-white/90 text-stone-700 opacity-100 shadow-sm transition hover:bg-white hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 sm:opacity-0 sm:group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      openMasterLightbox(slide.slide_id);
                    }}
                    aria-label={`放大${label}`}
                    title="放大图片"
                  >
                    <Maximize2 className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
            {slide.error ? <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{slide.error}</div> : null}
            {renderReferenceImages(masterTask, slide, "master", compact)}
            <Textarea
              value={promptValue}
              onChange={(event) => handlePromptDraftChange(slide.slide_id, event.target.value)}
              onBlur={() => void saveMasterPromptDraft(slide)}
              className={cn("resize-none rounded-lg border-stone-200 text-xs leading-5", compact ? "min-h-20" : "min-h-28")}
            />
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
              {!isGenerating ? (
                <Button variant="outline" className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700" disabled={isRegenerating} onClick={() => void handleRegenerateMasterSlide(slide)}>
                  {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  重新生成
                </Button>
              ) : (
                <span className="text-xs text-stone-400">生成完成后可重新生成</span>
              )}
            </div>
          </div>
        </article>
      );
    };
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-5", subtleScrollbar)}>
        {masterTask.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{masterTask.error}</div> : null}
        {viewMode === "focus" && selectedMasterSlide ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="group relative min-h-[320px] w-full flex-1 overflow-hidden rounded-lg border border-stone-200 bg-stone-100">
              {selectedMasterSlide.image_url ? (
                <NextImage
                  src={selectedMasterSlide.image_url}
                  alt={selectedMasterSlide.title}
                  fill
                  sizes="(min-width: 1024px) 75vw, 100vw"
                  className="object-contain"
                  unoptimized
                  onLoad={(event) => updatePptImageMetadata(selectedMasterSlide.image_url, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                />
              ) : (
                <SlideSkeleton
                  title={selectedMasterSlide.title || "生成中"}
                  elapsed={slideHasActiveWork(selectedMasterSlide) ? formatElapsedTime(selectedMasterSlide.started_at || masterTask.started_at || masterTask.created_at, nowMs) : ""}
                />
              )}
              {renderMasterImageUploadOverlay(selectedMasterSlide)}
              {masterTask.slides.length > 1 ? (
                <>
                  <button
                    type="button"
                    className="absolute left-4 top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/55 text-stone-900 opacity-0 shadow-sm backdrop-blur transition hover:bg-white/75 hover:text-stone-950 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 group-hover:opacity-100"
                    onClick={() => moveSelectedMasterSlide(-1)}
                    aria-label="上一张母版"
                    title="上一张母版"
                  >
                    <ArrowLeft className="size-5" />
                  </button>
                  <button
                    type="button"
                    className="absolute right-4 top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/55 text-stone-900 opacity-0 shadow-sm backdrop-blur transition hover:bg-white/75 hover:text-stone-950 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 group-hover:opacity-100"
                    onClick={() => moveSelectedMasterSlide(1)}
                    aria-label="下一张母版"
                    title="下一张母版"
                  >
                    <ArrowRight className="size-5" />
                  </button>
                </>
              ) : null}
            </div>
            {renderMasterCard(selectedMasterSlide, false, false)}
          </div>
        ) : (
          <div className="grid gap-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${parsedTileSize}px), 1fr))` }}>
            {masterTask.slides.map((slide) => renderMasterCard(slide, parsedTileSize <= 320))}
          </div>
        )}
      </div>
    );
  };

  const generationConfigPanel = (
    <div className={cn(PANEL_CLASS, "p-5")}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-stone-900">生成配置</h2>
        <p className="mt-1 text-xs leading-5 text-stone-500">接口地址留空时使用当前项目模型；默认后端 {backendBaseUrlHint || "当前服务"}</p>
      </div>
      <div className="grid gap-3">
        <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white transition hover:border-stone-300/90">
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setIsTextConfigOpen((open) => !open)}>
              <ChevronRight className={cn("size-4 shrink-0 text-stone-400 transition-transform duration-200", isTextConfigOpen && "rotate-90")} />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-stone-900">文本服务</div>
                <div className="mt-0.5 truncate text-xs text-stone-500">{providerSummary(textBaseUrl, textModel)}</div>
              </div>
            </button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {renderProviderTestStatus("text")}
              <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-8 shrink-0 px-3 text-xs")} onClick={() => handleResetProvider("text")}>
                <RefreshCw className="size-3.5" />
                恢复默认
              </Button>
              <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-8 shrink-0 px-3 text-xs")} disabled={testingProvider === "text"} onClick={() => void handleTestProvider("text")}>
                {testingProvider === "text" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                测试
              </Button>
            </div>
          </div>
          {isTextConfigOpen ? (
            <div className="grid gap-3 border-t border-stone-100 p-4 sm:grid-cols-2">
              <label className="grid min-w-0 gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium text-stone-600">文本接口地址</span>
                <Input value={textBaseUrl} onChange={(event) => setTextBaseUrl(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder={providerPlaceholder} />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">文本模型</span>
                <Input value={textModel} onChange={(event) => setTextModel(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder={DEFAULT_TEXT_MODEL} />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">文本 API Key</span>
                <Input type="password" value={textApiKey} onChange={(event) => setTextApiKey(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder="当前项目可留空" />
              </label>
            </div>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white transition hover:border-stone-300/90">
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={() => setIsImageConfigOpen((open) => !open)}>
              <ChevronRight className={cn("size-4 shrink-0 text-stone-400 transition-transform duration-200", isImageConfigOpen && "rotate-90")} />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-stone-900">图片服务</div>
                <div className="mt-0.5 truncate text-xs text-stone-500">
                  {isExternalImageProvider ? `外部 API · ${imageProviderBaseUrl || "未配置接口"}` : "当前内置服务"} · 16:9 {effectivePptImageSize.replace("x", " x ")} · {effectiveImageQuality} · 并行 {parsedConcurrency}
                </div>
              </div>
            </button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {renderProviderTestStatus("image")}
              <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-8 shrink-0 px-3 text-xs")} onClick={() => handleResetProvider("image")}>
                <RefreshCw className="size-3.5" />
                恢复默认
              </Button>
              <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-8 shrink-0 px-3 text-xs")} disabled={testingProvider === "image"} onClick={() => void handleTestProvider("image")}>
                {testingProvider === "image" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                测试
              </Button>
            </div>
          </div>
          {isImageConfigOpen ? (
            <div className="grid gap-3 border-t border-stone-100 p-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium text-stone-600">服务类型</span>
                <div className="inline-flex w-fit rounded-lg border border-stone-200 bg-stone-50 p-1">
                  <button
                    type="button"
                    className={cn("h-8 rounded-md px-3 text-xs font-medium transition", imageProviderMode === "builtin" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900")}
                    onClick={() => setImageProviderMode("builtin")}
                  >
                    当前内置服务
                  </button>
                  <button
                    type="button"
                    className={cn("h-8 rounded-md px-3 text-xs font-medium transition", imageProviderMode === "external" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900")}
                    onClick={() => setImageProviderMode("external")}
                  >
                    外部 API 服务
                  </button>
                </div>
              </div>
              {isExternalImageProvider ? (
                <>
                  <label className="grid min-w-0 gap-1.5 sm:col-span-2">
                    <span className="text-xs font-medium text-stone-600">图片接口地址</span>
                    <Input value={imageBaseUrl} onChange={(event) => setImageBaseUrl(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder={providerPlaceholder} />
                  </label>
                  <label className="grid min-w-0 gap-1.5 sm:col-span-2">
                    <span className="text-xs font-medium text-stone-600">图片 API Key</span>
                    <Input type="password" value={imageApiKey} onChange={(event) => setImageApiKey(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder="外部 API 必填" />
                  </label>
                </>
              ) : null}
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">图片模型</span>
                <Input value={imageModel} onChange={(event) => setImageModel(event.target.value)} className="h-10 rounded-lg border-stone-200 bg-white text-xs" placeholder={DEFAULT_IMAGE_MODEL} />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">比例</span>
                <div className="flex h-10 items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 text-xs text-stone-600">
                  <span>16:9</span>
                  <span>{effectivePptImageSize.replace("x", " x ")}</span>
                </div>
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">质量</span>
                <Select
                  value={effectiveImageQuality}
                  onValueChange={(value) => setImageQuality(value as ImageQuality)}
                >
                  <SelectTrigger className="h-10 rounded-lg border-stone-200 bg-white text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {imageQualityOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-stone-600">并行数</span>
                <Input
                  type="number"
                  min={MIN_CONCURRENCY}
                  max={MAX_CONCURRENCY}
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                  onBlur={() => setConcurrency(String(parsedConcurrency))}
                  className="h-10 rounded-lg border-stone-200 bg-white text-center text-xs"
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <section
        className={cn("grid min-h-0 items-stretch gap-4 pb-6", isSidebarCollapsed ? "lg:grid-cols-[56px_minmax(0,1fr)]" : "lg:grid-cols-[390px_minmax(0,1fr)]")}
        onFocusCapture={handleNonImageEditInputFocus}
      >
        <aside className="space-y-4">
          <input ref={fileInputRef} type="file" accept=".md,.markdown,text/markdown,text/plain" className="hidden" onChange={handlePickFile} />
          {isSidebarCollapsed ? (
            <div className={cn("flex flex-col items-center gap-2 p-2", PANEL_CLASS)}>
              <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-10")} title="展开左侧" onClick={() => setIsSidebarCollapsed(false)}>
                <PanelLeftOpen className="size-4" />
              </Button>
              <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-10")} title="导入 Markdown" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-4" />
              </Button>
              <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-10")} title="新任务" onClick={handleNewTask}>
                <Plus className="size-4" />
              </Button>
              <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-10")} title="编辑 Markdown" onClick={() => setIsFullscreenEditorOpen(true)}>
                <FilePenLine className="size-4" />
              </Button>
              <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-10")} title="刷新历史任务" disabled={isLoadingTasks} onClick={() => void refreshTaskHistory()}>
                {isLoadingTasks ? <LoaderCircle className="size-4 animate-spin" /> : <History className="size-4" />}
              </Button>
            </div>
          ) : (
            <>
              <div className={cn(PANEL_CLASS, "p-5")}>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.18em] text-stone-400 uppercase">Markdown</div>
                    <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-stone-900">生成 PPT</h1>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-9")} title="折叠左侧" onClick={() => setIsSidebarCollapsed(true)}>
                      <PanelLeftClose className="size-4" />
                    </Button>
                    <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-9 px-3")} title="新任务" onClick={handleNewTask}>
                      <Plus className="size-4" />
                      新任务
                    </Button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="group flex w-full items-center gap-3 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-3.5 text-left transition-all hover:border-stone-900/40 hover:bg-stone-50"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-stone-200 bg-white text-stone-500 shadow-sm transition group-hover:border-stone-300 group-hover:text-stone-900">
                    {markdown.trim() ? <FileText className="size-5" /> : <UploadCloud className="size-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-stone-900">{markdownLabel}</div>
                    <p className="mt-0.5 truncate text-xs text-stone-500">{markdown.trim() ? `${markdown.length} 字符 · 点击重新导入` : "点击上传 .md 文件，或在编辑器中输入"}</p>
                  </div>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="编辑 Markdown"
                    title="编辑 Markdown"
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-600 shadow-sm transition hover:border-stone-300 hover:text-stone-900"
                    onClick={(event) => {
                      event.stopPropagation();
                      setIsFullscreenEditorOpen(true);
                    }}
                  >
                    <FilePenLine className="size-4" />
                  </span>
                </button>

                <div className="mt-4 grid gap-3">
                  <div className="grid gap-3">
                    <div className="grid gap-2">
                      <span className="text-xs font-medium text-stone-600">PPT 页数</span>
                      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                        <div className="inline-flex h-11 rounded-xl border border-stone-200 bg-stone-100/80 p-1">
                          <button
                            type="button"
                            className={cn(
                              "inline-flex min-w-16 items-center justify-center rounded-lg px-3 text-xs font-semibold transition-all",
                              slideCountMode === "auto" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900",
                            )}
                            onClick={() => setSlideCountMode("auto")}
                          >
                            Auto
                          </button>
                          <button
                            type="button"
                            className={cn(
                              "inline-flex min-w-16 items-center justify-center rounded-lg px-3 text-xs font-semibold transition-all",
                              slideCountMode === "manual" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900",
                            )}
                            onClick={() => {
                              setSlideCountMode("manual");
                              setSlideCount(String(parsedSlideCount));
                            }}
                          >
                            指定
                          </button>
                        </div>
                        {slideCountMode === "auto" ? (
                          <div className="flex h-11 items-center justify-center rounded-xl border border-stone-200 bg-stone-50 px-3 text-sm font-semibold text-stone-600">Auto</div>
                        ) : (
                          <Input
                            type="number"
                            min={MIN_SLIDES}
                            max={MAX_SLIDES}
                            value={slideCount}
                            onChange={(event) => setSlideCount(event.target.value)}
                            onBlur={() => setSlideCount(String(parsedSlideCount))}
                            className="h-11 rounded-xl border-stone-200 text-center"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  <Button
                    className={cn("h-11 w-full text-sm font-semibold", masterConfirmed ? CTA_CLASS : "rounded-xl bg-stone-200 text-stone-400 hover:bg-stone-200")}
                    disabled={!masterConfirmed || isCreatingPlan}
                    onClick={() => void handleCreatePlan()}
                  >
                    {isCreatingPlan ? <LoaderCircle className="size-4 animate-spin" /> : <FileText className="size-4" />}
                    生成方案
                  </Button>
                </div>
              </div>

              {generationConfigPanel}

              <div className={cn(PANEL_CLASS, "p-5")}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-stone-900">历史任务</h2>
                    <p className="mt-1 text-xs text-stone-500">{historyItems.length ? `${historyItems.length} 个可恢复任务` : "暂无任务"}</p>
                  </div>
                  <Button variant="outline" size="icon" className={cn(SECONDARY_BTN_CLASS, "size-9")} disabled={isLoadingTasks} onClick={() => void refreshTaskHistory()}>
                    {isLoadingTasks ? <LoaderCircle className="size-4 animate-spin" /> : <History className="size-4" />}
                  </Button>
                </div>
                {historyItems.length ? (
                  <div className={cn("max-h-[360px] space-y-2 overflow-y-auto pr-1", subtleScrollbar)}>
                    {historyItems.slice(0, 12).map((historyItem) => {
                      const item = historyItem.displayTask;
                      const meta = taskStatusStyle(item);
                      const isDeleting = Boolean(deletingTaskId && historyItem.taskIds.includes(deletingTaskId));
                      const isEditingName = editingTaskNameId === item.id;
                      const isSavingName = savingTaskNameId === item.id;
                      const isActiveHistoryItem = [task?.id, masterTask?.id, planTask?.id].some((id) => Boolean(id && historyItem.taskIds.includes(id)));
                      return (
                        <div
                          key={historyItem.groupKey}
                          className={cn(
                            "overflow-hidden rounded-lg border bg-white transition hover:border-stone-300",
                            isActiveHistoryItem ? "border-stone-400 ring-1 ring-stone-300" : "border-stone-200",
                          )}
                        >
                          <div className="p-3">
                            <div className="mb-2 flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                {isEditingName ? (
                                  <Input
                                    autoFocus
                                    value={taskNameDraft}
                                    disabled={isSavingName}
                                    onChange={(event) => setTaskNameDraft(event.target.value)}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void handleSubmitTaskName(item.id);
                                      }
                                      if (event.key === "Escape") {
                                        event.preventDefault();
                                        handleCancelEditTaskName();
                                      }
                                    }}
                                    className="h-8 rounded-md border-stone-200 bg-white px-2 text-sm"
                                  />
                                ) : (
                                  <button type="button" className="block min-w-0 text-left" onClick={() => handleRestoreTask(item)}>
                                    <div className="truncate text-sm font-medium text-stone-900">{item.name || item.id}</div>
                                    <div className="mt-0.5 truncate text-[11px] text-stone-400">{item.id}</div>
                                  </button>
                                )}
                              </div>
                              <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-xs font-semibold", meta.className)}>{meta.label}</span>
                            </div>
                            <button type="button" className="block w-full text-left" onClick={() => handleRestoreTask(item)}>
                              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                                <div className="h-full rounded-full bg-stone-900 transition-all" style={{ width: `${historyItem.progressPercent}%` }} />
                              </div>
                              <div className="grid grid-cols-4 gap-1">
                                {historyItem.steps.map((step) => (
                                  <div key={step.key} className="min-w-0">
                                    <div className={cn("mx-auto mb-1 size-2.5 rounded-full border", historyStepDotClass(step.status))} />
                                    <div className={cn("truncate text-center text-[10px] font-medium", historyStepTextClass(step.status))}>{step.label}</div>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-stone-500">
                                <span>{historyItem.steps.filter((step) => step.status === "success").length}/4 节点</span>
                                <span className="truncate">{historyItem.updatedAt}</span>
                              </div>
                            </button>
                          </div>
                          <div className="flex items-center justify-end gap-1 border-t border-stone-100 px-3 py-2">
                            {isEditingName ? (
                              <>
                                <button
                                  type="button"
                                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-stone-600 transition hover:bg-stone-100 disabled:opacity-50"
                                  disabled={isSavingName}
                                  onClick={() => handleCancelEditTaskName()}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-stone-900 transition hover:bg-stone-100 disabled:opacity-50"
                                  disabled={isSavingName}
                                  onClick={() => void handleSubmitTaskName(item.id)}
                                >
                                  {isSavingName ? <LoaderCircle className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                                  保存
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-stone-600 transition hover:bg-stone-100"
                                onClick={(event) => handleStartEditTaskName(event, item)}
                              >
                                <FilePenLine className="size-3.5" />
                                重命名
                              </button>
                            )}
                            <button
                              type="button"
                              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                              disabled={isDeleting}
                              onClick={(event) => requestDeleteTask(event, item)}
                            >
                              {isDeleting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </aside>

        <section className={cn("flex min-h-full min-w-0 flex-col overflow-hidden", PANEL_CLASS)}>
          <div className="flex shrink-0 flex-col gap-3 border-b border-stone-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">{reviewMode === "master" ? "母版审阅" : task ? "内容审阅" : plan ? "方案审阅" : "内容审阅"}</h2>
                {reviewMode === "master" && masterTaskStatus ? (
                  <span className={cn("inline-flex h-7 min-w-16 items-center justify-center rounded-full border px-2.5 text-xs font-semibold", masterTaskStatus.className)}>{masterTaskStatus.label}</span>
                ) : null}
                {reviewMode === "content" && taskStatus ? <span className={cn("inline-flex h-7 min-w-16 items-center justify-center rounded-full border px-2.5 text-xs font-semibold", taskStatus.className)}>{taskStatus.label}</span> : null}
              </div>
              <p className="mt-1 text-xs text-stone-500">
                {reviewMode === "master"
                  ? masterTask
                    ? `${masterProgress.success} / ${masterProgress.total} 张母版成功 · ${masterProgress.running} 生成中 · ${masterProgress.queued} 排队${masterProgress.stopped ? ` · ${masterProgress.stopped} 已停止` : ""}${masterElapsed ? ` · 耗时 ${masterElapsed}` : ""}${masterConfirmed ? " · 已确认" : ""}`
                    : "等待生成母版"
                  : task
                    ? `${progress.success} / ${progress.total} 页成功 · ${progress.running} 生成中 · ${progress.queued} 排队${progress.stopped ? ` · ${progress.stopped} 已停止` : ""}${contentElapsed ? ` · 耗时 ${contentElapsed}` : ""}`
                    : plan
                      ? `${plan.slide_count} 页方案 · 图片尚未生成 · 并行 ${parsedConcurrency}`
                      : masterConfirmed
                        ? "等待生成内容方案"
                        : "请先确认母版"}
              </p>
              {reviewMode === "master" && masterTask ? (
                <div className="mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full rounded-full bg-stone-950 transition-all" style={{ width: `${masterProgress.percent}%` }} />
                </div>
              ) : null}
              {reviewMode === "content" && task ? (
                <div className="mt-3 h-1.5 max-w-sm overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full rounded-full bg-stone-950 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="inline-flex rounded-xl border border-stone-200 bg-stone-100/80 p-1">
                <button
                  type="button"
                  className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all", reviewMode === "master" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900")}
                  onClick={() => setReviewMode("master")}
                >
                  母版审阅
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-all disabled:cursor-not-allowed disabled:text-stone-300",
                    reviewMode === "content" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900",
                  )}
                  disabled={!masterConfirmed && !task}
                  onClick={() => setReviewMode("content")}
                >
                  内容审阅
                </button>
              </div>
              {reviewMode === "master" && masterTask ? (
                !masterSlidesReady && !taskHasActiveWork(masterTask) ? (
                  <Button className={cn(CTA_CLASS, "h-10 px-4 text-sm font-semibold")} disabled={isResumingTask} onClick={() => void handleStartMasterGeneration()}>
                    {isResumingTask ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                    开始生成母版
                  </Button>
                ) : null
              ) : null}
              {reviewMode === "master" && masterTask && taskHasActiveWork(masterTask) ? (
                <Button
                  variant="outline"
                  className="h-10 rounded-lg border-rose-200 bg-rose-50 px-3 text-rose-700 hover:bg-rose-100"
                  disabled={stoppingTaskId === masterTask.id}
                  onClick={() => void handleStopTask(masterTask, "master")}
                >
                  {stoppingTaskId === masterTask.id ? <LoaderCircle className="size-4 animate-spin" /> : <CircleStop className="size-4" />}
                  停止任务
                </Button>
              ) : null}
              {reviewMode === "content" && plan && !task ? (
                <Button className={cn(CTA_CLASS, "h-10 px-4 text-sm font-semibold")} disabled={!planReady || isCreatingTask} onClick={() => void handleCreateTask()}>
                  {isCreatingTask ? <LoaderCircle className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
                  生成图片
                </Button>
              ) : null}
              {reviewMode === "content" && canResumeTask ? (
                <Button variant="outline" className="h-10 rounded-lg border-amber-200 bg-amber-50 px-3 text-amber-800 hover:bg-amber-100" disabled={isResumingTask} onClick={() => void handleResumeTask()}>
                  {isResumingTask ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                  继续生成
                </Button>
              ) : null}
              {reviewMode === "content" && task && taskHasActiveWork(task) ? (
                <Button
                  variant="outline"
                  className="h-10 rounded-lg border-rose-200 bg-rose-50 px-3 text-rose-700 hover:bg-rose-100"
                  disabled={stoppingTaskId === task.id}
                  onClick={() => void handleStopTask(task, "content")}
                >
                  {stoppingTaskId === task.id ? <LoaderCircle className="size-4 animate-spin" /> : <CircleStop className="size-4" />}
                  停止任务
                </Button>
              ) : null}
              {((reviewMode === "master" && masterTask) || (reviewMode === "content" && task)) ? (
                <div className="flex h-10 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3">
                  <span className="shrink-0 text-xs font-medium text-stone-600">平铺尺寸</span>
                  <input
                    type="range"
                    min={MIN_TILE_SIZE}
                    max={MAX_TILE_SIZE}
                    step={TILE_SIZE_STEP}
                    value={tileSize}
                    onChange={(event) => setTileSize(event.target.value)}
                    className="h-2 w-28 accent-stone-900"
                    aria-label="平铺尺寸"
                  />
                  <Input
                    type="number"
                    min={MIN_TILE_SIZE}
                    max={MAX_TILE_SIZE}
                    step={TILE_SIZE_STEP}
                    value={tileSize}
                    onChange={(event) => setTileSize(event.target.value)}
                    onBlur={() => setTileSize(String(parsedTileSize))}
                    className="h-8 w-18 rounded-md border-stone-200 px-2 text-center text-xs"
                    aria-label="平铺尺寸像素"
                  />
                </div>
              ) : null}
              {reviewMode === "master" && masterTask ? (
                <Button
                  className={cn("ml-auto h-10 px-4 text-sm font-semibold", masterSlidesReady ? CTA_CLASS : "rounded-xl bg-stone-200 text-stone-400 hover:bg-stone-200")}
                  disabled={!masterSlidesReady || isConfirmingMaster || masterTask.master_confirmed}
                  onClick={() => void handleConfirmMaster()}
                >
                  {isConfirmingMaster ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  {masterTask.master_confirmed ? "母版已确认" : "确认母版"}
                </Button>
              ) : null}
              {reviewMode === "content" && task?.pptx_ready ? (
                <Button variant="outline" className={cn(SECONDARY_BTN_CLASS, "h-10 px-3")} onClick={() => void handleDownload()}>
                  <Download className="size-4" />
                  下载 PPTX
                </Button>
              ) : null}
              {reviewMode === "content" && task ? (
                <Button
                  className={cn("h-10 px-4 text-sm font-semibold", canPackage ? CTA_CLASS : "rounded-xl bg-stone-200 text-stone-400 hover:bg-stone-200")}
                  disabled={!canPackage || isPackaging}
                  onClick={() => void handlePackage()}
                >
                  {isPackaging ? <LoaderCircle className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
                  打包 PPTX
                </Button>
              ) : null}
            </div>
          </div>

          {reviewMode === "master" && masterAnchors.length > 0 ? (
            <div className={cn("sticky top-0 z-10 flex shrink-0 gap-1.5 overflow-x-auto border-b border-stone-100 bg-white/95 px-4 py-2 backdrop-blur", subtleScrollbar)}>
              {masterAnchors.map((slide) => {
                const isCurrent = slide.slide_id === selectedMasterSlide?.slide_id;
                return (
                  <button
                    key={slide.slide_id}
                    type="button"
                    className={cn(
                      "inline-flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold transition hover:border-stone-400 hover:text-stone-950",
                      slideNumberStyle(slide.status),
                      isCurrent && "border-stone-950 bg-white text-stone-950 ring-1 ring-stone-950 ring-offset-1 ring-offset-white shadow-sm",
                    )}
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => setSelectedMasterSlideId(slide.slide_id)}
                    title={`母版 ${slide.displayIndex}：${slide.title}`}
                  >
                    {slide.displayIndex}
                  </button>
                );
              })}
            </div>
          ) : null}

          {reviewMode === "content" && anchors.length > 0 ? (
            <div className={cn("sticky top-0 z-10 flex shrink-0 gap-1.5 overflow-x-auto border-b border-stone-100 bg-white/95 px-4 py-2 backdrop-blur", subtleScrollbar)}>
              {anchors.map((slide) => {
                const isCurrent = Boolean(task && slide.slide_id === selectedSlide?.slide_id);
                const editingKey = task ? slideTaskKey(task.id, slide.slide_id) : "";
                const isSlideImageEditing = Boolean(editingKey && imageEditingSlideKeys.has(editingKey));
                const anchorEditPrompt = editingKey ? imageEditingSlidePrompts[editingKey] || "" : "";
                return (
                  <div
                    key={slide.slide_id}
                    className="relative shrink-0"
                    onMouseEnter={() => showAnchorActions(slide.slide_id)}
                    onMouseLeave={scheduleHideAnchorActions}
                  >
                    <button
                      ref={(node) => {
                        anchorButtonRefs.current[slide.slide_id] = node;
                      }}
                      type="button"
                      className={cn(
                        "inline-flex shrink-0 rounded-md border text-xs transition hover:border-stone-400 hover:text-stone-950",
                        isSlideImageEditing
                          ? "min-h-12 w-52 flex-col items-start justify-center gap-0.5 px-2.5 py-1.5 text-left sm:w-60"
                          : "size-7 items-center justify-center font-semibold",
                        slideNumberStyle(slide.status),
                        isCurrent && "border-stone-950 bg-white text-stone-950 ring-1 ring-stone-950 ring-offset-1 ring-offset-white shadow-sm",
                      )}
                      aria-current={isCurrent ? "page" : undefined}
                      onClick={() => scrollToSlide(slide.slide_id)}
                      title={
                        isSlideImageEditing
                          ? `第 ${slide.displayIndex} 页：图片编辑中，请稍等...${anchorEditPrompt ? ` ${anchorEditPrompt}` : ""}`
                          : `第 ${slide.displayIndex} 页：${slide.title}`
                      }
                    >
                      {isSlideImageEditing ? (
                        <>
                          <span className="flex w-full min-w-0 items-center gap-1.5 font-semibold">
                            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-white/70 text-[10px]">{slide.displayIndex}</span>
                            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                            <span className="truncate">图片编辑中，请稍等...</span>
                          </span>
                          {anchorEditPrompt ? <span className="line-clamp-1 w-full text-[11px] font-normal leading-4 text-stone-500">{anchorEditPrompt}</span> : null}
                        </>
                      ) : (
                        slide.displayIndex
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {reviewMode === "master" ? (
            renderMasterReview()
          ) : !task ? (
            plan ? (
              <div className={cn("min-h-0 flex-1 overflow-y-auto p-5", subtleScrollbar)}>
                <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="rounded-lg border border-stone-200 bg-white p-4">
                    <div className="mb-2 text-sm font-semibold text-stone-900">整体设计</div>
                    <Textarea
                      value={plan.design_concept}
                      onChange={(event) => handlePlanTextChange("design_concept", event.target.value)}
                      className="min-h-28 resize-none rounded-lg border-stone-200 text-sm leading-6"
                      placeholder="整体设计说明"
                    />
                  </div>
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                    <div className="mb-2 text-sm font-semibold text-stone-900">全局风格</div>
                    <p className="text-xs leading-5 text-stone-600">{plan.global_style_prompt}</p>
                  </div>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  {plan.slides.map((slide) => (
                    <article
                      key={slide.slide_id}
                      ref={(node) => {
                        slideRefs.current[slide.slide_id] = node;
                      }}
                      className="scroll-mt-24 rounded-lg border border-stone-200 bg-white p-4"
                    >
                      <div className="mb-3 flex items-center gap-2">
                        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-stone-100 text-xs font-semibold text-stone-600">{slide.slide_id}</span>
                        <Input
                          value={slide.title}
                          onChange={(event) => handlePlanSlideChange(slide.slide_id, "title", event.target.value)}
                          className="h-9 min-w-0 flex-1 rounded-lg border-stone-200 bg-white text-sm font-semibold text-stone-900"
                          placeholder="页面标题"
                        />
                        {slide.layout_type ? <span className="shrink-0 rounded-md bg-stone-100 px-2 py-1 text-[11px] font-medium text-stone-500">{MASTER_LAYOUT_LABELS[slide.layout_type] || slide.layout_type}</span> : null}
                      </div>
                      <Textarea
                        value={slide.slide_prompt}
                        onChange={(event) => handlePlanSlideChange(slide.slide_id, "slide_prompt", event.target.value)}
                        className="min-h-36 resize-none rounded-lg border-stone-200 text-sm leading-6"
                        placeholder="这一页的图片生成提示词"
                      />
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[420px] flex-1 items-center justify-center px-6 text-sm text-stone-500">导入或编辑 Markdown 后生成方案</div>
            )
          ) : (
            <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto p-5", subtleScrollbar)}>
              {task.error ? <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{task.error}</div> : null}
              {viewMode === "focus" && selectedSlide ? (
                (() => {
                  const promptValue = promptDrafts[selectedSlide.slide_id] ?? selectedSlide.current_prompt ?? "";
                  const isGenerating = selectedSlide.status === "running" || selectedSlide.status === "queued";
                  const isRegenerating = regeneratingSlideId === selectedSlide.slide_id;
                  const elapsedLabel = isGenerating ? formatElapsedTime(selectedSlide.started_at || task.started_at || task.created_at, nowMs) : "";
                  return (
                    <div className="flex min-h-0 flex-1 flex-col gap-4">
                      <div className="group relative min-h-[320px] w-full flex-1 overflow-hidden rounded-lg border border-stone-200 bg-stone-100">
                        {selectedSlide.image_url ? (
                          <NextImage
                            src={selectedSlide.image_url}
                            alt={selectedSlide.title}
                            fill
                            sizes="(min-width: 1024px) 75vw, 100vw"
                            className="object-contain"
                            unoptimized
                            onLoad={(event) => updatePptImageMetadata(selectedSlide.image_url, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                          />
                        ) : (
                          <SlideSkeleton title={selectedSlide.title || "生成中"} elapsed={elapsedLabel} />
                        )}
                        {renderSlideImageCenterAction(selectedSlide)}
                        {renderSlideImageEditingOverlay(selectedSlide)}
                        {task.slides.length > 1 ? (
                          <>
                            <button
                              type="button"
                              className="absolute left-4 top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/55 text-stone-900 opacity-0 shadow-sm backdrop-blur transition hover:bg-white/75 hover:text-stone-950 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 group-hover:opacity-100"
                              onClick={() => moveSelectedSlide(-1)}
                              aria-label="上一页"
                              title="上一页"
                            >
                              <ArrowLeft className="size-5" />
                            </button>
                            <button
                              type="button"
                              className="absolute right-4 top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/55 text-stone-900 opacity-0 shadow-sm backdrop-blur transition hover:bg-white/75 hover:text-stone-950 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 group-hover:opacity-100"
                              onClick={() => moveSelectedSlide(1)}
                              aria-label="下一页"
                              title="下一页"
                            >
                              <ArrowRight className="size-5" />
                            </button>
                          </>
                        ) : null}
                      </div>
                      <div className="rounded-lg border border-stone-200 bg-white p-4">
                        {selectedSlide.error ? <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{selectedSlide.error}</div> : null}
                        <div className="mb-3">
                          {renderReferenceImages(task, selectedSlide, "content")}
                        </div>
                        <Textarea rows={4} value={promptValue} onChange={(event) => handlePromptDraftChange(selectedSlide.slide_id, event.target.value)} className="h-[104px] min-h-0 resize-none rounded-lg border-stone-200 text-xs leading-5" />
                        <div className="mt-4 flex min-h-9 flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <SlideActionControls
                              disabled={Boolean(mutatingSlideAction)}
                              onInsertBefore={() => void handleInsertBlankSlide(selectedSlide.slide_id, "before")}
                              onDelete={() => void handleDeleteSlide(selectedSlide.slide_id)}
                              onInsertAfter={() => void handleInsertBlankSlide(selectedSlide.slide_id, "after")}
                            />
                            {isGenerating ? <span className="text-xs text-stone-400">生成完成后可再次生成</span> : null}
                          </div>
                          {!isGenerating ? (
                            <Button variant="outline" className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700" disabled={isRegenerating} onClick={() => void handleRegenerateSlide(selectedSlide)}>
                              {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                              {selectedSlide.image_url ? "重新生成" : "生成图片"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <>
                  <div ref={contentGridContainerRef} className="grid gap-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${parsedTileSize}px), 1fr))` }}>
                    {contentPageSlides.map((slide) => {
                      const promptValue = promptDrafts[slide.slide_id] ?? slide.current_prompt ?? "";
                      const isGenerating = slide.status === "running" || slide.status === "queued";
                      const isRegenerating = regeneratingSlideId === slide.slide_id;
                      const isCompactTile = parsedTileSize <= 320;
                      const elapsedLabel = isGenerating ? formatElapsedTime(slide.started_at || task.started_at || task.created_at, nowMs) : "";
                      return (
                        <article
                          key={slide.slide_id}
                          ref={(node) => {
                            slideRefs.current[slide.slide_id] = node;
                          }}
                          className="scroll-mt-24 overflow-hidden rounded-lg border border-stone-200 bg-white"
                        >
                          <div className={cn("space-y-4 p-4", isCompactTile ? "space-y-3 p-3" : parsedTileSize >= 500 ? "space-y-5 p-6" : "")}>
                            <div className="group relative block aspect-video w-full overflow-hidden rounded-lg bg-stone-100">
                              {slide.image_url ? (
                                <NextImage
                                  src={slide.image_url}
                                  alt={slide.title}
                                  fill
                                  sizes={`(min-width: 1024px) ${parsedTileSize}px, 100vw`}
                                  className="object-contain"
                                  unoptimized
                                  onLoad={(event) => updatePptImageMetadata(slide.image_url, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                                />
                              ) : (
                                <SlideSkeleton title={slide.title || "生成中"} elapsed={elapsedLabel} />
                              )}
                              {renderSlideImageCenterAction(slide, isCompactTile)}
                              {renderSlideImageEditingOverlay(slide, isCompactTile)}
                              {slide.image_url ? (
                                <button
                                  type="button"
                                  className="absolute right-3 top-3 z-40 inline-flex size-9 items-center justify-center rounded-lg bg-white/90 text-stone-700 opacity-100 shadow-sm transition hover:bg-white hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/40 sm:opacity-0 sm:group-hover:opacity-100"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openContentLightbox(slide.slide_id);
                                  }}
                                  aria-label={`放大第 ${task.slides.findIndex((item) => item.slide_id === slide.slide_id) + 1} 页`}
                                  title="放大图片"
                                >
                                  <Maximize2 className="size-4" />
                                </button>
                              ) : null}
                            </div>
                            {slide.error ? <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{slide.error}</div> : null}
                            {renderReferenceImages(task, slide, "content", isCompactTile)}
                            <Textarea
                              value={promptValue}
                              onChange={(event) => handlePromptDraftChange(slide.slide_id, event.target.value)}
                              className={cn("resize-none rounded-lg border-stone-200 text-xs leading-5", isCompactTile ? "min-h-20" : parsedTileSize < 420 ? "min-h-24" : "min-h-32")}
                            />
                            <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <SlideActionControls
                                  compact={isCompactTile}
                                  disabled={Boolean(mutatingSlideAction)}
                                  onInsertBefore={() => void handleInsertBlankSlide(slide.slide_id, "before")}
                                  onDelete={() => void handleDeleteSlide(slide.slide_id)}
                                  onInsertAfter={() => void handleInsertBlankSlide(slide.slide_id, "after")}
                                />
                                {isGenerating ? <span className="text-xs text-stone-400">生成完成后可再次生成</span> : null}
                              </div>
                              {!isGenerating ? (
                                <Button variant="outline" className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700" disabled={isRegenerating} onClick={() => void handleRegenerateSlide(slide)}>
                                  {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                                  {slide.image_url ? "重新生成" : "生成图片"}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {contentPageCount > 1 ? (
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2">
                      <div className="text-xs text-stone-500">
                        第 {safeContentPage} / {contentPageCount} 页 · {contentGridColumns} 列 x {CONTENT_GRID_ROWS} 行
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700"
                          disabled={safeContentPage <= 1}
                          onClick={() => setContentPage((current) => Math.max(1, current - 1))}
                        >
                          <ArrowLeft className="size-4" />
                          上一页
                        </Button>
                        <Button
                          variant="outline"
                          className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700"
                          disabled={safeContentPage >= contentPageCount}
                          onClick={() => setContentPage((current) => Math.min(contentPageCount, current + 1))}
                        >
                          下一页
                          <ArrowRight className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </section>
      </section>

      <input ref={slideImageUploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleSlideImageUpload(event)} />
      <input ref={masterImageUploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleMasterImageUpload(event)} />
      <input ref={referenceImageUploadInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleReferenceImageUpload(event)} />
      {renderImageEditPopover()}
      {renderReferencePreview()}
      {renderAnchorActionControls()}
      <ImageLightbox
        images={pptLightboxImages}
        currentIndex={pptLightboxIndex}
        open={pptLightboxOpen}
        onOpenChange={setPptLightboxOpen}
        onIndexChange={setPptLightboxIndex}
        onDownload={handlePptLightboxDownload}
        onImageLoad={(image, metadata) => updatePptImageMetadata(image.src, metadata)}
      />

      <Dialog open={isFullscreenEditorOpen} onOpenChange={setIsFullscreenEditorOpen}>
        <DialogContent className="h-[92dvh] w-[min(96vw,1180px)] max-w-none grid-rows-[auto_minmax(0,1fr)] rounded-lg p-0">
          <DialogHeader className="border-b border-stone-100 px-6 py-4">
            <DialogTitle className="text-base">{markdownLabel}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-auto p-6">
            <Textarea
              ref={fullscreenTextareaRef}
              value={markdown}
              onFocus={closeImageEdit}
              onChange={(event) => handleMarkdownChange(event.target.value)}
              className={cn("min-h-[calc(92dvh-150px)] resize-none rounded-lg border-stone-200 font-mono text-[13px] leading-5", subtleScrollbar)}
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingDeleteTask)} onOpenChange={(open) => !open && setPendingDeleteTask(null)}>
        <DialogContent className="w-[min(92vw,420px)] rounded-lg p-0">
          <DialogHeader className="border-b border-stone-100 px-5 py-4">
            <DialogTitle className="text-base">删除历史任务</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 p-5">
            <p className="text-sm leading-6 text-stone-600">确认删除任务 {pendingDeleteTask?.name || pendingDeleteTask?.id}？同一 PPT 流程中的母版、方案、内容记录和已打包文件都会被移除。</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="h-9 rounded-lg border-stone-200 bg-white px-3 text-stone-700" onClick={() => setPendingDeleteTask(null)}>
                取消
              </Button>
              <Button className="h-9 rounded-lg bg-rose-600 px-3 text-white hover:bg-rose-700" disabled={Boolean(deletingTaskId)} onClick={() => void handleDeleteTask()}>
                {deletingTaskId ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                删除
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function PptPage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <PptPageContent />;
}
