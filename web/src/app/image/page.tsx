"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  History,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createImageEditTask,
  createImageGenerationTask,
  fetchImageAccountTypes,
  fetchImageTasks,
  type ImageAccountType,
  type ImageModel,
  type ImageTask,
} from "@/lib/api";
import {
  normalizeImageAspectRatio,
  normalizeImageQuality,
  normalizeImageResolutionForAspectRatio,
  resolveImageOutputSize,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/image-generation-options";
import { useAuthGuard } from "@/lib/use-auth-guard";
import {
  clearImageConversations,
  deleteImageConversation,
  getImageConversationStats,
  listImageConversations,
  renameImageConversation,
  saveImageConversation,
  saveImageConversations,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImageGenerationConfig,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:image_active_conversation_id";
const IMAGE_ASPECT_RATIO_STORAGE_KEY = "chatgpt2api:image_last_size";
const IMAGE_RESOLUTION_STORAGE_KEY = "chatgpt2api:image_last_resolution";
const IMAGE_QUALITY_STORAGE_KEY = "chatgpt2api:image_last_quality";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const IMAGE_ACCOUNT_TYPE_STORAGE_KEY = "chatgpt2api:image_last_account_type";
const IMAGE_MODEL_STORAGE_KEY = "chatgpt2api:image_last_model";
const IMAGE_ACCOUNT_TYPE_ORDER: ImageAccountType[] = ["free", "paid"];

function parseImageAccountType(value: unknown): ImageAccountType | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/[-\s/]+/g, "_");
  if (normalized === "free") return "free";
  return ["paid", "team", "plus", "pro", "prolite", "business", "enterprise", "edu", "team_plus_pro"].includes(normalized)
    ? "paid"
    : null;
}

function normalizeImageAccountType(value: unknown): ImageAccountType {
  return parseImageAccountType(value) ?? "free";
}

function normalizeSelectableImageModel(_value: unknown, _accountType: ImageAccountType): ImageModel {
  return "gpt-image-2";
}

function normalizeImageAccountTypes(values: unknown[]): ImageAccountType[] {
  const found = new Set(values.map(parseImageAccountType).filter((item): item is ImageAccountType => item !== null));
  return IMAGE_ACCOUNT_TYPE_ORDER.filter((item) => found.has(item));
}

function clampImageCount(value: string) {
  return String(Math.min(100, Math.max(1, Math.floor(Number(value) || 1))));
}
const activeConversationQueueIds = new Set<string>();

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("读取结果图失败");
  }
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function buildGenerationConfigFromTurn(turn: ImageTurn): StoredImageGenerationConfig {
  const accountType = normalizeImageAccountType(turn.accountType);
  const aspectRatio = normalizeImageAspectRatio(turn.aspectRatio || turn.size);
  const resolution =
    accountType === "free" ? "1k" : normalizeImageResolutionForAspectRatio(turn.resolution, aspectRatio);
  return {
    model: normalizeSelectableImageModel(turn.model, accountType),
    accountType,
    count: Math.max(1, turn.count || turn.images.length || 1),
    size: resolveImageOutputSize(resolution, aspectRatio),
    aspectRatio,
    resolution,
    quality: accountType === "free" ? "auto" : normalizeImageQuality(turn.quality),
  };
}

function taskDataToStoredImage(image: StoredImage, task: ImageTask): StoredImage {
  if (task.status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...image,
        taskId: task.id,
        status: "error",
        error: "未返回图片数据",
      };
    }
    return {
      ...image,
      taskId: task.id,
      status: "success",
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
    };
  }

  if (task.status === "error") {
    return {
      ...image,
      taskId: task.id,
      status: "error",
      error: task.error || "生成失败",
    };
  }

  return {
    ...image,
    taskId: task.id,
    status: "loading",
    error: undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  const loadingCount = turn.images.filter((image) => image.status === "loading").length;
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  if (loadingCount > 0) {
    return { status: turn.status === "queued" ? "queued" : "generating", error: undefined };
  }
  if (failedCount > 0) {
    return { status: "error", error: `其中 ${failedCount} 张未成功生成` };
  }
  if (successCount > 0) {
    return { status: "success", error: undefined };
  }
  return { status: "queued", error: undefined };
}

async function syncConversationImageTasks(items: ImageConversation[]) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.resultsDeleted
            ? []
            : turn.images.flatMap((image) => (image.status === "loading" && image.taskId ? [image.taskId] : [])),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchImageTasks>>;
  try {
    taskList = await fetchImageTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || !image.taskId) {
          return image;
        }
        const task = taskMap.get(image.taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage(image, task);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      changed = true;
      const derived = deriveTurnStatus({ ...turn, images });
      return {
        ...turn,
        ...derived,
        images,
      };
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }
  return normalized;
}

async function recoverConversationHistory(items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating") {
        return turn;
      }

      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: "页面刷新或任务中断，未找到可恢复的任务 ID",
        };
      });
      const derived = deriveTurnStatus({ ...turn, images });
      if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      changed = true;
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }

  return syncConversationImageTasks(normalized);
}


function ImagePageContent() {
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageAspectRatio, setImageAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [imageResolution, setImageResolution] = useState<ImageResolution>("1k");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("auto");
  const [imageAccountType, setImageAccountType] = useState<ImageAccountType>("free");
  const [imageModel, setImageModel] = useState<ImageModel>("gpt-image-2");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [availableImageAccountTypes, setAvailableImageAccountTypes] = useState<ImageAccountType[]>([]);
  const [isLoadingAccountTypes, setIsLoadingAccountTypes] = useState(true);
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: "one"; id: string }
    | { type: "prompt"; conversationId: string; turnId: string }
    | { type: "results"; conversationId: string; turnId: string }
    | { type: "all" }
    | null
  >(null);

  const parsedCount = useMemo(() => Number(clampImageCount(imageCount)), [imageCount]);
  const selectedImageResolution = useMemo(
    () =>
      imageAccountType === "free"
        ? "1k"
        : normalizeImageResolutionForAspectRatio(imageResolution, imageAspectRatio),
    [imageAccountType, imageAspectRatio, imageResolution],
  );
  const resolvedImageSize = useMemo(
    () => resolveImageOutputSize(selectedImageResolution, imageAspectRatio),
    [imageAspectRatio, selectedImageResolution],
  );
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const hasSelectedConversation = selectedConversation !== null;
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle =
    deleteConfirm?.type === "all"
      ? "清空历史记录"
      : deleteConfirm?.type === "prompt"
        ? "删除提示词记录"
        : deleteConfirm?.type === "results"
          ? "删除生成结果"
          : deleteConfirm?.type === "one"
            ? "删除对话"
            : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "prompt"
        ? "确认删除这条提示词记录吗？对应生成结果会保留。"
        : deleteConfirm?.type === "results"
          ? "确认删除这条生成结果吗？对应提示词记录会保留。"
          : deleteConfirm?.type === "one"
            ? "确认删除这条图片对话吗？删除后无法恢复。"
            : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const storedAspectRatio =
          typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_ASPECT_RATIO_STORAGE_KEY) : null;
        const storedResolution =
          typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_RESOLUTION_STORAGE_KEY) : null;
        const storedQuality =
          typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY) : null;
        const storedCount = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_COUNT_STORAGE_KEY) : null;
        const storedAccountType =
          typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_ACCOUNT_TYPE_STORAGE_KEY) : null;
        const storedModel = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) : null;
        const nextAccountType = normalizeImageAccountType(storedAccountType);
        const nextAspectRatio = normalizeImageAspectRatio(storedAspectRatio);
        const nextResolution =
          nextAccountType === "free"
            ? "1k"
            : normalizeImageResolutionForAspectRatio(storedResolution, nextAspectRatio);
        setImageAspectRatio(nextAspectRatio);
        setImageResolution(nextResolution);
        setImageQuality(normalizeImageQuality(storedQuality));
        setImageCount(storedCount ? clampImageCount(storedCount) : "1");
        setImageAccountType(nextAccountType);
        setImageModel(normalizeSelectableImageModel(storedModel, nextAccountType));

        const items = await listImageConversations();
        const normalizedItems = await recoverConversationHistory(items);
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadImageAccountTypes = useCallback(async () => {
    try {
      const data = await fetchImageAccountTypes();
      const nextTypes = normalizeImageAccountTypes(data.items);
      setAvailableImageAccountTypes(nextTypes);
      setImageAccountType((current) => (nextTypes.includes(current) ? current : nextTypes[0] ?? "free"));
    } catch {
      setAvailableImageAccountTypes([]);
    } finally {
      setIsLoadingAccountTypes(false);
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

  const scrollResultsToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = resultsViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }, []);

  const scrollResultsToTop = useCallback((behavior: ScrollBehavior = "smooth") => {
    resultsViewportRef.current?.scrollTo({
      top: 0,
      behavior,
    });
  }, []);

  useEffect(() => {
    if (!hasSelectedConversation) {
      return;
    }

    scrollResultsToTop("auto");
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollResultsToBottom("smooth");
      secondFrame = window.requestAnimationFrame(() => scrollResultsToBottom("smooth"));
    });
    const shortDelay = window.setTimeout(() => scrollResultsToBottom("smooth"), 120);
    const imageDelay = window.setTimeout(() => scrollResultsToBottom("smooth"), 360);

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
      window.clearTimeout(shortDelay);
      window.clearTimeout(imageDelay);
    };
  }, [hasSelectedConversation, scrollResultsToBottom, scrollResultsToTop, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    scrollResultsToBottom("smooth");
  }, [scrollResultsToBottom, selectedConversation?.updatedAt, selectedConversation?.turns.length, selectedConversation]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_ASPECT_RATIO_STORAGE_KEY, imageAspectRatio);
  }, [imageAspectRatio]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_RESOLUTION_STORAGE_KEY, imageResolution);
  }, [imageResolution]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, imageQuality);
  }, [imageQuality]);

  useEffect(() => {
    if (typeof window !== "undefined" && parsedCount > 0) {
      window.localStorage.setItem(IMAGE_COUNT_STORAGE_KEY, String(parsedCount));
    }
  }, [parsedCount]);

  useEffect(() => {
    if (imageModel !== "gpt-image-2") {
      setImageModel("gpt-image-2");
    }
  }, [imageModel]);

  useEffect(() => {
    const nextResolution =
      imageAccountType === "free"
        ? "1k"
        : normalizeImageResolutionForAspectRatio(imageResolution, imageAspectRatio);
    if (imageResolution !== nextResolution) {
      setImageResolution(nextResolution);
    }
    if (imageAccountType === "free" && imageQuality !== "auto") {
      setImageQuality("auto");
    }
  }, [imageAccountType, imageAspectRatio, imageQuality, imageResolution]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_ACCOUNT_TYPE_STORAGE_KEY, imageAccountType);
  }, [imageAccountType]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, normalizeSelectableImageModel(imageModel, imageAccountType));
  }, [imageAccountType, imageModel]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(conversation);
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(nextConversation);
      }
    },
    [],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleDeleteTurnPart = async (conversationId: string, turnId: string, part: "prompt" | "results") => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) {
      return;
    }

    const turns = conversation.turns
      .map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        const nextTurn = {
          ...turn,
          prompt: part === "prompt" ? "" : turn.prompt,
          promptDeleted: part === "prompt" ? true : turn.promptDeleted,
          resultsDeleted: part === "results" ? true : turn.resultsDeleted,
          status: part === "results" && turn.status === "generating" ? "error" as const : turn.status,
          images:
            part === "results"
              ? turn.images.map((image) => ({ id: image.id, status: "error" as const, error: "生成结果已删除" }))
              : turn.images,
        };
        return nextTurn.promptDeleted && nextTurn.resultsDeleted ? null : nextTurn;
      })
      .filter((turn): turn is ImageTurn => Boolean(turn));

    if (turns.length === 0) {
      await handleDeleteConversation(conversationId);
      return;
    }

    const nextConversation = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      turns,
    };
    await persistConversation(nextConversation);
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const handleRenameConversation = async (id: string, title: string) => {
    const nextConversations = conversations.map((item) =>
      item.id === id ? { ...item, title, updatedAt: new Date().toISOString() } : item,
    );
    conversationsRef.current = sortImageConversations(nextConversations);
    setConversations(conversationsRef.current);
    try {
      await renameImageConversation(id, title);
    } catch (error) {
      const message = error instanceof Error ? error.message : "重命名失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openDeletePromptConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "prompt", conversationId, turnId });
  };

  const openDeleteResultsConfirm = (conversationId: string, turnId: string) => {
    setDeleteConfirm({ type: "results", conversationId, turnId });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    if (target.type === "prompt" || target.type === "results") {
      await handleDeleteTurnPart(target.conversationId, target.turnId, target.type);
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImageFiles((prev) => [...prev, ...files]);
      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImageFiles((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const applyImageGenerationConfig = useCallback((config: StoredImageGenerationConfig) => {
    const nextAccountType = normalizeImageAccountType(config.accountType);
    const nextAspectRatio = normalizeImageAspectRatio(config.aspectRatio || config.size);
    const nextResolution =
      nextAccountType === "free" ? "1k" : normalizeImageResolutionForAspectRatio(config.resolution, nextAspectRatio);
    setImageCount(String(Math.max(1, config.count || 1)));
    setImageAspectRatio(nextAspectRatio);
    setImageResolution(nextResolution);
    setImageQuality(nextAccountType === "free" ? "auto" : normalizeImageQuality(config.quality));
    setImageAccountType(nextAccountType);
    setImageModel(normalizeSelectableImageModel(config.model, nextAccountType));
  }, []);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage, sourceTurnId?: string) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
                file: dataUrlToFile(image.dataUrl, image.name, image.type),
              }
            : await buildReferenceImageFromStoredImage(image, `conversation-${conversationId}-${Date.now()}.png`);
        if (!nextReference) {
          return;
        }

        const sourceTurn = sourceTurnId
          ? conversationsRef.current
              .find((conversation) => conversation.id === conversationId)
              ?.turns.find((turn) => turn.id === sourceTurnId)
          : null;
        const generationConfig =
          "dataUrl" in image
            ? image.generationConfig
            : sourceTurn
              ? buildGenerationConfigFromTurn(sourceTurn)
              : undefined;
        const referenceImage = generationConfig
          ? { ...nextReference.referenceImage, generationConfig }
          : nextReference.referenceImage;

        setSelectedConversationId(conversationId);

        setReferenceImages((prev) => [...prev, referenceImage]);
        setReferenceImageFiles((prev) => [...prev, nextReference.file]);
        if (generationConfig) {
          applyImageGenerationConfig(generationConfig);
        }
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [applyImageGenerationConfig],
  );

  const handleReuseTurnConfig = useCallback(async (conversationId: string, turnId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const turn = conversation?.turns.find((item) => item.id === turnId);
    if (!conversation || !turn || !turn.prompt.trim()) {
      return;
    }

    setSelectedConversationId(conversationId);
    setImagePrompt(turn.prompt);
    setImageCount(String(Math.max(1, turn.count || turn.images.length || 1)));
    const nextAspectRatio = normalizeImageAspectRatio(turn.aspectRatio || turn.size);
    const nextAccountType = normalizeImageAccountType(turn.accountType);
    setImageAspectRatio(nextAspectRatio);
    setImageResolution(
      nextAccountType === "free" ? "1k" : normalizeImageResolutionForAspectRatio(turn.resolution, nextAspectRatio),
    );
    setImageQuality(normalizeImageQuality(turn.quality));
    setImageAccountType(nextAccountType);
    setImageModel(normalizeSelectableImageModel(turn.model, nextAccountType));
    setReferenceImages(turn.referenceImages);
    setReferenceImageFiles(
      turn.referenceImages.map((image) => dataUrlToFile(image.dataUrl, image.name, image.type)),
    );
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    textareaRef.current?.focus();
    toast.success("已复用这条提示词配置");
  }, []);

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  const createLoadingImages = (turnId: string, count: number, startedAt: string) =>
    Array.from({ length: count }, (_, index) => {
      const imageId = `${turnId}-${index}`;
      return {
        id: imageId,
        taskId: imageId,
        startedAt,
        status: "loading" as const,
      };
    });

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const activeTurn = snapshot?.turns.find(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || !activeTurn) {
        return;
      }

      activeConversationQueueIds.add(conversationId);
      const applyTasks = async (tasks: ImageTask[]) => {
        const taskMap = new Map(tasks.map((task) => [task.id, task]));
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          const turns = conversation.turns.map((turn) => {
            if (turn.id !== activeTurn.id) {
              return turn;
            }
            const images = turn.images.map((image) => {
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              return task ? taskDataToStoredImage({ ...image, taskId }, task) : image;
            });
            const derived = deriveTurnStatus({ ...turn, status: "generating", images });
            return {
              ...turn,
              ...derived,
              images,
            };
          });
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns,
          };
        });
      };

      try {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "generating",
                    error: undefined,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, taskId: image.taskId || image.id } : image,
                    ),
                  }
                : turn,
            ),
          };
        });

        const referenceFiles = activeTurn.referenceImages.map((image, index) =>
          dataUrlToFile(image.dataUrl, image.name || `${activeTurn.id}-${index + 1}.png`, image.type),
        );
        if (activeTurn.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于继续编辑的参考图");
        }

        const pendingImages = activeTurn.images.filter((image) => image.status === "loading");
        const submitted = await Promise.all(
          pendingImages.map((image) => {
            const taskId = image.taskId || image.id;
            return activeTurn.mode === "edit"
              ? createImageEditTask(
                  taskId,
                  referenceFiles,
                  activeTurn.prompt,
                  activeTurn.model,
                  activeTurn.size,
                  activeTurn.quality,
                  activeTurn.accountType,
                )
              : createImageGenerationTask(
                  taskId,
                  activeTurn.prompt,
                  activeTurn.model,
                  activeTurn.size,
                  activeTurn.quality,
                  activeTurn.accountType,
                );
          }),
        );
        await applyTasks(submitted);

        while (true) {
          const latestConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
          const latestTurn = latestConversation?.turns.find((turn) => turn.id === activeTurn.id);
          const loadingTaskIds =
            latestTurn?.images.flatMap((image) =>
              image.status === "loading" && image.taskId ? [image.taskId] : [],
            ) || [];
          if (loadingTaskIds.length === 0) {
            break;
          }

          await sleep(2000);
          const taskList = await fetchImageTasks(loadingTaskIds);
          if (taskList.items.length > 0) {
            await applyTasks(taskList.items);
          }
          if (taskList.missing_ids.length > 0 && latestTurn) {
            const missingImages = latestTurn.images.filter(
              (image) => image.status === "loading" && image.taskId && taskList.missing_ids.includes(image.taskId),
            );
            const resubmitted = await Promise.all(
              missingImages.map((image) =>
                activeTurn.mode === "edit"
                  ? createImageEditTask(
                      image.taskId || image.id,
                      referenceFiles,
                      activeTurn.prompt,
                      activeTurn.model,
                      activeTurn.size,
                      activeTurn.quality,
                      activeTurn.accountType,
                    )
                  : createImageGenerationTask(
                      image.taskId || image.id,
                      activeTurn.prompt,
                      activeTurn.model,
                      activeTurn.size,
                      activeTurn.quality,
                      activeTurn.accountType,
                    ),
              ),
            );
            if (resubmitted.length > 0) {
              await applyTasks(resubmitted);
            }
          }
        }

        await loadImageAccountTypes();
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成图片失败";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        activeConversationQueueIds.delete(conversationId);
        for (const conversation of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(conversation.id) &&
            conversation.turns.some(
              (turn) =>
                (turn.status === "queued" || turn.status === "generating") &&
                turn.images.some((image) => image.status === "loading"),
            )
          ) {
            void runConversationQueue(conversation.id);
          }
        }
      }
    },
    [loadImageAccountTypes, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const handleRegenerateTurn = useCallback(
    async (conversationId: string, turnId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      const sourceTurn = conversation?.turns.find((turn) => turn.id === turnId);
      if (!conversation || !sourceTurn || !sourceTurn.prompt.trim()) {
        return;
      }

      const now = new Date().toISOString();
      const nextTurnId = createId();
      const count = Math.max(1, sourceTurn.count || sourceTurn.images.length || 1);
      const accountType = normalizeImageAccountType(sourceTurn.accountType);
      const aspectRatio = normalizeImageAspectRatio(sourceTurn.aspectRatio || sourceTurn.size);
      const resolution =
        accountType === "free" ? "1k" : normalizeImageResolutionForAspectRatio(sourceTurn.resolution, aspectRatio);
      const quality = accountType === "free" ? "auto" : normalizeImageQuality(sourceTurn.quality);
      const nextTurn: ImageTurn = {
        id: nextTurnId,
        prompt: sourceTurn.prompt,
        model: "gpt-image-2",
        accountType,
        mode: sourceTurn.mode,
        referenceImages: sourceTurn.referenceImages,
        count,
        size: resolveImageOutputSize(resolution, aspectRatio),
        aspectRatio,
        resolution,
        quality,
        images: createLoadingImages(nextTurnId, count, now),
        createdAt: now,
        status: "queued",
      };
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: [...conversation.turns, nextTurn],
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
      toast.success("已加入重新生成队列");
    },
    [runConversationQueue],
  );

  const handleRetryImage = useCallback(
    async (conversationId: string, turnId: string, imageId: string) => {
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) {
        return;
      }

      const now = new Date().toISOString();
      const retryImageId = `${turnId}-${createId()}`;
      const nextConversation = {
        ...conversation,
        updatedAt: now,
        turns: conversation.turns.map((turn) => {
          if (turn.id !== turnId) {
            return turn;
          }
          if (!turn.prompt.trim()) {
            return turn;
          }

          const images = turn.images.map((image) =>
            image.id === imageId
              ? {
                  id: retryImageId,
                  taskId: retryImageId,
                  startedAt: now,
                  status: "loading" as const,
                }
              : image,
          );
          const derived = deriveTurnStatus({ ...turn, status: "queued", images });
          return {
            ...turn,
            ...derived,
            images,
          };
        }),
      };

      setSelectedConversationId(conversationId);
      await persistConversation(nextConversation);
      void runConversationQueue(conversationId);
    },
    [runConversationQueue],
  );

  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIds.has(conversation.id) &&
        conversation.turns.some(
          (turn) =>
            !turn.resultsDeleted &&
            (turn.status === "queued" || turn.status === "generating") &&
            turn.images.some((image) => image.status === "loading"),
        )
      ) {
        void runConversationQueue(conversation.id);
      }
    }
  }, [conversations, runConversationQueue]);

  const handleSubmit = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    const effectiveImageMode: ImageConversationMode = referenceImageFiles.length > 0 ? "edit" : "generate";
    const effectiveModel = normalizeSelectableImageModel(imageModel, imageAccountType);
    const effectiveResolution =
      imageAccountType === "free" ? "1k" : normalizeImageResolutionForAspectRatio(imageResolution, imageAspectRatio);
    const effectiveQuality = imageAccountType === "free" ? "auto" : imageQuality;
    const effectiveSize = resolveImageOutputSize(effectiveResolution, imageAspectRatio);

    const targetConversation = selectedConversationId
      ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt,
      model: effectiveModel,
      accountType: imageAccountType,
      mode: effectiveImageMode,
      referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
      count: parsedCount,
      size: effectiveSize,
      aspectRatio: imageAspectRatio,
      resolution: effectiveResolution,
      quality: effectiveQuality,
      images: createLoadingImages(turnId, parsedCount, now),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
        };

    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    void runConversationQueue(conversationId);

    const targetStats = getImageConversationStats(baseConversation);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入当前对话队列");
    } else if (!targetConversation) {
      toast.success("已创建新对话并开始处理");
    } else {
      toast.success("已发送到当前对话");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-3.5rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 overflow-hidden px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-4rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[248px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-border/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            onRenameConversation={handleRenameConversation}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,720px)] w-[92vw] max-w-[440px] flex-col overflow-hidden rounded-[24px] bg-background p-0">
            <DialogHeader className="shrink-0 border-b border-border/50 px-6 py-4">
              <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
                <History className="size-[17px] text-muted-foreground" strokeWidth={2} />
                历史对话
                <span className="ml-1 font-data text-[11px] font-medium text-muted-foreground/70">
                  {conversations.length}
                </span>
              </DialogTitle>
            </DialogHeader>
            <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                onRenameConversation={handleRenameConversation}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex min-h-0 flex-col gap-2 sm:gap-3">
          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-9 flex-1 rounded-lg border-border bg-card/90 text-[13px] text-foreground shadow-sm"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-1.5 size-4 text-muted-foreground" />
              历史对话 ({conversations.length})
            </Button>
            <Button className="h-9 rounded-lg bg-foreground px-3 text-[13px] text-background shadow-sm" onClick={handleCreateDraft}>
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-9 rounded-lg border-border bg-card/90 px-2 text-muted-foreground shadow-sm hover:text-rose-500"
              onClick={openClearHistoryConfirm}
              disabled={conversations.length === 0}
              title="清空历史"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div className="relative min-h-0 flex-1">
            <div
              ref={resultsViewportRef}
              className={`hide-scrollbar h-full min-h-0 overscroll-contain px-1 py-2 sm:px-4 sm:py-4 ${selectedConversation ? "overflow-y-auto" : "overflow-hidden"}`}
            >
              <ImageResults
                selectedConversation={selectedConversation}
                onOpenLightbox={openLightbox}
                onContinueEdit={handleContinueEdit}
                onDeletePrompt={openDeletePromptConfirm}
                onDeleteResults={openDeleteResultsConfirm}
                onReuseTurnConfig={handleReuseTurnConfig}
                onRegenerateTurn={handleRegenerateTurn}
                onRetryImage={handleRetryImage}
                formatConversationTime={formatConversationTime}
              />
            </div>
            {selectedConversation ? (
              <div className="pointer-events-none absolute right-2 bottom-3 z-10 flex flex-col gap-1.5 sm:right-6 sm:bottom-5">
                <Button
                  type="button"
                  variant="outline"
                  className="pointer-events-auto h-7 w-9 rounded-lg border-border/80 bg-card/85 p-0 text-muted-foreground shadow-sm backdrop-blur transition hover:bg-card hover:text-foreground"
                  onClick={() => scrollResultsToTop("smooth")}
                  title="跳到顶部"
                  aria-label="跳到顶部"
                >
                  <ChevronUp className="size-4" strokeWidth={2.25} />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="pointer-events-auto h-7 w-9 rounded-lg border-border/80 bg-card/85 p-0 text-muted-foreground shadow-sm backdrop-blur transition hover:bg-card hover:text-foreground"
                  onClick={() => scrollResultsToBottom("smooth")}
                  title="跳到底部"
                  aria-label="跳到底部"
                >
                  <ChevronDown className="size-4" strokeWidth={2.25} />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="shrink-0 px-1 sm:px-4">
            <div className="mx-auto w-full max-w-[980px]">
              <ImageComposer
                prompt={imagePrompt}
                imageCount={imageCount}
                imageAspectRatio={imageAspectRatio}
                imageResolution={selectedImageResolution}
                imageQuality={imageQuality}
                imageAccountType={imageAccountType}
                imageOutputSize={resolvedImageSize}
                activeTaskCount={activeTaskCount}
                accountTypeOptions={availableImageAccountTypes}
                isLoadingAccountTypes={isLoadingAccountTypes}
                referenceImages={referenceImages}
                textareaRef={textareaRef}
                fileInputRef={fileInputRef}
                onPromptChange={setImagePrompt}
                onImageCountChange={(value) => setImageCount(value ? clampImageCount(value) : "")}
                onImageAspectRatioChange={setImageAspectRatio}
                onImageResolutionChange={setImageResolution}
                onImageQualityChange={setImageQuality}
                onImageAccountTypeChange={setImageAccountType}
                onSubmit={handleSubmit}
                onPickReferenceImage={() => fileInputRef.current?.click()}
                onReferenceImageChange={handleReferenceImageChange}
                onRemoveReferenceImage={handleRemoveReferenceImage}
              />
            </div>
          </div>
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent />;
}
