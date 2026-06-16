"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";

import { BackupSettingsCard } from "./components/backup-settings-card";
import { ConfigCard } from "./components/config-card";
import { CPAPoolDialog } from "./components/cpa-pool-dialog";
import { CPAPoolsCard } from "./components/cpa-pools-card";
import { ImportBrowserDialog } from "./components/import-browser-dialog";
import { Section } from "./components/section";
import { SettingsHeader } from "./components/settings-header";
import { SettingsTOC, type TOCItem } from "./components/settings-toc";
import { Sub2APIConnections } from "./components/sub2api-connections";
import { UserKeysCard } from "./components/user-keys-card";
import { useSettingsStore } from "./store";

const SECTIONS: Array<TOCItem & { description: string }> = [
  { id: "config", label: "系统配置", description: "账号刷新、代理、图片生成、内容安全、AI 审核与 WebDAV 图片存储。" },
  { id: "backup", label: "备份", description: "Cloudflare R2 自动备份配置、立即备份与历史备份列表。" },
  { id: "users", label: "用户密钥", description: "为普通用户分发访问密钥，并控制可用入口。" },
  { id: "cpa", label: "CPA 号池", description: "外部 CPA 接入，支持远程账号选择性导入到本地号池。" },
  { id: "sub2api", label: "sub2api", description: "把已有的 OpenAI 兼容服务串成 sub2api 多节点上游。" },
];

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadPools = useSettingsStore((state) => state.loadPools);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const pools = useSettingsStore((state) => state.pools);
  const backupState = useSettingsStore((state) => state.backupState);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const hasRunningJobs = pools.some((pool) => {
      const status = pool.import_job?.status;
      return status === "pending" || status === "running";
    });
    if (!hasRunningJobs) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPools(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadPools, pools]);

  useEffect(() => {
    if (!backupState?.running) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadBackups(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [backupState?.running, loadBackups]);

  return null;
}

function SettingsPageContent() {
  const tocItems: TOCItem[] = SECTIONS.map(({ id, label }) => ({ id, label }));

  return (
    <>
      <SettingsDataController />
      <SettingsHeader />
      <div className="mt-8 flex gap-12 pb-16">
        <div className="min-w-0 flex-1 space-y-12">
          <Section id="config" title="系统配置" description={SECTIONS[0].description}>
            <ConfigCard />
          </Section>
          <Section id="backup" title="备份" description={SECTIONS[1].description}>
            <BackupSettingsCard />
          </Section>
          <Section id="users" title="用户密钥" description={SECTIONS[2].description}>
            <UserKeysCard />
          </Section>
          <Section id="cpa" title="CPA 号池" description={SECTIONS[3].description}>
            <CPAPoolsCard />
          </Section>
          <Section id="sub2api" title="sub2api" description={SECTIONS[4].description}>
            <Sub2APIConnections />
          </Section>
        </div>
        <SettingsTOC items={tocItems} />
      </div>
      <CPAPoolDialog />
      <ImportBrowserDialog />
    </>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <SettingsPageContent />;
}
