"use client";
import { ArrowUp, ImagePlus, LoaderCircle, X } from "lucide-react";
import { useMemo, useState, type ClipboardEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  formatImageOutputSize,
  type ImageAspectRatio,
  type ImageQuality,
} from "@/lib/image-generation-options";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageAspectRatio: ImageAspectRatio;
  imageQuality: ImageQuality;
  imageOutputSize: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageAspectRatioChange: (value: ImageAspectRatio) => void;
  onImageQualityChange: (value: ImageQuality) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

export function ImageComposer({
  prompt,
  imageCount,
  imageAspectRatio,
  imageQuality,
  imageOutputSize,
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageAspectRatioChange,
  onImageQualityChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const imageAspectRatioOptions: Array<{ value: ImageAspectRatio; label: string }> = [
    { value: "1:1", label: "1:1 (正方形)" },
    { value: "16:9", label: "16:9 (横版)" },
    { value: "4:3", label: "4:3 (横版)" },
    { value: "3:4", label: "3:4 (竖版)" },
    { value: "9:16", label: "9:16 (竖版)" },
  ];
  const imageQualityOptions: Array<{ value: ImageQuality; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
  ];

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-12 shrink-0 sm:size-14">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group size-12 overflow-hidden rounded-xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-14"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -top-1 -right-1 inline-flex size-[18px] items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-2.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {activeTaskCount > 0 ? (
          <div className="mb-2 flex justify-end px-1">
            <div className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-100 bg-amber-50 px-2.5 text-[11px] font-medium text-amber-700 shadow-sm">
              <LoaderCircle className="size-3 animate-spin" />
              <span className="font-data tabular-nums">{activeTaskCount}</span>
              <span>个任务处理中</span>
            </div>
          </div>
        ) : null}

        <div className="relative overflow-hidden rounded-[22px] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_20px_rgba(15,23,42,0.07)] transition sm:rounded-[26px]">
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                referenceImages.length > 0
                  ? "描述你希望如何修改参考图"
                  : "输入你想要生成的画面，也可直接粘贴图片"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[74px] resize-none rounded-[22px] border-0 bg-transparent px-3.5 pt-3.5 pb-2 text-[14px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[116px] sm:rounded-[26px] sm:px-5 sm:pt-5 sm:pb-3"
            />

            <div className="rounded-b-[22px] border-t border-stone-100 bg-white px-2.5 pt-2 pb-2.5 sm:rounded-b-[26px] sm:px-4 sm:py-3" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:pb-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 shrink-0 rounded-full border-0 bg-stone-100 px-2.5 text-[11px] font-medium text-stone-700 shadow-none hover:bg-stone-200 sm:h-9 sm:px-3 sm:text-xs"
                    onClick={onPickReferenceImage}
                    aria-label={referenceImages.length > 0 ? "添加参考图" : "上传"}
                  >
                    <ImagePlus className="size-3.5" />
                    <span className="hidden sm:inline">{referenceImages.length > 0 ? "添加参考图" : "上传"}</span>
                  </Button>
                  <div className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 sm:h-9 sm:gap-1.5 sm:px-2.5">
                    <span className="hidden text-[11px] font-medium text-stone-700 sm:inline">张数</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="100"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-6 w-[36px] border-0 bg-transparent px-0 text-center text-[11px] font-medium text-stone-700 shadow-none focus-visible:ring-0 sm:h-7 sm:w-[52px] sm:text-xs"
                    />
                  </div>
                  <div className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] sm:h-9 sm:gap-1.5 sm:px-2.5">
                    <span className="hidden font-medium text-stone-700 sm:inline">比例</span>
                    <Select value={imageAspectRatio} onValueChange={(value) => onImageAspectRatioChange(value as ImageAspectRatio)}>
                      <SelectTrigger className="h-6 w-[72px] rounded-full border-0 bg-transparent px-0 text-[11px] font-bold text-stone-700 shadow-none focus-visible:ring-0 min-[390px]:w-[88px] sm:h-7 sm:w-[108px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start" className="min-w-[168px]">
                        {imageAspectRatioOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="hidden border-l border-stone-100 pl-1.5 text-[11px] font-semibold text-stone-500 min-[520px]:inline">
                      {formatImageOutputSize(imageOutputSize)}
                    </span>
                  </div>
                  <div className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] sm:h-9 sm:gap-1.5 sm:px-2.5">
                    <span className="hidden font-medium text-stone-700 sm:inline">质量</span>
                    <Select
                      value={imageQuality}
                      onValueChange={(value) => onImageQualityChange(value as ImageQuality)}
                    >
                      <SelectTrigger className="h-6 w-[46px] rounded-full border-0 bg-transparent px-0 text-[11px] font-bold text-stone-700 shadow-none focus-visible:ring-0 disabled:opacity-45 sm:h-7 sm:w-[58px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start" className="min-w-[118px]">
                        {imageQualityOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-stone-900 text-white shadow-[0_1px_2px_rgba(15,23,42,0.1),0_4px_12px_-2px_rgba(15,23,42,0.2)] transition hover:bg-stone-800 hover:shadow-[0_1px_2px_rgba(15,23,42,0.1),0_8px_20px_-4px_rgba(15,23,42,0.3)] disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none sm:size-9"
                  aria-label={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
                >
                  <ArrowUp className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

