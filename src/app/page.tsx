"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

// メモへの追記（リプライ）のデータ型定義
interface NoteReply {
  id: string;
  content: string;
  createdAt: string;
}

// メモの訂正履歴のデータ型定義（思考の不可逆性を保つため過去の文章を記録）
interface NoteEditHistory {
  id: string;
  previousContent: string;
  editedAt: string;
}

// メモのデータ型定義
interface Note {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
  isTrash?: boolean; // ゴミ箱フラグ（完全削除せず退避する）
  categories?: string[]; // カテゴリタグ一覧
  isFavorite?: boolean; // お気に入りフラグ
  replies?: NoteReply[]; // 追記リスト（大元のメモにぶら下がる1階層の時系列ログ）
  editHistory?: NoteEditHistory[]; // 訂正履歴リスト（過去の文章をいつでも振り返れる）
  remindAt?: string; // 見返す日（YYYY-MM-DD形式のローカル日付）
  isLocked?: boolean; // 鍵付きメモフラグ
}

// 運営からのお知らせのデータ型定義
interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  category: string;
  published_at: string;
}

const getAnnouncementCategoryLabel = (category: string) => {
  switch (category) {
    case "important":
    case "重要":
      return { label: "重要", isImportant: true };
    case "update":
    case "アップデート":
      return { label: "アップデート", isImportant: false };
    case "info":
    case "お知らせ":
    case "":
      return { label: "お知らせ", isImportant: false };
    default:
      return { label: category, isImportant: false };
  }
};

// DB行からNoteオブジェクトへのマッピング
interface DbNoteRow {
  id: string;
  user_id: string;
  title: string | null;
  content: string;
  created_at: string;
  is_trash: boolean;
  is_favorite: boolean;
  categories: string[] | null;
  replies: NoteReply[] | null;
  edit_history?: NoteEditHistory[] | null;
  remind_at?: string | null;
  is_locked?: boolean | null;
}

const mapDbRowToNote = (row: DbNoteRow): Note => ({
  id: row.id,
  title: row.title || undefined,
  content: row.content,
  createdAt: row.created_at,
  isTrash: Boolean(row.is_trash),
  isFavorite: Boolean(row.is_favorite),
  categories: row.categories && row.categories.length > 0 ? row.categories : undefined,
  replies: Array.isArray(row.replies) && row.replies.length > 0 ? row.replies : undefined,
  editHistory: Array.isArray(row.edit_history) && row.edit_history.length > 0 ? row.edit_history : undefined,
  remindAt: row.remind_at || undefined,
  isLocked: Boolean(row.is_locked),
});

// NoteオブジェクトからDB行へのマッピング
const mapNoteToDbRow = (note: Note, userId: string): DbNoteRow => {
  const row: DbNoteRow = {
    id: note.id,
    user_id: userId,
    title: note.title || null,
    content: note.content,
    created_at: note.createdAt,
    is_trash: Boolean(note.isTrash),
    is_favorite: Boolean(note.isFavorite),
    categories: note.categories || [],
    replies: note.replies || [],
  };
  if (note.editHistory && note.editHistory.length > 0) {
    row.edit_history = note.editHistory;
  }
  if (note.remindAt) {
    row.remind_at = note.remindAt;
  }
  if (note.isLocked) {
    row.is_locked = true;
  }
  return row;
};

interface CategoryItem {
  id: string;
  name: string;
  updatedAt: string;
  deleted?: boolean;
}

const LEGACY_EPOCH = "1970-01-01T00:00:00.000Z";

// 既存（文字列のみ）のカテゴリ名から全端末共通の決定論的IDを生成
const legacyCategoryId = (name: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `cid_leg_${(h >>> 0).toString(16).padStart(8, "0")}`;
};

const createCategoryId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `cid_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `cid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
};

const parseCategoryItems = (raw: unknown): CategoryItem[] => {
  if (!Array.isArray(raw)) return [];
  const items: CategoryItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let parsed: CategoryItem | null = null;
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{")) {
        try {
          const obj = JSON.parse(trimmed) as Partial<CategoryItem>;
          if (typeof obj.id === "string" && obj.id && typeof obj.name === "string" && obj.name) {
            parsed = {
              id: obj.id,
              name: obj.name,
              updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : LEGACY_EPOCH,
              ...(obj.deleted ? { deleted: true } : {}),
            };
          }
        } catch {
          // fallback to legacy plain string
        }
      }
      if (!parsed) {
        parsed = {
          id: legacyCategoryId(trimmed),
          name: trimmed,
          updatedAt: LEGACY_EPOCH,
        };
      }
    } else if (entry && typeof entry === "object") {
      const obj = entry as Partial<CategoryItem>;
      if (typeof obj.id === "string" && obj.id && typeof obj.name === "string" && obj.name) {
        parsed = {
          id: obj.id,
          name: obj.name,
          updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : LEGACY_EPOCH,
          ...(obj.deleted ? { deleted: true } : {}),
        };
      }
    }
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      items.push(parsed);
    }
  }
  return items;
};

const serializeCategoryItems = (items: CategoryItem[]): string[] =>
  items.map((item) =>
    JSON.stringify(
      item.deleted
        ? { id: item.id, name: item.name, updatedAt: item.updatedAt, deleted: true }
        : { id: item.id, name: item.name, updatedAt: item.updatedAt }
    )
  );

const mergeCategoryItems = (primary: CategoryItem[], secondary: CategoryItem[]): CategoryItem[] => {
  const byId = new Map<string, CategoryItem>();
  const order: string[] = [];

  const applyItem = (item: CategoryItem) => {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      order.push(item.id);
      return;
    }
    const existingTime = new Date(existing.updatedAt || LEGACY_EPOCH).getTime() || 0;
    const incomingTime = new Date(item.updatedAt || LEGACY_EPOCH).getTime() || 0;
    if (incomingTime > existingTime) {
      byId.set(item.id, item);
    }
  };

  primary.forEach(applyItem);
  secondary.forEach(applyItem);
  return order.map((id) => byId.get(id)!);
};

const migrateNotesCategories = (
  inputNotes: Note[],
  catalog: CategoryItem[]
): {
  migratedNotes: Note[];
  updatedCatalog: CategoryItem[];
  changedNoteIds: string[];
  catalogChanged: boolean;
} => {
  let nextCatalog = [...catalog];
  const knownIds = new Set(nextCatalog.map((c) => c.id));
  const changedNoteIds: string[] = [];
  let catalogChanged = false;

  const migratedNotes = inputNotes.map((note) => {
    if (!note.categories || note.categories.length === 0) return note;
    let noteChanged = false;
    const mapped = note.categories.map((cat) => {
      if (knownIds.has(cat) || cat.startsWith("cid_")) {
        return cat;
      }
      const id = legacyCategoryId(cat);
      noteChanged = true;
      if (!knownIds.has(id)) {
        knownIds.add(id);
        nextCatalog = [
          ...nextCatalog,
          { id, name: cat, updatedAt: LEGACY_EPOCH },
        ];
        catalogChanged = true;
      }
      return id;
    });
    if (!noteChanged) return note;
    changedNoteIds.push(note.id);
    return { ...note, categories: Array.from(new Set(mapped)) };
  });

  return { migratedNotes, updatedCatalog: nextCatalog, changedNoteIds, catalogChanged };
};

type AutoLockMode = "manual" | "5m" | "15m" | "background";

// 鍵付きメモのテキストを改行を保ったまま文字数分の「・」でマスクする
const maskLockedText = (text: string): string => text.replace(/[^\r\n]/g, "・");

// HTTPS以外のローカルネットワーク環境でも同一に動作する純粋JS版SHA-256ハッシュ
const hashLockPassword = (passcode: string): string => {
  const input = `seednote-lock-v1:${passcode}`;
  const bytes: number[] = [];
  if (typeof TextEncoder !== "undefined") {
    bytes.push(...Array.from(new TextEncoder().encode(input)));
  } else {
    const encoded = unescape(encodeURIComponent(input));
    for (let i = 0; i < encoded.length; i++) {
      bytes.push(encoded.charCodeAt(i));
    }
  }

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  for (let i = 3; i >= 0; i--) bytes.push((highBits >>> (i * 8)) & 0xff);
  for (let i = 3; i >= 0; i--) bytes.push((lowBits >>> (i * 8)) & 0xff);

  const w = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] = ((bytes[idx] << 24) | (bytes[idx + 1] << 16) | (bytes[idx + 2] << 8) | bytes[idx + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  return H.map((v) => v.toString(16).padStart(8, "0")).join("");
};

// ローカルタイムゾーンで YYYY-MM-DD 形式の日付文字列を生成
const getLocalYmd = (offsetDays: number = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const formatReminderLabel = (ymd: string): { label: string; isDue: boolean } => {
  const today = getLocalYmd(0);
  const tomorrow = getLocalYmd(1);
  const parts = ymd.split("-");
  const shortDate =
    parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : ymd;

  if (ymd < today) {
    return { label: `期限超過 (${shortDate})`, isDue: true };
  }
  if (ymd === today) {
    return { label: "今日見返す", isDue: true };
  }
  if (ymd === tomorrow) {
    return { label: `明日 (${shortDate})`, isDue: false };
  }
  return { label: `${shortDate} 見返す`, isDue: false };
};

const REMINDER_PRESET_OFFSETS = [
  { label: "明日", days: 1 },
  { label: "3日後", days: 3 },
  { label: "1週間後", days: 7 },
] as const;

// すっきりしたシンプルな線画SVGアイコン（絵文字の重複や怖さを解消）
const CopyIcon = ({ className = "w-3.5 h-3.5" }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const EyeIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = ({ className = "w-4 h-4" }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

type TabType = "home" | "list" | "categories" | "trash" | "settings";
type FontSize = "normal" | "large";
type ButtonSize = "normal" | "large";
type FontFamily = "sans" | "serif" | "rounded";
type CategorySortOrder = "usage" | "alphabetical" | "created";

// フォントファミリーのCSSスタイル取得
const getFontFamilyStyle = (family: FontFamily): string => {
  switch (family) {
    case "serif":
      return "'Hiragino Mincho ProN', 'Yu Mincho', 'BIZ UDPMincho', 'MS PMincho', serif";
    case "rounded":
      return "'Hiragino Maru Gothic ProN', 'BIZ UDPGothic', 'Yu Gothic', sans-serif";
    case "sans":
    default:
      return "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
  }
};

export type NoteFontFamily = "sans" | "klee" | "yomogi" | "mincho" | "mono";

// メモ本文専用のCSSフォントスタイル取得（手帳ペン字・ほっこり手書き・読書明朝・レトロ等幅・標準）
const getNoteFontFamilyStyle = (font: NoteFontFamily): string => {
  switch (font) {
    case "klee":
      return "'Klee One', 'Yu Kyokasho', 'Hiragino Maru Gothic ProN', sans-serif";
    case "yomogi":
      return "'Yomogi', 'Hannotate SC', 'Comic Sans MS', cursive, sans-serif";
    case "mincho":
      return "'Shippori Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', serif";
    case "mono":
      return "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    case "sans":
    default:
      return "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
  }
};

// テーマカラーの定義（標準クリーム、黒、および10色×パステル／ダーク）
export type ColorHue =
  | "cream"
  | "black"
  | "red"
  | "pink"
  | "orange"
  | "yellow"
  | "lime"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "brown";

export type ThemeBrightness = "pastel" | "dark";

export interface ThemePalette {
  name: string;
  dotColor: string;
  bgApp: string;
  bgCard: string;
  bgCardHover: string;
  bgSub: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  accentText: string;
  isDark: boolean;
}

// 目に優しい10色の選択肢リスト
export const HUE_OPTIONS: { id: ColorHue; label: string; pastelDot: string; darkDot: string }[] = [
  { id: "red", label: "赤", pastelDot: "#f5d0cd", darkDot: "#4a201f" },
  { id: "pink", label: "ピンク", pastelDot: "#f7d2e2", darkDot: "#4a1e34" },
  { id: "orange", label: "オレンジ", pastelDot: "#f7d9c6", darkDot: "#4a2615" },
  { id: "yellow", label: "黄色", pastelDot: "#f7e8be", darkDot: "#403413" },
  { id: "lime", label: "黄緑", pastelDot: "#e8efce", darkDot: "#2d3b13" },
  { id: "green", label: "緑", pastelDot: "#d5ebd8", darkDot: "#163b20" },
  { id: "cyan", label: "水色", pastelDot: "#d0ebf0", darkDot: "#14393d" },
  { id: "blue", label: "青", pastelDot: "#d2e4f7", darkDot: "#162c47" },
  { id: "purple", label: "紫", pastelDot: "#e5d7f7", darkDot: "#2e1947" },
  { id: "brown", label: "茶色", pastelDot: "#e8dacb", darkDot: "#382319" },
];

export const getThemePalette = (hue: ColorHue, brightness: ThemeBrightness): ThemePalette => {
  if (hue === "cream") {
    return {
      name: "標準クリーム",
      dotColor: "#e8e2d5",
      bgApp: "#e8e2d5",
      bgCard: "#f2efe9",
      bgCardHover: "#eae5dc",
      bgSub: "#e2dcce",
      border: "#d5cdc0",
      textPrimary: "#2d2926",
      textSecondary: "#786f66",
      accent: "#3d3731",
      accentText: "#faf8f5",
      isDark: false,
    };
  }

  if (hue === "black") {
    return {
      name: "黒（ダークモード）",
      dotColor: "#1a1918",
      bgApp: "#1a1918",
      bgCard: "#252321",
      bgCardHover: "#2e2b28",
      bgSub: "#33302c",
      border: "#3d3935",
      textPrimary: "#eae5dc",
      textSecondary: "#9e968b",
      accent: "#d49e35",
      accentText: "#1a1918",
      isDark: true,
    };
  }

  if (brightness === "pastel") {
    switch (hue) {
      case "red":
        return {
          name: "あずきパステル",
          dotColor: "#f5d0cd",
          bgApp: "#eae9e6",
          bgCard: "#faf1f0",
          bgCardHover: "#f2e4e2",
          bgSub: "#ebd8d6",
          border: "#dfc7c4",
          textPrimary: "#3a2220",
          textSecondary: "#825d5a",
          accent: "#8c3830",
          accentText: "#ffffff",
          isDark: false,
        };
      case "pink":
        return {
          name: "サクラパステル",
          dotColor: "#f7d2e2",
          bgApp: "#eae9e6",
          bgCard: "#fcf2f6",
          bgCardHover: "#f5e4ec",
          bgSub: "#edd7e1",
          border: "#e0c5d2",
          textPrimary: "#3b202a",
          textSecondary: "#85586d",
          accent: "#943c62",
          accentText: "#ffffff",
          isDark: false,
        };
      case "orange":
        return {
          name: "アプリコットパステル",
          dotColor: "#f7d9c6",
          bgApp: "#eae9e6",
          bgCard: "#fcf5ee",
          bgCardHover: "#f5e7db",
          bgSub: "#ecdcce",
          border: "#dfccbc",
          textPrimary: "#3d2618",
          textSecondary: "#856049",
          accent: "#994d1f",
          accentText: "#ffffff",
          isDark: false,
        };
      case "yellow":
        return {
          name: "ミモザパステル",
          dotColor: "#f7e8be",
          bgApp: "#eae9e6",
          bgCard: "#fbf7ec",
          bgCardHover: "#f5ebd2",
          bgSub: "#ebe0c3",
          border: "#dfd2b0",
          textPrimary: "#382e14",
          textSecondary: "#7d6b3f",
          accent: "#87651a",
          accentText: "#ffffff",
          isDark: false,
        };
      case "lime":
        return {
          name: "若草パステル",
          dotColor: "#e8efce",
          bgApp: "#eae9e6",
          bgCard: "#f6f8ec",
          bgCardHover: "#edf2d7",
          bgSub: "#e3eac7",
          border: "#d3ddb2",
          textPrimary: "#282e13",
          textSecondary: "#646e3d",
          accent: "#5a6820",
          accentText: "#ffffff",
          isDark: false,
        };
      case "green":
        return {
          name: "抹茶パステル",
          dotColor: "#d5ebd8",
          bgApp: "#eae9e6",
          bgCard: "#f0f7f1",
          bgCardHover: "#e0ede2",
          bgSub: "#d4e6d7",
          border: "#c3dac7",
          textPrimary: "#1b3020",
          textSecondary: "#4f7357",
          accent: "#2f6b39",
          accentText: "#ffffff",
          isDark: false,
        };
      case "cyan":
        return {
          name: "ミントパステル",
          dotColor: "#d0ebf0",
          bgApp: "#eae9e6",
          bgCard: "#eef7f8",
          bgCardHover: "#dceef1",
          bgSub: "#cfe7eb",
          border: "#bed9de",
          textPrimary: "#152e33",
          textSecondary: "#456e75",
          accent: "#226a75",
          accentText: "#ffffff",
          isDark: false,
        };
      case "blue":
        return {
          name: "空色パステル",
          dotColor: "#d2e4f7",
          bgApp: "#eae9e6",
          bgCard: "#eef4fc",
          bgCardHover: "#dce8f7",
          bgSub: "#cfe0f2",
          border: "#bed2e8",
          textPrimary: "#16283d",
          textSecondary: "#476487",
          accent: "#27598c",
          accentText: "#ffffff",
          isDark: false,
        };
      case "purple":
        return {
          name: "ラベンダーパステル",
          dotColor: "#e5d7f7",
          bgApp: "#eae9e6",
          bgCard: "#f5f0fb",
          bgCardHover: "#eae0f7",
          bgSub: "#ded1f0",
          border: "#cdc0e3",
          textPrimary: "#261b38",
          textSecondary: "#634f80",
          accent: "#573785",
          accentText: "#ffffff",
          isDark: false,
        };
      case "brown":
        return {
          name: "ラテパステル",
          dotColor: "#e8dacb",
          bgApp: "#eae9e6",
          bgCard: "#f7f1eb",
          bgCardHover: "#ebe0d4",
          bgSub: "#dfd2c4",
          border: "#d1c2b2",
          textPrimary: "#332318",
          textSecondary: "#785d4d",
          accent: "#694228",
          accentText: "#ffffff",
          isDark: false,
        };
    }
  } else {
    // dark
    switch (hue) {
      case "red":
        return {
          name: "ダークワイン",
          dotColor: "#4a201f",
          bgApp: "#1a1918",
          bgCard: "#2f1f1f",
          bgCardHover: "#3b2626",
          bgSub: "#402828",
          border: "#523333",
          textPrimary: "#f2dede",
          textSecondary: "#b89191",
          accent: "#d9574c",
          accentText: "#ffffff",
          isDark: true,
        };
      case "pink":
        return {
          name: "ダークプラム",
          dotColor: "#4a1e34",
          bgApp: "#1a1918",
          bgCard: "#311e29",
          bgCardHover: "#3d2533",
          bgSub: "#422837",
          border: "#543346",
          textPrimary: "#f2dee8",
          textSecondary: "#ba8fa6",
          accent: "#d6518f",
          accentText: "#ffffff",
          isDark: true,
        };
      case "orange":
        return {
          name: "ダークアンバー",
          dotColor: "#4a2615",
          bgApp: "#1a1918",
          bgCard: "#31231a",
          bgCardHover: "#3d2a1f",
          bgSub: "#422e22",
          border: "#543a2b",
          textPrimary: "#f2e2d8",
          textSecondary: "#ba9680",
          accent: "#d67131",
          accentText: "#ffffff",
          isDark: true,
        };
      case "yellow":
        return {
          name: "ダークゴールド",
          dotColor: "#403413",
          bgApp: "#1a1918",
          bgCard: "#2e2717",
          bgCardHover: "#3b311d",
          bgSub: "#3d341e",
          border: "#4f4327",
          textPrimary: "#f2ebd6",
          textSecondary: "#b8ab84",
          accent: "#d6a524",
          accentText: "#1a1508",
          isDark: true,
        };
      case "lime":
        return {
          name: "ダークモス",
          dotColor: "#2d3b13",
          bgApp: "#1a1918",
          bgCard: "#242e16",
          bgCardHover: "#2e3b1c",
          bgSub: "#313d1d",
          border: "#415226",
          textPrimary: "#eaf0dc",
          textSecondary: "#a6b885",
          accent: "#8abf24",
          accentText: "#131a06",
          isDark: true,
        };
      case "green":
        return {
          name: "ディープフォレスト",
          dotColor: "#163b20",
          bgApp: "#1a1918",
          bgCard: "#192e20",
          bgCardHover: "#203b29",
          bgSub: "#223d2b",
          border: "#2b4f37",
          textPrimary: "#dcf0e2",
          textSecondary: "#8cb896",
          accent: "#3ea858",
          accentText: "#ffffff",
          isDark: true,
        };
      case "cyan":
        return {
          name: "ダークティール",
          dotColor: "#14393d",
          bgApp: "#1a1918",
          bgCard: "#172e30",
          bgCardHover: "#1d3a3d",
          bgSub: "#203f42",
          border: "#295257",
          textPrimary: "#daf0f2",
          textSecondary: "#8ab3b8",
          accent: "#31a4b3",
          accentText: "#ffffff",
          isDark: true,
        };
      case "blue":
        return {
          name: "ディープミッドナイト",
          dotColor: "#162c47",
          bgApp: "#1a1918",
          bgCard: "#192736",
          bgCardHover: "#203245",
          bgSub: "#22354a",
          border: "#2b445e",
          textPrimary: "#dae7f5",
          textSecondary: "#8aa6c7",
          accent: "#3b7ec9",
          accentText: "#ffffff",
          isDark: true,
        };
      case "purple":
        return {
          name: "ダークアメジスト",
          dotColor: "#2e1947",
          bgApp: "#1a1918",
          bgCard: "#271936",
          bgCardHover: "#322045",
          bgSub: "#36224a",
          border: "#462c61",
          textPrimary: "#ebdcf5",
          textSecondary: "#af8ec7",
          accent: "#824ac2",
          accentText: "#ffffff",
          isDark: true,
        };
      case "brown":
        return {
          name: "ダークエスプレッソ",
          dotColor: "#382319",
          bgApp: "#1a1918",
          bgCard: "#2b1f19",
          bgCardHover: "#36271f",
          bgSub: "#3a2a22",
          border: "#4a352a",
          textPrimary: "#f0e3db",
          textSecondary: "#b89c8a",
          accent: "#ad6a40",
          accentText: "#ffffff",
          isDark: true,
        };
    }
  }

  // フォールバック
  return {
    name: "標準クリーム",
    dotColor: "#e8e2d5",
    bgApp: "#e8e2d5",
    bgCard: "#f2efe9",
    bgCardHover: "#eae5dc",
    bgSub: "#e2dcce",
    border: "#d5cdc0",
    textPrimary: "#2d2926",
    textSecondary: "#786f66",
    accent: "#3d3731",
    accentText: "#faf8f5",
    isDark: false,
  };
};

// 時間帯の定義（朝・昼・夕方・夜・深夜）
type TimeSlotKey = "morning" | "afternoon" | "evening" | "night" | "lateNight";

interface TimeSlotConfig {
  label: string;
  icon: string;
  startHour: number; // 0〜23
  endHour: number;   // 0〜23
  color: string;     // 目に優しい識別カラー
}

const DEFAULT_TIME_SLOTS: Record<TimeSlotKey, TimeSlotConfig> = {
  morning: { label: "朝", icon: "🌅", startHour: 5, endHour: 10, color: "#529961" },
  afternoon: { label: "昼", icon: "☀️", startHour: 11, endHour: 16, color: "#d9a036" },
  evening: { label: "夕方", icon: "🌆", startHour: 17, endHour: 19, color: "#d4693b" },
  night: { label: "夜", icon: "🌙", startHour: 20, endHour: 22, color: "#8562a6" },
  lateNight: { label: "深夜", icon: "🌌", startHour: 23, endHour: 4, color: "#4a7bb0" },
};

// 読み間違いしやすい 0, 1, I, O を除外した英数字による復旧キー生成
const generateRecoveryKey = (): string => {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let part1 = "";
  let part2 = "";
  for (let i = 0; i < 4; i++) {
    part1 += chars.charAt(Math.floor(Math.random() * chars.length));
    part2 += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SEED-${part1}-${part2}`;
};

const MAX_NOTE_TITLE_LENGTH = 100;
const MAX_NOTE_CONTENT_LENGTH = 10000;
const NOTE_LENGTH_WARN_THRESHOLD = 8000;
const NOTE_TITLE_WARN_THRESHOLD = 80;
const MAX_CATEGORY_NAME_LENGTH = 30;
const MAX_USERNAME_LENGTH = 30;
const MAX_PASSWORD_LENGTH = 64;

// 絵文字（サロゲートペア）を途中で切断しない安全な文字数カット
const truncateByCodePoints = (text: string, maxLength: number): string => {
  const chars = Array.from(text);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : text;
};

// localStorage の容量超過等でも後続の画面更新・クラウド同期を止めない安全な保存ヘルパー
const safeSetLocalStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`localStorage保存スキップ (${key}):`, e);
  }
};
type NoteCollapseLines = 0 | 5 | 8 | 12;
type SyncStatus = "idle" | "syncing" | "offline" | "error";

// Supabase DB用ユーザー設定・カテゴリ同期レコード定義
interface DbUserSettingsRow {
  user_id: string;
  categories: string[] | null;
  time_slots: Record<TimeSlotKey, TimeSlotConfig> | null;
  font_size: FontSize | null;
  button_size: ButtonSize | null;
  font_family?: FontFamily | null;
  note_font?: NoteFontFamily | null;
  note_collapse_lines?: NoteCollapseLines | null;
  enable_toast: boolean | null;
  confirm_discard: boolean | null;
  recovery_key?: string | null;
  theme_hue?: ColorHue | null;
  theme_brightness?: ThemeBrightness | null;
  lock_password_hash?: string | null;
  mask_locked_title?: boolean | null;
  auto_lock_mode?: AutoLockMode | null;
  updated_at?: string;
}

// ガイド・ヘルプの全項目データ
const HELP_ITEMS = [
  {
    id: "about",
    title: "ライトNoteとは",
    content: (
      <div className="space-y-1.5">
        <p>自分のアイデアや思いついたことを素早く記録し、あとから簡単に探し出せるメモアプリです。</p>
        <p>日記、仕事や勉強のメモ、読書記録、ふと思いついたアイデアなど、ジャンルを問わず自由に記録できます。</p>
        <p>思いついた一言を気軽に記録でき、書いた内容はすべてプライベートなメモとして保存されます。</p>
      </div>
    ),
  },
  {
    id: "concept",
    title: "ライトNoteの考え方",
    content: (
      <div className="space-y-1.5">
        <p>ライトNoteは、<strong>「思いついた瞬間にすぐ書けること」</strong>を一番大切にしています。</p>
        <p>せっかくのアイデアや気づきも、書こうとして迷っているうちに忘れてしまってはもったいないからです。</p>
        <p>まずは余計な装飾のない画面にパッと書き留めておき、整理や振り返りは「見る」画面や検索機能から後からゆっくり行える設計になっています。</p>
      </div>
    ),
  },
  {
    id: "start",
    title: "記録の仕方",
    content: (
      <div className="space-y-2">
        <ol className="list-decimal pl-5 space-y-1">
          <li>思いついたことをそのまま書く</li>
          <li>「保存」を押す</li>
          <li>必要であれば、後からカテゴリを設定する</li>
        </ol>
        <p className="text-xs opacity-75 pt-1">
          ※最初は細かい整理を気にせず、思いついたことをどんどん記録してみてください。
        </p>
      </div>
    ),
  },
  {
    id: "save",
    title: "💾 メモの保存 / 保存通知について",
    content: (
      <div className="space-y-2">
        <p>
          書いた内容は「保存」ボタンを押すだけで記録されます。キーボードの{" "}
          <code className="px-1 py-0.5 rounded text-xs" style={{ backgroundColor: "rgba(128, 128, 128, 0.14)" }}>
            Ctrl + Enter
          </code>
          （Macは{" "}
          <code className="px-1 py-0.5 rounded text-xs" style={{ backgroundColor: "rgba(128, 128, 128, 0.14)" }}>
            Cmd + Enter
          </code>
          ）でも素早く保存できます。
        </p>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-1">文字数の目安：</strong>
          <p className="text-xs">
            1件あたりタイトルは100文字、本文・追記・訂正は各10,000文字まで保存できます。8,000文字を超えると入力欄に控えめな文字数カウンターが表示されます。
          </p>
        </div>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-1">保存通知について：</strong>
          <p>
            メモを保存した時に、画面の下に「保存しました」という小さな通知を表示できます。「ちゃんと保存されたかな？」と安心したい時におすすめです。通知が不要な場合は、メニューの「設定」からOFFにすることもできます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "category",
    title: "🏷️ カテゴリ / ”未分類”について",
    content: (
      <div className="space-y-2.5">
        <div className="space-y-1.5">
          <strong className="block mb-0.5">カテゴリの作成：</strong>
          <p>「日記」「仕事」「勉強」など、自分の好きなカテゴリを自由に作れます（30文字まで）。一度使ったカテゴリは候補として表示されるので、次からはワンタップで選べます。</p>
          <div
            className="px-2.5 py-1.5 rounded-lg text-xs leading-relaxed"
            style={{ backgroundColor: "rgba(128, 128, 128, 0.1)" }}
          >
            💡 <strong>アドバイス：</strong> カテゴリ名に「💼 仕事」「🌱 アイデア」のように絵文字をつけると、一覧でパッと見分けやすくなります！
          </div>
        </div>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-0.5">”未分類”での保存：</strong>
          <p>
            カテゴリで迷ったときは、何も選ばず<strong>そのまま保存して大丈夫</strong>です（自動的に「”未分類”」として記録されます）。「アイデアが浮かんだ瞬間にすぐ書くこと」を一番優先してほしいので、カテゴリは後からいつでも設定・変更できます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "quick_access",
    title: "画面の切り替え（書く ⇄ 見る）",
    content: (
      <div className="space-y-1.5">
        <p>画面最上部の中央にあるカプセルボタンで、いつでもワンタップで行き来できます。</p>
        <ul className="list-disc pl-5 space-y-1 text-xs">
          <li><strong>✏️ 書く：</strong> 思考を逃さず即メモできる入力画面（ホーム）に戻ります。</li>
          <li><strong>📋 見る：</strong> 保存した過去のメモを振り返る一覧画面へ移動します。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "menu",
    title: "📋 メニュー（≡）の使い方",
    content: (
      <div className="space-y-1.5 text-xs">
        <p>画面左上の「≡」ボタンから、各種画面やサポート機能へ移動できます。</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>✏️ メモを書く / 📋 メモを見る：</strong> 入力画面と一覧画面を切り替えます。</li>
          <li><strong>🏷️ カテゴリ管理：</strong> カテゴリの追加、並び順の変更、不要なカテゴリの整理ができます。</li>
          <li><strong>🗑️ ゴミ箱：</strong> 一覧から退避したメモの確認や復元ができます。</li>
          <li><strong>📢 運営からのお知らせ：</strong> アップデート情報や大切なお知らせを確認できます（新着時はバッジでお知らせ）。</li>
          <li><strong>❓ ガイド・ヘルプ / 📜 利用規約・プライバシー：</strong> 使い方やルールをいつでも確認できます。</li>
          <li><strong>⚙️ 設定：</strong> 見た目・フォント・操作感やクラウド同期の設定を行えます。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "search",
    title: "🔍 検索・絞り込みとお気に入り（☆/★）",
    content: (
      <div className="space-y-2">
        <p>メモ一覧の「🔍 検索機能」ボタンから、見返したいメモを素早く探せます。</p>
        <ul className="list-disc pl-5 space-y-1.5 text-xs">
          <li><strong>🔤 キーワード検索：</strong> タイトル、本文、追記に含まれる言葉で一発検索できます（※ロック中の鍵付きメモは検索対象になりません）。</li>
          <li><strong>☆/★ お気に入りのみ：</strong> メモカード右上にある星マーク（☆/★）で登録した大切なお気に入りを絞り込みます。</li>
          <li><strong>🗑️ ゴミ箱も含める：</strong> ONにすると、ゴミ箱内のメモも一緒に探して元の場所へ戻せます。</li>
          <li><strong>🏷️ カテゴリからさがす：</strong> 指定したカテゴリや「”未分類”」に絞って探せます（複数選んでのAND検索に対応）。</li>
          <li><strong>⏰ 時間帯から探す：</strong> 朝、昼、夕方、夜、深夜など、書いた時間帯で絞り込めます（複数選択可）。</li>
          <li><strong>📅 日付・カレンダーから探す：</strong> カレンダーで日付を選んで、その日に書いたメモをすぐに見返せます。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "reply",
    title: "💬 メモへの追記",
    content: (
      <div className="space-y-1.5 text-xs">
        <p>
          メモカード右上の「…」メニューから「💬 追記する」を選ぶと、過去のメモの下にタイムスタンプ付きで思考の続きを書き足せます。
        </p>
        <p>
          追記は普段折りたたまれており、タップして開いたり閉じたりできます。追記の文字数上限は10,000文字です。
        </p>
      </div>
    ),
  },
  {
    id: "edit_metadata",
    title: "✏️ 本文の訂正・タイトルやカテゴリの変更",
    content: (
      <div className="space-y-2 text-xs">
        <p>
          メモカード右上の「…」メニューから「🏷️ タイトル・カテゴリの変更」を選ぶと、タイトルとカテゴリを後から変更できます。タイトルの文字数上限は100文字です。
        </p>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-0.5">本文の訂正について：</strong>
          <p>
            ライトNoteでは、過去の思考をありのまま残す設計のため、本文を直接消して完全削除や上書きすることはできませんが、「<strong>✏️ 本文を訂正する</strong>」から過去の文を履歴として残したまま内容を訂正できます。続きを書き足したい時は「💬 追記する」のご利用がおすすめです。本文の文字数上限は10,000文字です。
          </p>
        </div>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-0.5">変更途中で閉じる場合：</strong>
          <p>
            訂正や変更の途中で保存せずキャンセルしようとした場合、変更があれば「破棄しますか？」と確認画面が出ます（設定からON/OFF可能）。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "reminder",
    title: "🔔 見返す日（リマインダー）",
    content: (
      <div className="space-y-1.5 text-xs">
        <p>
          新規作成時の入力欄下部や、保存済みメモの「…」メニューから「🔔 見返す日」を設定できます。
        </p>
        <p>
          見返す日が近づいたメモは「メモを見る」画面上部の「🔔」ボタンから一覧で確認でき、見終わったら「✓ 確認済み」や日付の変更ができます。
        </p>
      </div>
    ),
  },
  {
    id: "locked_notes",
    title: "🔒 鍵付きメモ（パスワード保護）",
    content: (
      <div className="space-y-2 text-xs">
        <p>
          書いたメモに鍵をかけると、普段は文字数・改行どおりに「・」で伏せ字表示され、専用の鍵パスワード（4〜64文字）を入力した時だけ読めるようになります。
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>かけ方・外し方：</strong> 新規入力欄下部の「🔒 鍵をつける」ボタン、または保存済みメモ右上の「…」メニューから「🔒 鍵をかける / 🔓 鍵を外す」で切り替えられます。</li>
          <li><strong>閲覧とロック戻し：</strong> 一度鍵パスワードで開けると、他の鍵付きメモも再入力なしで開けます。カード内の「隠す」や検索横の「🔒 すべて隠す」でいつでもロック状態に戻せます。</li>
          <li><strong>ロック中の制限：</strong> 本文は伏せ字になり、キーワード検索の対象外（タグや日時・お気に入り等では検索可）、追記・訂正・コピー・通知文表示も行えません。ゴミ箱へ移動しても鍵はかかったまま保護されます。</li>
          <li><strong>詳細設定：</strong> 「⚙️ 設定」の「🔐 鍵付きメモ設定」で、ロック中のタイトル表示（隠す／表示する）、自動で隠すタイミング（手動・5分・15分・別画面切替時）、パスワード変更・再設定を行えます。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "trash",
    title: "🗑️ ゴミ箱",
    content: (
      <div className="space-y-2">
        <div>
          <strong className="block mb-0.5">ゴミ箱への移動手順：</strong>
          <p>
            メモカード右上の「…」メニューを開き、「🗑️ ゴミ箱へ移動」を選ぶとゴミ箱へ移動します。
          </p>
        </div>
        <div className="pt-1.5 border-t" style={{ borderColor: "rgba(128, 128, 128, 0.22)" }}>
          <strong className="block mb-0.5">データの保持と復元：</strong>
          <p>
            ゴミ箱に入れたメモは一覧からは見えなくなりますが、<strong>データが消えるわけではありません</strong>。
          </p>
          <p className="mt-1">
            左メニューの「ゴミ箱」画面から「↩️ 元に戻す」を押せば、いつでも元の場所に戻せます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "settings",
    title: "⚙️ 設定（デザイン・鍵・アカウント同期）",
    content: (
      <div className="space-y-2 text-xs">
        <p>左メニューの「⚙️ 設定」から、見た目や使い心地、セキュリティを自分好みにカスタマイズできます。</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>🎨 テーマカラー・明るさ：</strong> クリーム系などのライトモード・目に優しいダークモードやアクセントカラーを変更できます。</li>
          <li><strong>📏 文字・ボタンの大きさ：</strong> 「標準」「大きめ」から読みやすい・押しやすいサイズを選べます。</li>
          <li><strong>📄 長文メモの折りたたみ：</strong> 一覧やゴミ箱で長いメモを折りたたむ行数（なし / 5行 / 8行 / 12行）を設定できます。</li>
          <li><strong>✒️ 文字フォント・メモ専用フォント：</strong> アプリ全体の書体と、メモ本文の書体（ゴシック・手書き風・明朝など）を別々に変更できます。</li>
          <li><strong>🔔 保存時通知・編集破棄の確認：</strong> 保存時のトースト表示や、変更途中で閉じる際の確認ダイアログをON/OFFできます。</li>
          <li><strong>⏰ 時間帯の設定：</strong> 朝・昼・夕方・夜・深夜といった時間帯の区切り時刻を、自分の生活リズムに合わせて自由に調整できます。</li>
          <li><strong>🔐 鍵付きメモ設定：</strong> 鍵メモ専用パスワードの設定・変更・再設定や、ロック中のタイトル表示、自動で隠すタイミングを設定できます。</li>
          <li><strong>👤 アカウント・クラウド同期：</strong> ユーザー名（ID・半角英数字30文字まで）とパスワード（6〜64文字）だけでスマホやPC間のメモ・設定を自動同期できます（復旧キーの確認も可能です）。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "faq",
    title: "❓ よくある質問（FAQ）",
    content: (
      <div className="space-y-3">
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. カテゴリが決まりません</p>
          <p className="mt-1 text-xs opacity-85">A. 「”未分類”」のまま保存してください。後からいつでも変更できます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. ゴミ箱に入れたメモは消えてしまいますか？</p>
          <p className="mt-1 text-xs opacity-85">A. 勝手に消えることはありません。ゴミ箱の中にもデータは安全に残っており、いつでも「↩️ 元に戻す」で一覧へ戻せます（本アプリにはメモを1件ずつ完全に削除する機能はありません）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. 保存容量の上限はありますか？</p>
          <p className="mt-1 text-xs opacity-85">A. 1件あたりタイトル100文字・本文（および追記・訂正）各10,000文字の上限があります。現在、合計件数による自動消去はなく、入力したメモが勝手に消えることはありません（将来の運用ルール変更については利用規約第4条をご確認ください）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. オフラインや電波が悪い場所でもメモを書けますか？</p>
          <p className="mt-1 text-xs opacity-85">A. はい、書けます。書いたメモはまずお使いの端末内に安全に保存されるため、電波が不安定な場所でもメモが消える心配はありません。通信が回復するとクラウドへの同期を行えます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. なぜアプリを開いた瞬間に入力画面が出るのですか？</p>
          <p className="mt-1 text-xs opacity-85">A. アイデアを忘れてしまわないよう、アプリを開いてから書き留めるまでの操作を最小限にするためです。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. ボタンが小さくて押しにくいです。</p>
          <p className="mt-1 text-xs opacity-85">A. 左メニューの「⚙️ 設定」＞「文字・ボタンの大きさ」から「大きめ」に変更できます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. 文字が小さくて読みにくいです。</p>
          <p className="mt-1 text-xs opacity-85">A. 左メニューの「⚙️ 設定」＞「文字・ボタンの大きさ」から「大きめ」に変更できます。フォントの種類も好みに合わせて切り替えられます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. ダークモードはありますか？</p>
          <p className="mt-1 text-xs opacity-85">A. はい、あります。左メニューの「⚙️ 設定」＞テーマカラー・明るさから、目に優しいダークモードへ切り替えられます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. カテゴリが増えすぎてしまったので整理したいです。</p>
          <p className="mt-1 text-xs opacity-85">A. 左メニューの「🏷️ カテゴリ管理」から、既存カテゴリの名前変更や不要なカテゴリの整理ができます（カテゴリを消去しても、メモ本文自体は消えません）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. 鍵をかけたメモの解除パスワードを忘れてしまいました。</p>
          <p className="mt-1 text-xs opacity-85">A. ログイン中は、ロック解除画面や「⚙️ 設定」＞「🔐 鍵付きメモ設定」の「鍵パスワードを忘れた場合」から、アカウントのパスワードを使って再設定できます（※未ログイン時は安全上リセットできません）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. アカウントのパスワードを忘れてしまいました。</p>
          <p className="mt-1 text-xs opacity-85">A. アカウント作成時に発行された「復旧キー」を使って、ログイン画面の「パスワードを忘れた場合」から新しいパスワードを再設定できます。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. メモが見つかりません。</p>
          <p className="mt-1 text-xs opacity-85">A. 保存せずにアプリを閉じてしまった可能性があります。保存していないメモを復旧させることはできません。保存ボタンを忘れずに押してください（※検索条件が残っていたり、ゴミ箱に入っている場合もあるため、検索機能もあわせてご確認ください）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. このアプリは使い続けられますか？</p>
          <p className="mt-1 text-xs opacity-85">A. 現状しばらくは使い続けられると思います。しかし、運営側の都合でサービス終了する可能性もあります。その際は1ヶ月前から告知を行う予定です。ご了承ください（詳しくは利用規約をご覧ください）。</p>
        </div>
        <div className="p-2.5 rounded-xl" style={{ backgroundColor: "rgba(128, 128, 128, 0.08)" }}>
          <p className="font-bold text-xs">Q. このアプリはAIを使用していますか？</p>
          <p className="mt-1 text-xs opacity-85">A. アプリのプログラム内には AI を使用していません。しかし、アプリ開発上で AI Agent を用いてプログラムコードを記述しております。各個人のアカウントデータはローカルまたは Supabase で管理しておりますので、内容が AI に読み込まれることはありません。</p>
        </div>
      </div>
    ),
  },
];

const COLLAPSE_LINE_CLASS: Record<Exclude<NoteCollapseLines, 0>, string> = {
  5: "line-clamp-5",
  8: "line-clamp-8",
  12: "line-clamp-12",
};

// 一覧・ゴミ箱共通の折りたたみ対応メモ本文表示
function CollapsibleNoteBody({
  text,
  maxLines,
  isExpanded,
  onToggle,
  className = "",
  style,
  accentColor,
  isMasked = false,
}: {
  text: string;
  maxLines: NoteCollapseLines;
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
  style?: React.CSSProperties;
  accentColor: string;
  isMasked?: boolean;
}) {
  const pRef = useRef<HTMLParagraphElement | null>(null);
  const [needsCollapse, setNeedsCollapse] = useState(false);

  const shouldClamp = maxLines > 0 && !isMasked && !isExpanded;

  useEffect(() => {
    if (maxLines === 0 || isMasked || isExpanded) return;

    const measure = () => {
      const el = pRef.current;
      if (!el) return;
      setNeedsCollapse(el.scrollHeight > el.clientHeight + 2);
    };

    const rafId = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", measure);
    };
  }, [text, maxLines, isExpanded, isMasked]);

  const clampClass = shouldClamp
    ? COLLAPSE_LINE_CLASS[maxLines as Exclude<NoteCollapseLines, 0>]
    : "";

  return (
    <div>
      <p ref={pRef} className={`${className} ${clampClass}`} style={style}>
        {text}
      </p>
      {maxLines > 0 && !isMasked && needsCollapse && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1.5 text-xs font-bold hover:opacity-75 transition-opacity inline-flex items-center gap-1"
          style={{ color: accentColor }}
        >
          {isExpanded ? "▲ 折りたたむ" : "▼ 続きを読む"}
        </button>
      )}
    </div>
  );
}

// 文字数カウンター＆上限到達時の控えめな警告表示
function LengthLimitHint({
  length,
  maxLength,
  warnThreshold,
  kind,
  theme,
}: {
  length: number;
  maxLength: number;
  warnThreshold: number;
  kind: "title" | "body";
  theme: ThemePalette;
}) {
  const isAtLimit = length >= maxLength;
  const shouldShowCounter =
    kind === "title" ? length >= warnThreshold : length > warnThreshold;

  if (!isAtLimit && !shouldShowCounter) return null;

  const warningColor = theme.isDark ? "#f0a868" : "#b45309";
  const warningText =
    kind === "title"
      ? `⚠️ タイトルの文字制限の上限（${maxLength.toLocaleString()}文字）に達しました。`
      : `⚠️ 一度のメモに記入できる文字制限の上限（${maxLength.toLocaleString()}文字）に達しました。`;

  return (
    <div className="mt-1 flex items-center justify-between gap-2 flex-wrap select-none">
      {isAtLimit ? (
        <span className="text-[11px] font-medium leading-snug" style={{ color: warningColor }}>
          {warningText}
        </span>
      ) : (
        <span />
      )}
      <span
        className="text-[10px] font-mono ml-auto"
        style={{ color: isAtLimit ? warningColor : theme.textSecondary }}
      >
        {length.toLocaleString()} / {maxLength.toLocaleString()}
      </span>
    </div>
  );
}

// 認証モーダル共通のユーザー名（ID）入力欄
function AuthUsernameField({
  value,
  onChange,
  placeholder,
  theme,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  theme: ThemePalette;
}) {
  const trimmed = value.trim();
  const isInvalid = trimmed.length > 0 && !/^[a-zA-Z0-9._-]+$/.test(trimmed);

  return (
    <div>
      <label
        className="flex items-baseline gap-2 text-xs font-bold mb-1 flex-wrap"
        style={{ color: theme.textPrimary }}
      >
        <span>ユーザー名（ID）</span>
        <span
          className="text-[10px] font-normal"
          style={{ color: theme.textSecondary }}
        >
          ※半角英数字のみ（{MAX_USERNAME_LENGTH}文字まで）
        </span>
      </label>
      <input
        type="text"
        placeholder={placeholder}
        maxLength={MAX_USERNAME_LENGTH}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        required
        className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none transition-colors"
        style={{
          backgroundColor: theme.bgSub,
          borderColor: theme.border,
          color: theme.textPrimary,
        }}
      />
      {isInvalid && (
        <span
          className="text-[10px] font-bold block mt-0.5"
          style={{ color: theme.isDark ? "#f5a398" : "#b85448" }}
        >
          ⚠️ ユーザー名は半角英数字（a-z, 0-9）と記号（._-）のみ使用できます
        </span>
      )}
    </div>
  );
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [activeTab, setActiveTab] = useState<TabType>("home");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [openHelpSection, setOpenHelpSection] = useState<string | null>(null);
  const [copiedContactEmail, setCopiedContactEmail] = useState(false);
  const [activeMenuNoteId, setActiveMenuNoteId] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("🌱 保存しました");
  const [enableToast, setEnableToast] = useState(true);
  const [fontSize, setFontSize] = useState<FontSize>("normal");
  const [buttonSize, setButtonSize] = useState<ButtonSize>("normal");
  const [fontFamily, setFontFamily] = useState<FontFamily>("sans");
  const [noteFont, setNoteFont] = useState<NoteFontFamily>("sans");

  // テーマ関連のState（標準クリーム、黒、10色×パステル／ダーク）
  const [selectedHue, setSelectedHue] = useState<ColorHue>("cream");
  const [themeBrightness, setThemeBrightness] = useState<ThemeBrightness>("pastel");
  const [isThemeAccordionOpen, setIsThemeAccordionOpen] = useState(false);

  // 利用規約・プライバシーモーダルのState
  const [isTermsOpen, setIsTermsOpen] = useState(false);

  // 現在適用中のテーマパレット（全22色）
  const activeTheme = useMemo(
    () => getThemePalette(selectedHue, themeBrightness),
    [selectedHue, themeBrightness]
  );

  // ガイド・ヘルプ末尾のお問い合わせメールアドレスをコピー
  const handleCopyContactEmail = async () => {
    const email = "app746.tahry@gmail.com";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(email);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = email;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedContactEmail(true);
      setTimeout(() => setCopiedContactEmail(false), 2000);
    } catch (e) {
      console.error("メールアドレスのコピーに失敗しました", e);
    }
  };

  // テーマ変更時にPWAのステータスバー・ナビバー色（meta theme-color）とbody背景色をリアルタイム連動
  useEffect(() => {
    if (typeof document === "undefined") return;
    const colorToSet = activeTheme.bgApp;
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", colorToSet);
    } else {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = colorToSet;
      document.head.appendChild(meta);
    }
    document.documentElement.style.backgroundColor = colorToSet;
    document.body.style.backgroundColor = colorToSet;
  }, [activeTheme.bgApp]);

  // カテゴリ関連のState
  const [categoriesList, setCategoriesList] = useState<CategoryItem[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isAddingCategoryInline, setIsAddingCategoryInline] = useState(false);
  const [inlineNewCategoryName, setInlineNewCategoryName] = useState("");
  const [newCategoryInput, setNewCategoryInput] = useState("");
  const [categoryToDelete, setCategoryToDelete] = useState<CategoryItem | null>(null);
  const [categoryToRename, setCategoryToRename] = useState<CategoryItem | null>(null);
  const [renameCategoryInput, setRenameCategoryInput] = useState("");
  const [renameCategoryError, setRenameCategoryError] = useState<string | null>(null);

  const activeCategories = useMemo(
    () => categoriesList.filter((c) => !c.deleted),
    [categoriesList]
  );
  const categoryNameById = useMemo(
    () => new Map(categoriesList.map((c) => [c.id, c.name])),
    [categoriesList]
  );
  const getCategoryName = (idOrName: string): string =>
    categoryNameById.get(idOrName) ?? idOrName;

  // メモのタイトル・カテゴリ変更モーダル関連のState
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [editTitleInput, setEditTitleInput] = useState("");
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [isAddingCategoryInEdit, setIsAddingCategoryInEdit] = useState(false);
  const [inlineNewCategoryInEdit, setInlineNewCategoryInEdit] = useState("");
  const [showDiscardConfirmModal, setShowDiscardConfirmModal] = useState(false);
  const [confirmDiscardOnEdit, setConfirmDiscardOnEdit] = useState(true);

  // メモの本文訂正モーダル関連のState（思考の不可逆性を保ちつつ本文を訂正）
  const [editingContentNote, setEditingContentNote] = useState<Note | null>(null);
  const [editContentInput, setEditContentInput] = useState("");
  const [expandedHistoryNoteIds, setExpandedHistoryNoteIds] = useState<string[]>([]);
  const [expandedBodyNoteIds, setExpandedBodyNoteIds] = useState<string[]>([]);
  const [noteCollapseLines, setNoteCollapseLines] = useState<NoteCollapseLines>(8);

  // 検索・絞り込みパネルとお気に入りのState
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [filterOnlyFavorite, setFilterOnlyFavorite] = useState(false);
  const [filterOnlyLocked, setFilterOnlyLocked] = useState(false);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [includeTrashInSearch, setIncludeTrashInSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTimeSlots, setFilterTimeSlots] = useState<TimeSlotKey[]>([]);
  const [filterDate, setFilterDate] = useState<string>(""); // カレンダー日付検索 (YYYY-MM-DD)
  const [calendarYear, setCalendarYear] = useState<number>(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState<number>(() => new Date().getMonth() + 1);
  const [categorySortOrder, setCategorySortOrder] = useState<CategorySortOrder>("usage");

  // 検索パネル内の折りたたみアコーディオンState
  const [isSearchCategoryOpen, setIsSearchCategoryOpen] = useState(true);
  const [isSearchTimeSlotOpen, setIsSearchTimeSlotOpen] = useState(false);
  const [isSearchDateOpen, setIsSearchDateOpen] = useState(false);

  // ゴミ箱検索パネル内の折りたたみアコーディオンState
  const [isTrashSearchCategoryOpen, setIsTrashSearchCategoryOpen] = useState(true);

  // 時間帯の定義（朝・昼・夕方・夜・深夜）
  const [timeSlots, setTimeSlots] = useState<Record<TimeSlotKey, TimeSlotConfig>>(DEFAULT_TIME_SLOTS);
  const [selectedSlotForEdit, setSelectedSlotForEdit] = useState<TimeSlotKey>("morning");
  const [isTimeSlotsAccordionOpen, setIsTimeSlotsAccordionOpen] = useState(false);

  // ゴミ箱専用の検索・絞り込みState
  const [isTrashSearchPanelOpen, setIsTrashSearchPanelOpen] = useState(false);
  const [trashFilterOnlyFavorite, setTrashFilterOnlyFavorite] = useState(false);
  const [trashFilterCategories, setTrashFilterCategories] = useState<string[]>([]);
  const [trashSearchQuery, setTrashSearchQuery] = useState("");

  // 追記（リプライ）機能のState（デフォルトは折りたたみ）
  const [replyingNoteId, setReplyingNoteId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [expandedReplyNoteIds, setExpandedReplyNoteIds] = useState<string[]>([]);

  // 認証・クラウド同期関連のState
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string>("");
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup" | "reset">("login");
  const [authUsernameInput, setAuthUsernameInput] = useState("");
  const [authPasswordInput, setAuthPasswordInput] = useState("");
  const [authPasswordConfirmInput, setAuthPasswordConfirmInput] = useState("");
  const [resetRecoveryKeyInput, setResetRecoveryKeyInput] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string>("");
  const [showRecoveryKeyInSettings, setShowRecoveryKeyInSettings] = useState(false);
  const [newlyRegisteredKey, setNewlyRegisteredKey] = useState<string | null>(null);
  const [copiedBothToast, setCopiedBothToast] = useState(false);
  const [copiedKeyToast, setCopiedKeyToast] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccessMsg, setAuthSuccessMsg] = useState<string | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");

  // アカウント削除確認モーダルのState
  const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
  const [deleteAccountStep, setDeleteAccountStep] = useState<"auth" | "confirm">("auth");
  const [deleteUsernameInput, setDeleteUsernameInput] = useState("");
  const [deletePasswordInput, setDeletePasswordInput] = useState("");
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteLocalDataToo, setDeleteLocalDataToo] = useState(true);
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // 運営からのお知らせのState
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [isAnnouncementsOpen, setIsAnnouncementsOpen] = useState(false);
  const [isLoadingAnnouncements, setIsLoadingAnnouncements] = useState(false);
  const [announcementsFetchError, setAnnouncementsFetchError] = useState(false);
  const [readAnnouncementIds, setReadAnnouncementIds] = useState<string[]>([]);
  const [newlyOpenedAnnouncementIds, setNewlyOpenedAnnouncementIds] = useState<string[]>([]);

  // リマインダー機能（見返す日）のState
  const [newNoteRemindAt, setNewNoteRemindAt] = useState("");
  const [isReminderPanelOpen, setIsReminderPanelOpen] = useState(false);
  const [reminderTargetNote, setReminderTargetNote] = useState<Note | null>(null);
  const [reminderDateInput, setReminderDateInput] = useState("");

  // 鍵付きメモ機能のState
  const [lockPasswordHash, setLockPasswordHash] = useState("");
  const [maskLockedTitle, setMaskLockedTitle] = useState(true);
  const [autoLockMode, setAutoLockMode] = useState<AutoLockMode>("manual");
  const [newNoteIsLocked, setNewNoteIsLocked] = useState(false);
  const [unlockedNoteIds, setUnlockedNoteIds] = useState<string[]>([]);
  const [isLockSessionVerified, setIsLockSessionVerified] = useState(false);
  const [lockModalMode, setLockModalMode] = useState<null | "unlock" | "setup" | "change" | "forgot">(null);
  const [pendingUnlockNoteId, setPendingUnlockNoteId] = useState<string | null>(null);
  const [pendingLockAction, setPendingLockAction] = useState<
    | null
    | { type: "toggleComposeLock" }
    | { type: "lockExistingNote"; noteId: string }
    | { type: "removeNoteLock"; noteId: string }
  >(null);
  const [lockInput1, setLockInput1] = useState("");
  const [lockInput2, setLockInput2] = useState("");
  const [lockInput3, setLockInput3] = useState("");
  const [showLockInput1, setShowLockInput1] = useState(false);
  const [showLockInput2, setShowLockInput2] = useState(false);
  const [showLockInput3, setShowLockInput3] = useState(false);
  const [lockModalError, setLockModalError] = useState<string | null>(null);
  const [isLockModalBusy, setIsLockModalBusy] = useState(false);

  // メモ入力テキストエリアの参照（チュートリアル時のフォーカス制御用）
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  // インタラクティブ・ウォークスルーチュートリアルのState
  const [tutorialStep, setTutorialStep] = useState<number | null>(null); // null: 非表示, 1〜8: ステップ番号
  const [tutorialTargetRect, setTutorialTargetRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [isTutorialPromptDismissed, setIsTutorialPromptDismissed] = useState(false);

  // チュートリアルStep 1（開始直後）やStep 3（タグ・タイトル・保存の全体確認）では自動でキーボードを閉じる
  useEffect(() => {
    if (tutorialStep === 1 || tutorialStep === 3 || (tutorialStep !== null && tutorialStep >= 4)) {
      noteTextareaRef.current?.blur();
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }, [tutorialStep]);

  const [isLoaded, setIsLoaded] = useState(false);

  // 初回読み込み時にブラウザの保存領域 (localStorage) からデータを復元
  useEffect(() => {
    try {
      const savedNotes = localStorage.getItem("seednote_items");
      const parsedNotes: Note[] = savedNotes ? JSON.parse(savedNotes) : [];
      const savedCategories = localStorage.getItem("seednote_categories");
      const parsedCats: CategoryItem[] = savedCategories
        ? parseCategoryItems(JSON.parse(savedCategories))
        : [];
      const {
        migratedNotes,
        updatedCatalog,
        changedNoteIds,
        catalogChanged,
      } = migrateNotesCategories(parsedNotes, parsedCats);

      if (savedNotes) {
        setNotes(migratedNotes);
        if (changedNoteIds.length > 0) {
          localStorage.setItem("seednote_items", JSON.stringify(migratedNotes));
        }
      }
      if (savedCategories || catalogChanged) {
        setCategoriesList(updatedCatalog);
        if (catalogChanged || (savedCategories && JSON.stringify(serializeCategoryItems(updatedCatalog)) !== savedCategories)) {
          localStorage.setItem(
            "seednote_categories",
            JSON.stringify(serializeCategoryItems(updatedCatalog))
          );
        }
      }
      const savedToastPref = localStorage.getItem("seednote_enable_toast");
      if (savedToastPref !== null) {
        setEnableToast(savedToastPref === "true");
      }
      const savedFontSize = localStorage.getItem("seednote_font_size");
      if (savedFontSize === "large" || savedFontSize === "normal") {
        setFontSize(savedFontSize as FontSize);
      }
      const savedButtonSize = localStorage.getItem("seednote_button_size");
      if (savedButtonSize === "large" || savedButtonSize === "normal") {
        setButtonSize(savedButtonSize as ButtonSize);
      }
      const savedConfirmDiscard = localStorage.getItem("seednote_confirm_discard");
      if (savedConfirmDiscard !== null) {
        setConfirmDiscardOnEdit(savedConfirmDiscard === "true");
      }
      const savedTimeSlots = localStorage.getItem("seednote_time_slots");
      if (savedTimeSlots) {
        const parsed = JSON.parse(savedTimeSlots);
        const merged: Record<TimeSlotKey, TimeSlotConfig> = { ...DEFAULT_TIME_SLOTS };
        (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).forEach((key) => {
          if (parsed[key]) {
            merged[key] = {
              ...DEFAULT_TIME_SLOTS[key],
              ...parsed[key],
              color: parsed[key].color || DEFAULT_TIME_SLOTS[key].color,
            };
          }
        });
        setTimeSlots(merged);
      }
      const savedSortOrder = localStorage.getItem("seednote_category_sort_order");
      if (savedSortOrder === "usage" || savedSortOrder === "alphabetical" || savedSortOrder === "created") {
        setCategorySortOrder(savedSortOrder as CategorySortOrder);
      }
      const savedRecoveryKey = localStorage.getItem("seednote_recovery_key");
      if (savedRecoveryKey) {
        setRecoveryKey(savedRecoveryKey);
      }
      const savedHue = localStorage.getItem("seednote_theme_hue") as ColorHue | null;
      if (savedHue) {
        setSelectedHue(savedHue);
      }
      const savedBrightness = localStorage.getItem("seednote_theme_brightness") as ThemeBrightness | null;
      if (savedBrightness === "pastel" || savedBrightness === "dark") {
        setThemeBrightness(savedBrightness);
      }
      const savedFontFamily = localStorage.getItem("seednote_font_family") as FontFamily | null;
      if (savedFontFamily === "sans" || savedFontFamily === "serif" || savedFontFamily === "rounded") {
        setFontFamily(savedFontFamily);
      }
      const savedNoteFont = localStorage.getItem("seednote_note_font") as NoteFontFamily | null;
      if (savedNoteFont && ["sans", "klee", "yomogi", "mincho", "mono"].includes(savedNoteFont)) {
        setNoteFont(savedNoteFont);
      }
      const savedCollapseLines = localStorage.getItem("seednote_note_collapse_lines");
      if (savedCollapseLines !== null) {
        const parsedCollapse = Number(savedCollapseLines);
        if (parsedCollapse === 0 || parsedCollapse === 5 || parsedCollapse === 8 || parsedCollapse === 12) {
          setNoteCollapseLines(parsedCollapse);
        }
      }
      const savedReadAnnouncementIds = localStorage.getItem("seednote_read_announcement_ids");
      if (savedReadAnnouncementIds) {
        const parsedIds = JSON.parse(savedReadAnnouncementIds);
        if (Array.isArray(parsedIds)) {
          setReadAnnouncementIds(parsedIds.filter((id): id is string => typeof id === "string"));
        }
      }
      const savedLockHash = localStorage.getItem("seednote_lock_password_hash");
      if (savedLockHash) {
        setLockPasswordHash(savedLockHash);
      }
      const savedMaskTitle = localStorage.getItem("seednote_mask_locked_title");
      if (savedMaskTitle === "true" || savedMaskTitle === "false") {
        setMaskLockedTitle(savedMaskTitle === "true");
      }
      const savedAutoLock = localStorage.getItem("seednote_auto_lock_mode") as AutoLockMode | null;
      if (savedAutoLock && ["manual", "5m", "15m", "background"].includes(savedAutoLock)) {
        setAutoLockMode(savedAutoLock);
      }
    } catch (e) {
      console.error("データの読み込みに失敗しました", e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // 解除中の鍵付きメモをすべてロック状態へ戻す
  const lockAllNotes = useCallback((showNotice: boolean = false) => {
    setUnlockedNoteIds([]);
    setIsLockSessionVerified(false);
    setLockModalMode((prev) => (prev === "unlock" ? null : prev));
    setPendingUnlockNoteId(null);
    if (showNotice) {
      setToastMessage("🔒 鍵付きメモを非表示にしました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 1800);
    }
  }, []);

  // 設定されたタイミングでの自動ロック監視
  useEffect(() => {
    const hasOpenSecret = unlockedNoteIds.length > 0 || isLockSessionVerified;
    if (!hasOpenSecret || autoLockMode === "manual") return;

    if (autoLockMode === "background") {
      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          lockAllNotes(false);
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }

    const durationMs = autoLockMode === "5m" ? 5 * 60 * 1000 : 15 * 60 * 1000;
    let timerId = setTimeout(() => lockAllNotes(true), durationMs);

    const resetTimer = () => {
      clearTimeout(timerId);
      timerId = setTimeout(() => lockAllNotes(true), durationMs);
    };

    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "scroll", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, resetTimer, { passive: true }));

    return () => {
      clearTimeout(timerId);
      events.forEach((ev) => window.removeEventListener(ev, resetTimer));
    };
  }, [autoLockMode, unlockedNoteIds.length, isLockSessionVerified, lockAllNotes]);

  // 運営からのお知らせを取得（Supabase announcements テーブル）
  const fetchAnnouncements = useCallback(async () => {
    setIsLoadingAnnouncements(true);
    setAnnouncementsFetchError(false);
    try {
      const { data, error } = await supabase
        .from("announcements")
        .select("id, title, content, category, published_at")
        .eq("is_published", true)
        .order("published_at", { ascending: false })
        .limit(30);

      if (error) {
        console.warn("お知らせの取得に失敗しました:", error.message);
        setAnnouncementsFetchError(true);
        return;
      }
      if (Array.isArray(data)) {
        setAnnouncements(data as AnnouncementItem[]);
      }
    } catch (e) {
      console.warn("お知らせ取得中にエラーが発生しました:", e);
      setAnnouncementsFetchError(true);
    } finally {
      setIsLoadingAnnouncements(false);
    }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
  }, [fetchAnnouncements]);

  const unreadAnnouncementsCount = useMemo(() => {
    if (!isLoaded) return 0;
    return announcements.filter((a) => !readAnnouncementIds.includes(a.id)).length;
  }, [announcements, readAnnouncementIds, isLoaded]);

  const markAllAnnouncementsRead = useCallback(
    (items: AnnouncementItem[]) => {
      if (items.length === 0) return;
      setReadAnnouncementIds((prev) => {
        const merged = Array.from(new Set([...prev, ...items.map((item) => item.id)]));
        try {
          localStorage.setItem("seednote_read_announcement_ids", JSON.stringify(merged));
        } catch (e) {
          console.warn("お知らせ既読情報の保存に失敗しました:", e);
        }
        return merged;
      });
    },
    []
  );

  const handleOpenAnnouncements = useCallback(() => {
    const unreadIds = announcements
      .filter((a) => !readAnnouncementIds.includes(a.id))
      .map((a) => a.id);
    setNewlyOpenedAnnouncementIds(unreadIds);
    markAllAnnouncementsRead(announcements);
    setIsAnnouncementsOpen(true);
    setIsMenuOpen(false);
  }, [announcements, readAnnouncementIds, markAllAnnouncementsRead]);

  // チュートリアルのターゲット要素位置計算（スポットライト用）
  const updateTutorialTargetRect = useCallback(() => {
    if (tutorialStep === null || tutorialStep === 1 || tutorialStep === 8) {
      setTutorialTargetRect(null);
      return;
    }

    let targetId = "";
    if (tutorialStep === 2 || tutorialStep === 3) {
      targetId = "tutorial-target-input";
    } else if (tutorialStep === 4) {
      targetId = "tutorial-target-switch";
    } else if (tutorialStep === 5) {
      targetId = isSearchPanelOpen ? "tutorial-target-search-panel" : "tutorial-target-search-btn";
    } else if (tutorialStep === 6) {
      targetId = "tutorial-target-irreversible";
    } else if (tutorialStep === 7) {
      targetId = isMenuOpen ? "tutorial-target-menu-aside" : "tutorial-target-menu";
    }

    if (!targetId) {
      setTutorialTargetRect(null);
      return;
    }

    const el = document.getElementById(targetId);
    if (el) {
      const rect = el.getBoundingClientRect();
      setTutorialTargetRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
      if (targetId !== "tutorial-target-menu-aside") {
        if (tutorialStep === 2 || tutorialStep === 3) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    } else {
      setTutorialTargetRect(null);
    }
  }, [tutorialStep, isSearchPanelOpen, isMenuOpen, content, title]);

  // 対象要素のリサイズ検知とスクロール連動
  useEffect(() => {
    updateTutorialTargetRect();
    const handleResize = () => updateTutorialTargetRect();
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleResize, true);

    // アコーディオン開閉や文字入力によるターゲット要素のサイズ変化を監視
    let resizeObserver: ResizeObserver | null = null;
    let targetId = "";
    if (tutorialStep === 2 || tutorialStep === 3) targetId = "tutorial-target-input";
    else if (tutorialStep === 4) targetId = "tutorial-target-switch";
    else if (tutorialStep === 5) targetId = isSearchPanelOpen ? "tutorial-target-search-panel" : "tutorial-target-search-btn";
    else if (tutorialStep === 6) targetId = "tutorial-target-irreversible";
    else if (tutorialStep === 7) targetId = isMenuOpen ? "tutorial-target-menu-aside" : "tutorial-target-menu";

    if (targetId) {
      const el = document.getElementById(targetId);
      if (el && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          updateTutorialTargetRect();
        });
        resizeObserver.observe(el);
      }
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize, true);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [updateTutorialTargetRect, tutorialStep, isSearchPanelOpen, isMenuOpen]);

  // チュートリアル中の画面外クリックガード（くり抜き枠とガイドカード以外の誤操作を防止）
  useEffect(() => {
    if (tutorialStep === null) return;
    const handleTutorialClickCapture = (e: MouseEvent) => {
      const guideCard = document.getElementById("tutorial-guide-card");
      if (guideCard && guideCard.contains(e.target as Node)) {
        return;
      }
      let targetId = "";
      if (tutorialStep === 2 || tutorialStep === 3) targetId = "tutorial-target-input";
      else if (tutorialStep === 4) targetId = "tutorial-target-switch";
      else if (tutorialStep === 5) targetId = isSearchPanelOpen ? "tutorial-target-search-panel" : "tutorial-target-search-btn";
      else if (tutorialStep === 6) targetId = "tutorial-target-irreversible";
      else if (tutorialStep === 7) targetId = isMenuOpen ? "tutorial-target-menu-aside" : "tutorial-target-menu";

      const targetEl = targetId ? document.getElementById(targetId) : null;
      if (targetEl && targetEl.contains(e.target as Node)) {
        return;
      }

      // 対象要素外のクリックは遮断
      e.stopPropagation();
      e.preventDefault();
    };

    window.addEventListener("click", handleTutorialClickCapture, true);
    return () => window.removeEventListener("click", handleTutorialClickCapture, true);
  }, [tutorialStep, isSearchPanelOpen, isMenuOpen]);

  // ガイドカードの最適な配置スタイル（PCでは横の余白、スマホでは上下）
  const getGuideCardStyle = (): React.CSSProperties => {
    if (tutorialStep === 1 || tutorialStep === 8) {
      return {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        maxWidth: "420px",
        width: "92%",
        zIndex: 50,
      };
    }

    if (!tutorialTargetRect || typeof window === "undefined") {
      return {
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "380px",
        width: "92%",
        zIndex: 50,
      };
    }

    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const cardWidth = 360;

    // Step 7でメニューが開いている場合：PC/タブレットは右横、スマホはメニュー上部と被らないよう下側に配置
    if (tutorialStep === 7 && isMenuOpen) {
      if (windowWidth >= 700) {
        return {
          position: "fixed",
          top: "80px",
          left: "276px",
          maxWidth: "380px",
          width: "92%",
          zIndex: 50,
        };
      }
      return {
        position: "fixed",
        bottom: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "380px",
        width: "92%",
        zIndex: 50,
      };
    }

    // PC画面（横幅860px以上）で、左右にガイドカードを置く十分な余白がある場合
    const rightSpace = windowWidth - (tutorialTargetRect.left + tutorialTargetRect.width);
    const leftSpace = tutorialTargetRect.left;

    if (windowWidth >= 860 && rightSpace >= cardWidth + 24) {
      // 右側の空きスペースにスマート配置（中央の要素と絶対に被らない）
      const topPos = Math.min(
        Math.max(20, tutorialTargetRect.top),
        Math.max(20, windowHeight - 340)
      );
      return {
        position: "fixed",
        top: `${topPos}px`,
        left: `${tutorialTargetRect.left + tutorialTargetRect.width + 20}px`,
        width: `${cardWidth}px`,
        zIndex: 50,
      };
    } else if (windowWidth >= 860 && leftSpace >= cardWidth + 24) {
      // 左側の空きスペースに配置
      const topPos = Math.min(
        Math.max(20, tutorialTargetRect.top),
        Math.max(20, windowHeight - 340)
      );
      return {
        position: "fixed",
        top: `${topPos}px`,
        left: `${tutorialTargetRect.left - cardWidth - 20}px`,
        width: `${cardWidth}px`,
        zIndex: 50,
      };
    }

    // スマホや余白が少ない画面：上下の空きスペースを計算して被りを完全防止
    const topSpace = tutorialTargetRect.top;
    const bottomSpace = windowHeight - (tutorialTargetRect.top + tutorialTargetRect.height);

    // 下側にカードが入るスペースがある場合、または下側の方が広い場合は絶対に下（bottom）に配置！
    if (bottomSpace >= 190 || bottomSpace >= topSpace) {
      return {
        position: "fixed",
        bottom: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "380px",
        width: "92%",
        zIndex: 50,
      };
    } else {
      return {
        position: "fixed",
        top: "60px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "380px",
        width: "92%",
        zIndex: 50,
      };
    }
  };

  // チュートリアル操作ハンドラ
  const handleStartTutorial = () => {
    noteTextareaRef.current?.blur();
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setActiveMenuNoteId(null);
    setActiveTab("home");
    setTutorialStep(1);
    setIsMenuOpen(false);
    setIsHelpOpen(false);
  };

  const handleNextTutorialStep = () => {
    if (tutorialStep === null) return;
    if (tutorialStep >= 8) {
      handleCloseTutorial();
      return;
    }
    setActiveMenuNoteId(null);
    const nextStep = tutorialStep + 1;
    if (nextStep === 4) {
      setActiveTab("home");
      setIsMenuOpen(false);
    } else if (nextStep === 5 || nextStep === 6) {
      setActiveTab("list");
      setIsMenuOpen(false);
    } else if (nextStep === 7) {
      setIsMenuOpen(false); // 閉じた状態からスタート！ユーザー自身に≡を押してもらう
    } else if (nextStep === 8) {
      setIsMenuOpen(false);
    }
    setTutorialStep(nextStep);
  };

  const handlePrevTutorialStep = () => {
    if (tutorialStep === null || tutorialStep <= 1) return;
    setActiveMenuNoteId(null);
    const prevStep = tutorialStep - 1;
    if (prevStep <= 4) {
      setActiveTab("home");
      setIsMenuOpen(false);
    } else if (prevStep === 5 || prevStep === 6) {
      setActiveTab("list");
      setIsMenuOpen(false);
    } else if (prevStep === 7) {
      setIsMenuOpen(false);
    } else {
      setIsMenuOpen(false);
    }
    setTutorialStep(prevStep);
  };

  const handleCloseTutorial = () => {
    setActiveMenuNoteId(null);
    setTutorialStep(null);
    setTutorialTargetRect(null);
    setIsMenuOpen(false);
  };

  // カテゴリの並び順変更
  const handleCategorySortOrderChange = (order: CategorySortOrder) => {
    setCategorySortOrder(order);
    localStorage.setItem("seednote_category_sort_order", order);
  };

  // カテゴリ一覧を指定された並び順でソート（よく使う順 / 五十音順 / 登録順）
  const sortedCategories = useMemo(() => {
    const list = [...activeCategories];
    if (categorySortOrder === "usage") {
      const counts = new Map<string, number>();
      notes.forEach((n) => {
        if (!n.isTrash && n.categories) {
          n.categories.forEach((c) => {
            counts.set(c, (counts.get(c) || 0) + 1);
          });
        }
      });
      return list.sort((a, b) => {
        const countA = counts.get(a.id) || 0;
        const countB = counts.get(b.id) || 0;
        if (countB !== countA) return countB - countA;
        return a.name.localeCompare(b.name, "ja");
      });
    } else if (categorySortOrder === "alphabetical") {
      return list.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    } else {
      return list;
    }
  }, [activeCategories, notes, categorySortOrder]);

  // メモが存在する日付と件数を集計（カレンダーでメモがある日を濃く表示するため）
  const noteDatesMap = useMemo(() => {
    const counts = new Map<string, number>();
    const targetNotes = includeTrashInSearch ? notes : notes.filter((n) => !n.isTrash);
    targetNotes.forEach((n) => {
      const d = new Date(n.createdAt).toLocaleDateString("sv-SE");
      counts.set(d, (counts.get(d) || 0) + 1);
    });
    return counts;
  }, [notes, includeTrashInSearch]);

  // カレンダーの前月・次月移動
  const handlePrevCalendarMonth = () => {
    if (calendarMonth === 1) {
      setCalendarYear((prev) => prev - 1);
      setCalendarMonth(12);
    } else {
      setCalendarMonth((prev) => prev - 1);
    }
  };

  const handleNextCalendarMonth = () => {
    if (calendarMonth === 12) {
      setCalendarYear((prev) => prev + 1);
      setCalendarMonth(1);
    } else {
      setCalendarMonth((prev) => prev + 1);
    }
  };

  // 設定の最新値を保持するRef（非同期・クロージャの古い値を参照しないため）
  const latestSettingsRef = useRef({
    categoriesList,
    timeSlots,
    fontSize,
    buttonSize,
    enableToast,
    confirmDiscardOnEdit,
    selectedHue,
    themeBrightness,
    fontFamily,
    noteFont,
    noteCollapseLines,
  });

  useEffect(() => {
    latestSettingsRef.current = {
      categoriesList,
      timeSlots,
      fontSize,
      buttonSize,
      enableToast,
      confirmDiscardOnEdit,
      selectedHue,
      themeBrightness,
      fontFamily,
      noteFont,
      noteCollapseLines,
    };
  }, [
    categoriesList,
    timeSlots,
    fontSize,
    buttonSize,
    enableToast,
    confirmDiscardOnEdit,
    selectedHue,
    themeBrightness,
    fontFamily,
    noteFont,
    noteCollapseLines,
  ]);

  // 設定のクラウド保存用デバウンスタイマー
  const cloudSettingsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 新規登録処理中のonAuthStateChange競合を防止するフラグ
  const isSigningUpRef = useRef(false);
  // ログイン処理中のonAuthStateChange二重同期を防止するフラグ
  const isAuthSyncingRef = useRef(false);

  // ユーザー設定・カテゴリの変更をクラウドへ保存（デバウンス対応）
  const saveCloudSettings = (
    partial: Partial<{
      categories: string[];
      time_slots: Record<TimeSlotKey, TimeSlotConfig>;
      font_size: FontSize;
      button_size: ButtonSize;
      font_family: FontFamily;
      note_font: NoteFontFamily;
      note_collapse_lines: NoteCollapseLines;
      enable_toast: boolean;
      confirm_discard: boolean;
      theme_hue: ColorHue;
      theme_brightness: ThemeBrightness;
    }>,
    immediate: boolean = false
  ) => {
    if (!currentUser) return;

    const doSave = async () => {
      try {
        const cur = latestSettingsRef.current;
        const basePayload = {
          user_id: currentUser.id,
          categories: partial.categories ?? serializeCategoryItems(cur.categoriesList),
          time_slots: partial.time_slots ?? cur.timeSlots,
          font_size: partial.font_size ?? cur.fontSize,
          button_size: partial.button_size ?? cur.buttonSize,
          font_family: partial.font_family ?? cur.fontFamily,
          note_font: partial.note_font ?? cur.noteFont,
          enable_toast: partial.enable_toast ?? cur.enableToast,
          confirm_discard: partial.confirm_discard ?? cur.confirmDiscardOnEdit,
          theme_hue: partial.theme_hue ?? cur.selectedHue,
          theme_brightness: partial.theme_brightness ?? cur.themeBrightness,
          updated_at: new Date().toISOString(),
        };
        const { error } = await supabase.from("user_settings").upsert({
          ...basePayload,
          note_collapse_lines: partial.note_collapse_lines ?? cur.noteCollapseLines,
        });
        if (error && error.message?.includes("note_collapse_lines")) {
          // note_collapse_lines カラム未追加のDB環境でも他設定を確実に同期するフォールバック
          await supabase.from("user_settings").upsert(basePayload);
        }
      } catch (e) {
        console.error("設定のクラウド保存エラー", e);
      }
    };

    if (cloudSettingsTimeoutRef.current) {
      clearTimeout(cloudSettingsTimeoutRef.current);
    }

    if (immediate) {
      doSave();
    } else {
      cloudSettingsTimeoutRef.current = setTimeout(doSave, 600);
    }
  };

  // テーマの切り替え処理（ローカルおよびクラウドへの自動同期）
  const handleChangeTheme = (hue: ColorHue, brightness?: ThemeBrightness) => {
    setSelectedHue(hue);
    localStorage.setItem("seednote_theme_hue", hue);
    const nextBrightness = brightness ?? themeBrightness;
    if (brightness) {
      setThemeBrightness(brightness);
      localStorage.setItem("seednote_theme_brightness", brightness);
    }
    // クラウド（Supabase）へ自動保存
    saveCloudSettings({
      theme_hue: hue,
      theme_brightness: nextBrightness,
    });
  };

  // クラウド（Supabase）からメモを取得＆ローカルメモの自動引き継ぎ
  const fetchCloudNotes = async (userId: string, currentLocalNotes?: Note[]) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setSyncStatus("offline");
      return;
    }
    setIsSyncing(true);
    setSyncStatus("syncing");
    try {
      const fetchPromise = supabase
        .from("notes")
        .select("*")
        .order("created_at", { ascending: false });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SYNC_TIMEOUT")), 10000)
      );
      const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);

      if (error) {
        console.error("クラウドメモの取得に失敗しました", error);
        setSyncStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
        return;
      }

      if (data) {
        const cloudNotes: Note[] = (data as DbNoteRow[]).map(mapDbRowToNote);
        // クロージャ内の古い state ではなく localStorage から最新のローカルメモを取得して引き継ぐ
        let baseLocalNotes: Note[] = currentLocalNotes ?? [];
        if (!currentLocalNotes) {
          try {
            const savedItems = localStorage.getItem("seednote_items");
            if (savedItems) {
              const parsed = JSON.parse(savedItems);
              if (Array.isArray(parsed)) {
                baseLocalNotes = parsed;
              }
            }
          } catch {
            baseLocalNotes = notes;
          }
        }

        // クラウドノート側で、オフライン中に行われた訂正（本文+履歴）や追記（replies）が未反映ならローカルを保護＆自己修復
        const notesToRepairInCloud: { id: string; payload: Record<string, unknown> }[] = [];
        const protectedCloudNotes = cloudNotes.map((cn) => {
          const loc = baseLocalNotes.find((l) => l.id === cn.id);
          if (!loc) return cn;

          let nextNote = cn;
          const repairPayload: Record<string, unknown> = {};

          // 1. 本文の訂正・履歴の保護
          const locHistoryCount = loc.editHistory?.length || 0;
          const cloudHistoryCount = cn.editHistory?.length || 0;
          if (locHistoryCount > cloudHistoryCount && loc.editHistory) {
            nextNote = {
              ...nextNote,
              content: loc.content,
              editHistory: loc.editHistory,
            };
            repairPayload.content = loc.content;
            repairPayload.edit_history = loc.editHistory;
          }

          // 2. 追記（replies）のID単位マージ＆保護
          const locReplies = loc.replies || [];
          const cloudReplies = cn.replies || [];
          if (locReplies.length > 0) {
            const cloudReplyIds = new Set(cloudReplies.map((r) => r.id));
            const missingInCloud = locReplies.filter((r) => !cloudReplyIds.has(r.id));
            if (missingInCloud.length > 0) {
              const replyMap = new Map<string, NoteReply>();
              [...cloudReplies, ...locReplies].forEach((r) => replyMap.set(r.id, r));
              const mergedReplies = Array.from(replyMap.values()).sort(
                (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
              );
              nextNote = { ...nextNote, replies: mergedReplies };
              repairPayload.replies = mergedReplies;
            }
          }

          if (Object.keys(repairPayload).length > 0) {
            notesToRepairInCloud.push({ id: cn.id, payload: repairPayload });
          }

          return nextNote;
        });

        // ローカルの未反映変更をバックグラウンドでクラウド側へ自己修復
        notesToRepairInCloud.forEach(({ id, payload }) => {
          supabase
            .from("notes")
            .update(payload)
            .eq("id", id)
            .then(({ error: repairErr }) => {
              if (repairErr) console.warn("クラウド自己修復エラー:", repairErr.message);
            });
        });

        // ローカルにしか存在しないメモがあれば、クラウドにアップロード（引き継ぎ）
        const localOnlyNotes = baseLocalNotes.filter(
          (loc) => !cloudNotes.some((c) => c.id === loc.id)
        );

        let finalNotes = protectedCloudNotes;

        if (localOnlyNotes.length > 0) {
          const rowsToInsert = localOnlyNotes.map((n) => mapNoteToDbRow(n, userId));
          const { error: insertErr } = await supabase.from("notes").insert(rowsToInsert);
          if (!insertErr) {
            finalNotes = [...protectedCloudNotes, ...localOnlyNotes].sort(
              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );
          }
        }

        // メモに付与されているカテゴリタグが旧文字列形式ならIDへ自動移行し、設定同期に連携
        let localCatsForMigration: CategoryItem[] = [];
        try {
          const savedCats = localStorage.getItem("seednote_categories");
          if (savedCats) localCatsForMigration = parseCategoryItems(JSON.parse(savedCats));
        } catch {
          localCatsForMigration = latestSettingsRef.current.categoriesList;
        }
        const {
          migratedNotes,
          updatedCatalog,
          changedNoteIds,
        } = migrateNotesCategories(finalNotes, localCatsForMigration);

        if (changedNoteIds.length > 0) {
          changedNoteIds.forEach((id) => {
            const mNote = migratedNotes.find((n) => n.id === id);
            if (mNote) {
              supabase.from("notes").update({ categories: mNote.categories || [] }).eq("id", mNote.id).then();
            }
          });
        }

        // クラウドのメモで更新
        setNotes(migratedNotes);
        localStorage.setItem("seednote_items", JSON.stringify(migratedNotes));

        const noteCatIds = new Set(migratedNotes.flatMap((n) => n.categories || []));
        const noteCatItems = updatedCatalog.filter((c) => noteCatIds.has(c.id));
        fetchUserSettings(userId, noteCatItems);
        setSyncStatus("idle");
      }
    } catch (e) {
      console.error("同期処理中にエラーが発生しました", e);
      setSyncStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
    } finally {
      setIsSyncing(false);
    }
  };

  // クラウド（Supabase）からユーザー設定・カテゴリを取得＆ローカルと同期
  const fetchUserSettings = async (userId: string, extraCategories?: CategoryItem[]) => {
    try {
      const { data, error } = await supabase
        .from("user_settings")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("クラウド設定の取得に失敗しました", error);
        return;
      }

      // ローカル保存されている最新のカテゴリ一覧を取得
      let localCats: CategoryItem[] = [];
      try {
        const savedCats = localStorage.getItem("seednote_categories");
        if (savedCats) localCats = parseCategoryItems(JSON.parse(savedCats));
      } catch {
        localCats = latestSettingsRef.current.categoriesList;
      }

      if (data) {
        const row = data as DbUserSettingsRow;
        const cloudCats = parseCategoryItems(row.categories);

        // クラウドカテゴリ + ローカルカテゴリ + メモ由来のカテゴリをID単位で統合（更新日時が新しい方を優先）
        const mergedCats = mergeCategoryItems(
          mergeCategoryItems(cloudCats, localCats),
          extraCategories || []
        );
        const serializedMergedCats = serializeCategoryItems(mergedCats);
        setCategoriesList(mergedCats);
        latestSettingsRef.current.categoriesList = mergedCats;
        localStorage.setItem("seednote_categories", JSON.stringify(serializedMergedCats));

        // 時間帯設定の同期
        if (row.time_slots) {
          const cloudSlots = row.time_slots;
          const mergedSlots: Record<TimeSlotKey, TimeSlotConfig> = { ...DEFAULT_TIME_SLOTS };
          (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).forEach((key) => {
            if (cloudSlots[key]) {
              mergedSlots[key] = {
                ...DEFAULT_TIME_SLOTS[key],
                ...cloudSlots[key],
                color: cloudSlots[key].color || DEFAULT_TIME_SLOTS[key].color,
              };
            }
          });
          setTimeSlots(mergedSlots);
          localStorage.setItem("seednote_time_slots", JSON.stringify(mergedSlots));
        }

        // 文字サイズ
        if (row.font_size === "normal" || row.font_size === "large") {
          setFontSize(row.font_size);
          localStorage.setItem("seednote_font_size", row.font_size);
        }

        // ボタンサイズ
        if (row.button_size === "normal" || row.button_size === "large") {
          setButtonSize(row.button_size);
          localStorage.setItem("seednote_button_size", row.button_size);
        }

        // 保存通知
        if (typeof row.enable_toast === "boolean") {
          setEnableToast(row.enable_toast);
          localStorage.setItem("seednote_enable_toast", String(row.enable_toast));
        }

        // 編集破棄確認
        if (typeof row.confirm_discard === "boolean") {
          setConfirmDiscardOnEdit(row.confirm_discard);
          localStorage.setItem("seednote_confirm_discard", String(row.confirm_discard));
        }

        // 復旧キーの同期・既存アカウントへの自動発行
        if (row.recovery_key) {
          setRecoveryKey(row.recovery_key);
          localStorage.setItem("seednote_recovery_key", row.recovery_key);
        } else {
          const generated = generateRecoveryKey();
          setRecoveryKey(generated);
          localStorage.setItem("seednote_recovery_key", generated);
          supabase.from("user_settings").update({ recovery_key: generated }).eq("user_id", userId).then();
        }

        // テーマカラーの同期（クラウドに保存があれば復元、未設定ならローカル値を同期）
        if (row.theme_hue) {
          setSelectedHue(row.theme_hue);
          localStorage.setItem("seednote_theme_hue", row.theme_hue);
        } else if (latestSettingsRef.current.selectedHue) {
          supabase
            .from("user_settings")
            .update({
              theme_hue: latestSettingsRef.current.selectedHue,
              theme_brightness: latestSettingsRef.current.themeBrightness,
            })
            .eq("user_id", userId)
            .then();
        }
        if (row.theme_brightness === "pastel" || row.theme_brightness === "dark") {
          setThemeBrightness(row.theme_brightness);
          localStorage.setItem("seednote_theme_brightness", row.theme_brightness);
        }

        // 文字フォント（全体・メモ専用）の同期
        if (row.font_family === "sans" || row.font_family === "serif" || row.font_family === "rounded") {
          setFontFamily(row.font_family);
          localStorage.setItem("seednote_font_family", row.font_family);
        }
        if (row.note_font && ["sans", "klee", "yomogi", "mincho", "mono"].includes(row.note_font)) {
          setNoteFont(row.note_font);
          localStorage.setItem("seednote_note_font", row.note_font);
        }
        if (
          row.note_collapse_lines === 0 ||
          row.note_collapse_lines === 5 ||
          row.note_collapse_lines === 8 ||
          row.note_collapse_lines === 12
        ) {
          setNoteCollapseLines(row.note_collapse_lines);
          localStorage.setItem("seednote_note_collapse_lines", String(row.note_collapse_lines));
        }

        // 鍵付きメモ設定の同期
        if (typeof row.lock_password_hash === "string" && row.lock_password_hash) {
          setLockPasswordHash(row.lock_password_hash);
          localStorage.setItem("seednote_lock_password_hash", row.lock_password_hash);
        }
        if (typeof row.mask_locked_title === "boolean") {
          setMaskLockedTitle(row.mask_locked_title);
          localStorage.setItem("seednote_mask_locked_title", String(row.mask_locked_title));
        }
        if (row.auto_lock_mode && ["manual", "5m", "15m", "background"].includes(row.auto_lock_mode)) {
          setAutoLockMode(row.auto_lock_mode);
          localStorage.setItem("seednote_auto_lock_mode", row.auto_lock_mode);
        }

        // クラウド側と差分がある場合（旧文字列形式からの移行や端末間の最新化）はクラウド側も最新化
        const rawCloudCats = Array.isArray(row.categories) ? row.categories : [];
        if (JSON.stringify(serializedMergedCats) !== JSON.stringify(rawCloudCats)) {
          const cur = latestSettingsRef.current;
          await supabase.from("user_settings").upsert({
            user_id: userId,
            categories: serializedMergedCats,
            time_slots: row.time_slots || cur.timeSlots,
            font_size: row.font_size || cur.fontSize,
            button_size: row.button_size || cur.buttonSize,
            font_family: row.font_family || cur.fontFamily,
            note_font: row.note_font || cur.noteFont,
            enable_toast: row.enable_toast ?? cur.enableToast,
            confirm_discard: row.confirm_discard ?? cur.confirmDiscardOnEdit,
            theme_hue: row.theme_hue || cur.selectedHue,
            theme_brightness: row.theme_brightness || cur.themeBrightness,
            updated_at: new Date().toISOString(),
          });
        }
      } else {
        if (isSigningUpRef.current) return;
        // クラウドにまだ設定がない場合：現在のローカル設定をクラウドに初回保存（競合による復旧キー上書きを防ぐためinsertを使用）
        const cur = latestSettingsRef.current;
        const initialCats = serializeCategoryItems(
          mergeCategoryItems(localCats, extraCategories || [])
        );
        const generated = generateRecoveryKey();
        const { error: insertErr } = await supabase.from("user_settings").insert({
          user_id: userId,
          categories: initialCats,
          time_slots: cur.timeSlots,
          font_size: cur.fontSize,
          button_size: cur.buttonSize,
          font_family: cur.fontFamily,
          note_font: cur.noteFont,
          enable_toast: cur.enableToast,
          confirm_discard: cur.confirmDiscardOnEdit,
          recovery_key: generated,
          theme_hue: cur.selectedHue,
          theme_brightness: cur.themeBrightness,
          updated_at: new Date().toISOString(),
        });
        if (insertErr) {
          const { data: existingRow } = await supabase
            .from("user_settings")
            .select("recovery_key")
            .eq("user_id", userId)
            .maybeSingle();
          if (existingRow && typeof existingRow.recovery_key === "string" && existingRow.recovery_key) {
            setRecoveryKey(existingRow.recovery_key);
            localStorage.setItem("seednote_recovery_key", existingRow.recovery_key);
          }
          return;
        }
        setRecoveryKey(generated);
        localStorage.setItem("seednote_recovery_key", generated);
      }
    } catch (e) {
      console.error("設定同期中にエラーが発生しました", e);
    }
  };

  // 初回ロード時にSupabaseセッションを復元＆状態変化・オンライン復帰を監視
  useEffect(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setSyncStatus("offline");
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null;
      setCurrentUser(u);
      if (u) {
        const name = (u.user_metadata?.username as string) || u.email?.split("@")[0] || "";
        setCurrentUsername(name);
        fetchCloudNotes(u.id);
        fetchUserSettings(u.id);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (isSigningUpRef.current || isAuthSyncingRef.current) return;
      const u = session?.user ?? null;
      setCurrentUser(u);
      if (u) {
        const name = (u.user_metadata?.username as string) || u.email?.split("@")[0] || "";
        setCurrentUsername(name);
        fetchCloudNotes(u.id);
        fetchUserSettings(u.id);
      } else {
        setCurrentUsername("");
      }
    });

    const handleOnline = () => {
      supabase.auth.getSession().then(({ data: { session } }) => {
        const u = session?.user ?? null;
        if (u) {
          fetchCloudNotes(u.id);
          fetchUserSettings(u.id);
        } else {
          setSyncStatus("idle");
        }
      });
    };
    const handleOffline = () => {
      setSyncStatus("offline");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // ユーザー名から内部メールアドレスを生成
  const getInternalEmail = (username: string) => {
    return `${username.trim().toLowerCase()}@seednote.local`;
  };

  // 認証モーダルのモード切り替え・閉じる時の共通リセット処理
  const handleSwitchAuthMode = (nextMode: "login" | "signup" | "reset") => {
    if (nextMode === "reset" || authMode === "reset") {
      setAuthPasswordInput("");
    }
    setAuthMode(nextMode);
    setAuthError(null);
    setAuthSuccessMsg(null);
    setAuthPasswordConfirmInput("");
    setResetRecoveryKeyInput("");
    setShowPassword(false);
    setShowPasswordConfirm(false);
    setAgreedToTerms(false);
  };

  const handleCloseAuthModal = () => {
    setIsAuthModalOpen(false);
    setAuthUsernameInput("");
    setAuthPasswordInput("");
    handleSwitchAuthMode("login");
  };

  // ログイン／新規登録の送信処理
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMsg(null);

    const username = authUsernameInput.trim();
    const password = authPasswordInput.trim();

    if (!username) {
      setAuthError("ユーザー名を入力してください");
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      setAuthError("ユーザー名は半角英数字（またはピリオド・ハイフン・アンダースコア）で入力してください");
      return;
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      setAuthError(`ユーザー名は${MAX_USERNAME_LENGTH}文字以内で入力してください`);
      return;
    }
    if (!password) {
      setAuthError("パスワードを入力してください");
      return;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      setAuthError(`パスワードは${MAX_PASSWORD_LENGTH}文字以内で入力してください`);
      return;
    }
    if (password.length < 6) {
      setAuthError(
        authMode === "login"
          ? "パスワードは6文字以上です"
          : "パスワードは6文字以上で設定してください"
      );
      return;
    }
    if (authMode === "signup") {
      const confirmPass = authPasswordConfirmInput.trim();
      if (!confirmPass) {
        setAuthError("確認用パスワードを入力してください");
        return;
      }
      if (password !== confirmPass) {
        setAuthError("パスワードと確認用パスワードが一致しません");
        return;
      }
      if (!agreedToTerms) {
        setAuthError("利用規約とプライバシーへの同意が必要です");
        return;
      }
    }

    setIsAuthLoading(true);
    const internalEmail = getInternalEmail(username);

    try {
      if (authMode === "login") {
        isAuthSyncingRef.current = true;
        try {
          const { data, error } = await supabase.auth.signInWithPassword({
            email: internalEmail,
            password: password,
          });
          if (error) {
            if (error.message.includes("Invalid login credentials")) {
              setAuthError("ユーザー名またはパスワードが正しくありません");
            } else {
              setAuthError(`ログインに失敗しました: ${error.message}`);
            }
            return;
          }
          if (data.user) {
            setCurrentUser(data.user);
            setCurrentUsername(username);
            setAuthSuccessMsg("ログインしました！同期を開始します...");
            await fetchCloudNotes(data.user.id, notes);
            await fetchUserSettings(data.user.id);
            setTimeout(() => {
              setIsAuthModalOpen(false);
              setAuthUsernameInput("");
              setAuthPasswordInput("");
              setAuthPasswordConfirmInput("");
              setShowPassword(false);
              setShowPasswordConfirm(false);
              setAuthSuccessMsg(null);
              setAgreedToTerms(false);
            }, 800);
          }
        } finally {
          isAuthSyncingRef.current = false;
        }
      } else {
        // 新規登録（onAuthStateChangeとの競合による復旧キー上書きを防止）
        isSigningUpRef.current = true;
        const { data, error } = await supabase.auth.signUp({
          email: internalEmail,
          password: password,
          options: {
            data: {
              username: username,
            },
          },
        });
        if (error) {
          if (
            error.message.includes("already registered") ||
            error.message.includes("User already registered")
          ) {
            setAuthError("このユーザー名はすでに使われています。別の名前をお試しください。");
          } else {
            setAuthError(`登録に失敗しました: ${error.message}`);
          }
          return;
        }
        if (data.user) {
          const generatedKey = generateRecoveryKey();

          // user_settingsに復旧キーを確実に保存
          const cur = latestSettingsRef.current;
          const { error: settingsUpsertErr } = await supabase.from("user_settings").upsert({
            user_id: data.user.id,
            recovery_key: generatedKey,
            categories: cur.categoriesList,
            time_slots: cur.timeSlots,
            font_size: cur.fontSize,
            button_size: cur.buttonSize,
            font_family: cur.fontFamily,
            note_font: cur.noteFont,
            enable_toast: cur.enableToast,
            confirm_discard: cur.confirmDiscardOnEdit,
            theme_hue: cur.selectedHue,
            theme_brightness: cur.themeBrightness,
            updated_at: new Date().toISOString(),
          });

          if (settingsUpsertErr) {
            console.error("新規登録時のuser_settings保存に失敗:", settingsUpsertErr);
            setAuthError("アカウントの初期設定保存に失敗しました。通信環境をご確認のうえ再度お試しください。");
            return;
          }

          setRecoveryKey(generatedKey);
          localStorage.setItem("seednote_recovery_key", generatedKey);
          setCurrentUser(data.user);
          setCurrentUsername(username);
          await fetchCloudNotes(data.user.id, notes);

          // 認証モーダルを閉じて、復旧キーの案内モーダルを開く
          setIsAuthModalOpen(false);
          setAuthUsernameInput("");
          setAuthPasswordInput("");
          setAuthPasswordConfirmInput("");
          setShowPassword(false);
          setShowPasswordConfirm(false);
          setAuthSuccessMsg(null);
          setAgreedToTerms(false);
          setNewlyRegisteredKey(generatedKey);
        }
      }
    } catch {
      setAuthError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      isSigningUpRef.current = false;
      setIsAuthLoading(false);
    }
  };

  // パスワード再設定の送信処理（復旧キー使用）
  const handleResetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccessMsg(null);

    const username = authUsernameInput.trim();
    const recoveryKeyInput = resetRecoveryKeyInput.trim();
    const password = authPasswordInput.trim();
    const confirmPass = authPasswordConfirmInput.trim();

    if (!username) {
      setAuthError("ユーザー名を入力してください");
      return;
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      setAuthError(`ユーザー名は${MAX_USERNAME_LENGTH}文字以内で入力してください`);
      return;
    }
    if (!recoveryKeyInput) {
      setAuthError("復旧キーを入力してください");
      return;
    }
    if (!password) {
      setAuthError("新しいパスワードを入力してください");
      return;
    }
    if (password.length < 6 || password.length > MAX_PASSWORD_LENGTH) {
      setAuthError(`パスワードは6〜${MAX_PASSWORD_LENGTH}文字で設定してください`);
      return;
    }
    if (!confirmPass) {
      setAuthError("確認用パスワードを入力してください");
      return;
    }
    if (password !== confirmPass) {
      setAuthError("パスワードと確認用パスワードが一致しません");
      return;
    }

    setIsAuthLoading(true);

    try {
      const { data, error } = await supabase.rpc("reset_password_with_recovery_key", {
        p_username: username,
        p_recovery_key: recoveryKeyInput,
        p_new_password: password,
      });

      if (error) {
        setAuthError(`再設定エラー: ${error.message}`);
        return;
      }

      if (data && typeof data === "object" && !(data as { success: boolean }).success) {
        setAuthError((data as { error?: string }).error || "ユーザー名または復旧キーが正しくありません");
        return;
      }

      setAuthSuccessMsg("パスワードを再設定しました！ログインしています...");

      // 自動でログイン
      const internalEmail = getInternalEmail(username);
      const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
        email: internalEmail,
        password: password,
      });

      if (signInErr || !signInData.user) {
        setAuthSuccessMsg("パスワードの再設定が完了しました。新しいパスワードでログインしてください。");
        setTimeout(() => {
          setAuthMode("login");
          setAuthPasswordInput("");
          setAuthPasswordConfirmInput("");
          setResetRecoveryKeyInput("");
          setAuthSuccessMsg(null);
        }, 1500);
        return;
      }

      setCurrentUser(signInData.user);
      setCurrentUsername(username);
      await fetchCloudNotes(signInData.user.id, notes);
      await fetchUserSettings(signInData.user.id);

      setTimeout(() => {
        setIsAuthModalOpen(false);
        setAuthUsernameInput("");
        setAuthPasswordInput("");
        setAuthPasswordConfirmInput("");
        setResetRecoveryKeyInput("");
        setShowPassword(false);
        setShowPasswordConfirm(false);
        setAuthSuccessMsg(null);
        setAuthMode("login");
      }, 1000);
    } catch {
      setAuthError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setIsAuthLoading(false);
    }
  };

  // ログアウト処理
  const handleLogout = async () => {
    await supabase.auth.signOut();
    setCurrentUser(null);
    setCurrentUsername("");
    setUnlockedNoteIds([]);
    setIsLockSessionVerified(false);
  };

  // アカウント削除時にローカル保存データと画面状態を初期化するヘルパー
  const resetLocalAppData = () => {
    const storageKeys = [
      "seednote_items",
      "seednote_enable_toast",
      "seednote_font_size",
      "seednote_button_size",
      "seednote_categories",
      "seednote_confirm_discard",
      "seednote_time_slots",
      "seednote_category_sort_order",
      "seednote_recovery_key",
      "seednote_theme_hue",
      "seednote_theme_brightness",
      "seednote_font_family",
      "seednote_note_font",
      "seednote_tutorial_shown",
      "seednote_lock_password_hash",
      "seednote_mask_locked_title",
      "seednote_auto_lock_mode",
    ];
    storageKeys.forEach((key) => localStorage.removeItem(key));
    setUnlockedNoteIds([]);
    setIsLockSessionVerified(false);
    setLockPasswordHash("");
    setMaskLockedTitle(true);
    setAutoLockMode("manual");

    setNotes([]);
    setTitle("");
    setContent("");
    setSelectedCategories([]);
    setCategoriesList([]);
    setFilterCategories([]);
    setFilterOnlyFavorite(false);
    setIncludeTrashInSearch(false);
    setSearchQuery("");
    setFilterTimeSlots([]);
    setFilterDate("");
    setTrashFilterOnlyFavorite(false);
    setTrashFilterCategories([]);
    setTrashSearchQuery("");
    setReplyingNoteId(null);
    setReplyContent("");
    setExpandedReplyNoteIds([]);
    setExpandedHistoryNoteIds([]);
    setSelectedHue("cream");
    setThemeBrightness("pastel");
    setFontSize("normal");
    setButtonSize("normal");
    setFontFamily("sans");
    setNoteFont("sans");
    setEnableToast(true);
    setConfirmDiscardOnEdit(true);
    setTimeSlots(DEFAULT_TIME_SLOTS);
    setCategorySortOrder("usage");
    setIsTutorialPromptDismissed(false);
  };

  // アカウント削除モーダルを開く（ログイン中のみ）
  const handleOpenDeleteAccountModal = () => {
    if (!currentUser) return;
    setDeleteAccountStep("auth");
    setDeleteUsernameInput("");
    setDeletePasswordInput("");
    setShowDeletePassword(false);
    setDeleteLocalDataToo(true);
    setDeleteAccountError(null);
    setIsDeleteAccountModalOpen(true);
  };

  // アカウント削除モーダルを閉じる
  const handleCloseDeleteAccountModal = () => {
    if (isDeletingAccount) return;
    setIsDeleteAccountModalOpen(false);
    setDeleteAccountStep("auth");
    setDeleteUsernameInput("");
    setDeletePasswordInput("");
    setShowDeletePassword(false);
    setDeleteAccountError(null);
  };

  // アカウント削除前の第1段階：ログイン中IDとの一致＋パスワード本人確認
  const handleVerifyDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !currentUsername || isDeletingAccount) return;
    setDeleteAccountError(null);

    const username = deleteUsernameInput.trim();
    const password = deletePasswordInput.trim();

    if (!username) {
      setDeleteAccountError("ユーザー名（ID）を入力してください");
      return;
    }
    if (!password) {
      setDeleteAccountError("パスワードを入力してください");
      return;
    }
    if (username.toLowerCase() !== currentUsername.toLowerCase()) {
      setDeleteAccountError("現在ログイン中のユーザー名（ID）と一致しません");
      return;
    }

    setIsDeletingAccount(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: getInternalEmail(username),
        password,
      });

      if (error || !data.user) {
        setDeleteAccountError("パスワードが正しくありません");
        return;
      }
      if (data.user.id !== currentUser.id) {
        setDeleteAccountError("現在ログイン中のアカウントと一致しません");
        return;
      }

      setDeletePasswordInput("");
      setShowDeletePassword(false);
      setDeleteAccountStep("confirm");
    } catch {
      setDeleteAccountError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // アカウント削除の第2段階：最終確認後の完全削除実行
  const handleExecuteDeleteAccount = async () => {
    if (!currentUser || isDeletingAccount) return;
    setDeleteAccountError(null);
    setIsDeletingAccount(true);

    if (cloudSettingsTimeoutRef.current) {
      clearTimeout(cloudSettingsTimeoutRef.current);
      cloudSettingsTimeoutRef.current = null;
    }

    try {
      const { error } = await supabase.rpc("delete_own_account");
      if (error) {
        setDeleteAccountError(`アカウントの削除に失敗しました: ${error.message}`);
        return;
      }

      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
      setCurrentUser(null);
      setCurrentUsername("");
      setRecoveryKey("");
      setShowRecoveryKeyInSettings(false);
      localStorage.removeItem("seednote_recovery_key");

      const removedLocal = deleteLocalDataToo;
      if (removedLocal) {
        resetLocalAppData();
        setActiveTab("home");
      }

      setIsDeleteAccountModalOpen(false);
      setDeleteAccountStep("auth");
      setDeleteUsernameInput("");
      setDeletePasswordInput("");
      setShowDeletePassword(false);

      setToastMessage(
        removedLocal
          ? "アカウントと端末内のデータを削除しました"
          : "クラウドアカウントを削除しました（端末内のデータは残っています）"
      );
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    } catch {
      setDeleteAccountError("通信エラーが発生しました。接続を確認してください。");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // カテゴリの選択・解除切り替え
  const handleToggleCategory = (catName: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catName)
        ? prev.filter((c) => c !== catName)
        : [...prev, catName]
    );
  };

  // 新規カテゴリの追加処理（固有IDを返す）
  const handleAddCategory = (name: string): string | null => {
    const trimmed = truncateByCodePoints(name.trim(), MAX_CATEGORY_NAME_LENGTH);
    if (!trimmed) return null;

    // 予約語のチェック（「すべてのメモ」「未分類」およびダブルクォーテーション付き）
    const reservedWords = [
      "すべてのメモ",
      "未分類",
      "”すべてのメモ”",
      "”未分類”",
      "\"すべてのメモ\"",
      "\"未分類\""
    ];
    if (reservedWords.includes(trimmed)) {
      alert("「”すべてのメモ”」および「”未分類”」はシステム専用のため作成できません");
      return null;
    }

    const existing = activeCategories.find((c) => c.name === trimmed);
    if (existing) return existing.id;

    const newItem: CategoryItem = {
      id: createCategoryId(),
      name: trimmed,
      updatedAt: new Date().toISOString(),
    };
    const updated = [...categoriesList, newItem];
    const serialized = serializeCategoryItems(updated);
    setCategoriesList(updated);
    latestSettingsRef.current.categoriesList = updated;
    try {
      localStorage.setItem("seednote_categories", JSON.stringify(serialized));
    } catch (e) {
      console.error("カテゴリの保存に失敗しました", e);
    }
    saveCloudSettings({ categories: serialized }, true);
    return newItem.id;
  };

  // メモ入力中のインライン新規カテゴリ追加
  const handleSaveInlineCategory = () => {
    const trimmed = inlineNewCategoryName.trim();
    if (trimmed) {
      const catId = handleAddCategory(trimmed);
      if (catId && !selectedCategories.includes(catId)) {
        setSelectedCategories((prev) => [...prev, catId]);
      }
    }
    setInlineNewCategoryName("");
    setIsAddingCategoryInline(false);
  };

  // カテゴリ管理画面での新規カテゴリ作成
  const handleCreateCategoryFromManagement = () => {
    const trimmed = newCategoryInput.trim();
    if (trimmed) {
      handleAddCategory(trimmed);
      setNewCategoryInput("");
    }
  };

  // カテゴリ消去の確定処理（※過去のメモデータは消去せず、該当カテゴリタグのみ安全に除外）
  const handleConfirmDeleteCategory = () => {
    if (!categoryToDelete) return;
    const targetId = categoryToDelete.id;
    const now = new Date().toISOString();

    // 同期時に復活しないよう削除フラグと更新日時を記録
    const updatedCategories = categoriesList.map((c) =>
      c.id === targetId ? { ...c, deleted: true, updatedAt: now } : c
    );
    const serialized = serializeCategoryItems(updatedCategories);
    setCategoriesList(updatedCategories);
    latestSettingsRef.current.categoriesList = updatedCategories;
    safeSetLocalStorage("seednote_categories", JSON.stringify(serialized));
    saveCloudSettings({ categories: serialized }, true);

    // 選択中カテゴリ・検索フィルタからも除外
    setSelectedCategories((prev) => prev.filter((c) => c !== targetId));
    setFilterCategories((prev) => prev.filter((c) => c !== targetId));
    setTrashFilterCategories((prev) => prev.filter((c) => c !== targetId));

    // 既存メモから該当カテゴリのみを除外
    const notesToUpdateInCloud: Note[] = [];
    const updatedNotes = notes.map((note) => {
      if (!note.categories) return note;
      if (note.categories.includes(targetId)) {
        const filtered = note.categories.filter((c) => c !== targetId);
        const updated = {
          ...note,
          categories: filtered.length > 0 ? filtered : undefined,
        };
        notesToUpdateInCloud.push(updated);
        return updated;
      }
      return note;
    });
    setNotes(updatedNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser && notesToUpdateInCloud.length > 0) {
      notesToUpdateInCloud.forEach((n) => {
        supabase.from("notes").update({ categories: n.categories || [] }).eq("id", n.id).then();
      });
    }

    // モーダルを閉じる
    setCategoryToDelete(null);
  };

  // カテゴリ名の変更確定処理（固有IDは維持したまま名前と更新日時だけを更新）
  const handleConfirmRenameCategory = () => {
    if (!categoryToRename) return;
    const trimmed = renameCategoryInput.trim();
    if (!trimmed) {
      setRenameCategoryError("カテゴリ名を入力してください");
      return;
    }
    if (trimmed.length > MAX_CATEGORY_NAME_LENGTH) {
      setRenameCategoryError(`カテゴリ名は${MAX_CATEGORY_NAME_LENGTH}文字以内で入力してください`);
      return;
    }

    const reservedWords = [
      "すべてのメモ",
      "未分類",
      "”すべてのメモ”",
      "”未分類”",
      "\"すべてのメモ\"",
      "\"未分類\"",
    ];
    if (reservedWords.includes(trimmed)) {
      setRenameCategoryError("「”すべてのメモ”」および「”未分類”」はシステム専用のため使用できません");
      return;
    }

    if (trimmed === categoryToRename.name) {
      setCategoryToRename(null);
      setRenameCategoryError(null);
      return;
    }

    if (activeCategories.some((c) => c.id !== categoryToRename.id && c.name === trimmed)) {
      setRenameCategoryError("同じ名前のカテゴリがすでに存在します");
      return;
    }

    const now = new Date().toISOString();
    const updatedCategories = categoriesList.map((c) =>
      c.id === categoryToRename.id ? { ...c, name: trimmed, updatedAt: now } : c
    );
    const serialized = serializeCategoryItems(updatedCategories);
    setCategoriesList(updatedCategories);
    latestSettingsRef.current.categoriesList = updatedCategories;
    safeSetLocalStorage("seednote_categories", JSON.stringify(serialized));
    saveCloudSettings({ categories: serialized }, true);

    setCategoryToRename(null);
    setRenameCategoryError(null);
    if (enableToast) {
      setToastMessage(`🏷️ 「${trimmed}」に変更しました`);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    }
  };

  // メモのタイトル・カテゴリ変更モーダルを開く
  const handleOpenEditModal = (note: Note) => {
    setEditingNote(note);
    setEditTitleInput(note.title || "");
    setEditCategories(note.categories || []);
    setIsAddingCategoryInEdit(false);
    setInlineNewCategoryInEdit("");
    setActiveMenuNoteId(null);
  };

  // 編集モーダル内でのカテゴリ選択切り替え
  const handleToggleEditCategory = (catName: string) => {
    setEditCategories((prev) =>
      prev.includes(catName)
        ? prev.filter((c) => c !== catName)
        : [...prev, catName]
    );
  };

  // 編集モーダル内での新規カテゴリ作成
  const handleSaveCategoryInEdit = () => {
    const trimmed = inlineNewCategoryInEdit.trim();
    if (trimmed) {
      const catId = handleAddCategory(trimmed);
      if (catId && !editCategories.includes(catId)) {
        setEditCategories((prev) => [...prev, catId]);
      }
    }
    setInlineNewCategoryInEdit("");
    setIsAddingCategoryInEdit(false);
  };

  // メモのタイトル・カテゴリ変更の確定保存
  const handleSaveNoteEdit = () => {
    if (!editingNote) return;

    const updatedNotes = notes.map((n) => {
      if (n.id === editingNote.id) {
        return {
          ...n,
          title: truncateByCodePoints(editTitleInput.trim(), MAX_NOTE_TITLE_LENGTH) || undefined,
          categories: editCategories.length > 0 ? editCategories : undefined,
        };
      }
      return n;
    });

    setNotes(updatedNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(updatedNotes));

    // Supabaseに反映
    if (currentUser) {
      supabase
        .from("notes")
        .update({
          title: truncateByCodePoints(editTitleInput.trim(), MAX_NOTE_TITLE_LENGTH) || null,
          categories: editCategories.length > 0 ? editCategories : [],
        })
        .eq("id", editingNote.id)
        .then();
    }

    setEditingNote(null);
    setIsAddingCategoryInEdit(false);
    setInlineNewCategoryInEdit("");
  };

  // 編集モーダルを閉じる前の確認処理（フールプルーフ）
  const handleRequestCloseEditModal = () => {
    if (!editingNote) {
      setEditingNote(null);
      return;
    }

    const originalTitle = (editingNote.title || "").trim();
    const currentTitle = editTitleInput.trim();
    const originalCats = [...(editingNote.categories || [])].sort();
    const currentCats = [...editCategories].sort();

    const isTitleChanged = originalTitle !== currentTitle;
    const isCatsChanged =
      originalCats.length !== currentCats.length ||
      originalCats.some((c, i) => c !== currentCats[i]);

    const hasChanges = isTitleChanged || isCatsChanged;

    if (hasChanges && confirmDiscardOnEdit) {
      setShowDiscardConfirmModal(true);
    } else {
      setEditingNote(null);
      setIsAddingCategoryInEdit(false);
      setInlineNewCategoryInEdit("");
    }
  };

  // 編集の破棄を確定して閉じる
  const handleConfirmDiscardEdit = () => {
    setShowDiscardConfirmModal(false);
    setEditingNote(null);
    setIsAddingCategoryInEdit(false);
    setInlineNewCategoryInEdit("");
  };

  // メモを保存する処理
  const handleSave = () => {
    const trimmedContent = truncateByCodePoints(content.trim(), MAX_NOTE_CONTENT_LENGTH);
    if (!trimmedContent) return;
    const trimmedTitle = truncateByCodePoints(title.trim(), MAX_NOTE_TITLE_LENGTH);

    const newNote: Note = {
      id: crypto.randomUUID(),
      title: trimmedTitle || undefined,
      content: trimmedContent,
      createdAt: new Date().toISOString(),
      isTrash: false,
      categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      remindAt: newNoteRemindAt || undefined,
      isLocked: newNoteIsLocked || undefined,
    };

    const updatedNotes = [newNote, ...notes];
    setNotes(updatedNotes);

    try {
      localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));
    } catch (e) {
      console.error("メモの保存に失敗しました", e);
    }

    // ログイン中ならSupabaseへ保存
    if (currentUser) {
      supabase
        .from("notes")
        .insert(mapNoteToDbRow(newNote, currentUser.id))
        .then(({ error }) => {
          if (error) console.error("クラウド保存エラー", error);
        });
    }

    // 入力欄をクリア
    setContent("");
    setTitle("");
    setSelectedCategories([]);
    setNewNoteRemindAt("");
    setNewNoteIsLocked(false);
    setIsAddingCategoryInline(false);
    setInlineNewCategoryName("");

    // 保存通知を表示（設定がONの場合）
    if (enableToast) {
      setToastMessage("🌱 保存しました");
      setShowToast(true);
      setTimeout(() => {
        setShowToast(false);
      }, 1500);
    }

    // チュートリアルStep 3（タイトル・タグ・保存体験）の場合、保存完了時に自動でStep 4へ進む
    if (tutorialStep === 3) {
      setTimeout(() => {
        handleNextTutorialStep();
      }, 700);
    }
  };

  // ゴミ箱へ移動する処理（※データは消さず、isTrashをtrueにするだけ）
  const handleMoveToTrash = (id: string) => {
    const updatedNotes = notes.map((note) =>
      note.id === id ? { ...note, isTrash: true } : note
    );
    setNotes(updatedNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser) {
      supabase.from("notes").update({ is_trash: true }).eq("id", id).then();
    }
    setActiveMenuNoteId(null); // メニューを閉じる
  };

  // ゴミ箱から元に戻す処理
  const handleRestoreFromTrash = (id: string) => {
    const updatedNotes = notes.map((note) =>
      note.id === id ? { ...note, isTrash: false } : note
    );
    setNotes(updatedNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser) {
      supabase.from("notes").update({ is_trash: false }).eq("id", id).then();
    }
  };

  // 通知設定の切り替え
  const handleToggleToast = (checked: boolean) => {
    setEnableToast(checked);
    localStorage.setItem("seednote_enable_toast", String(checked));
    saveCloudSettings({ enable_toast: checked }, true);
  };

  // 編集破棄時の確認設定の切り替え（フールプルーフ）
  const handleToggleConfirmDiscard = (checked: boolean) => {
    setConfirmDiscardOnEdit(checked);
    localStorage.setItem("seednote_confirm_discard", String(checked));
    saveCloudSettings({ confirm_discard: checked }, true);
  };

  // 文字サイズの切り替え
  const handleFontSizeChange = (size: FontSize) => {
    setFontSize(size);
    localStorage.setItem("seednote_font_size", size);
    saveCloudSettings({ font_size: size }, true);
  };

  // ボタンの大きさの切り替え
  const handleButtonSizeChange = (size: ButtonSize) => {
    setButtonSize(size);
    localStorage.setItem("seednote_button_size", size);
    saveCloudSettings({ button_size: size }, true);
  };

  // 長文メモの折りたたみ行数の切り替え
  const handleNoteCollapseLinesChange = (lines: NoteCollapseLines) => {
    setNoteCollapseLines(lines);
    localStorage.setItem("seednote_note_collapse_lines", String(lines));
    saveCloudSettings({ note_collapse_lines: lines }, true);
  };

  // 一覧・ゴミ箱メモ本文の展開・折りたたみ切り替え
  const handleToggleNoteBody = (noteId: string) => {
    setExpandedBodyNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  // Ctrl + Enter (または Cmd + Enter) で素早く保存
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  // あるメモが指定された時間帯に該当するか判定する関数（日付をまたぐ深夜帯にも対応）
  const isNoteInTimeSlot = (
    noteCreatedAt: string,
    slotKey: TimeSlotKey,
    slotsDef: Record<TimeSlotKey, TimeSlotConfig>
  ) => {
    const d = new Date(noteCreatedAt);
    const hour = d.getHours();
    const slot = slotsDef[slotKey];
    if (!slot) return false;
    if (slot.startHour <= slot.endHour) {
      return hour >= slot.startHour && hour <= slot.endHour;
    } else {
      // 日付をまたぐ場合（例: 23時〜4時）
      return hour >= slot.startHour || hour <= slot.endHour;
    }
  };

  // 時間帯設定の更新
  const handleUpdateTimeSlot = (
    key: TimeSlotKey,
    field: "startHour" | "endHour",
    value: number
  ) => {
    const updated = {
      ...timeSlots,
      [key]: {
        ...timeSlots[key],
        [field]: value,
      },
    };
    setTimeSlots(updated);
    localStorage.setItem("seednote_time_slots", JSON.stringify(updated));
    saveCloudSettings({ time_slots: updated }, false);
  };

  // 時間帯設定をデフォルトにリセット
  const handleResetTimeSlots = () => {
    setTimeSlots(DEFAULT_TIME_SLOTS);
    localStorage.removeItem("seednote_time_slots");
    saveCloudSettings({ time_slots: DEFAULT_TIME_SLOTS }, true);
  };

  // ある時間が指定された時間帯に含まれるか判定（0〜23）
  const isHourInSlotDef = (hour: number, slot: TimeSlotConfig) => {
    if (slot.startHour <= slot.endHour) {
      return hour >= slot.startHour && hour <= slot.endHour;
    } else {
      // 日付をまたぐ場合（例: 23時〜4時）
      return hour >= slot.startHour || hour <= slot.endHour;
    }
  };

  // 1時間単位での増減処理（0〜23を循環）
  const handleStepHour = (
    key: TimeSlotKey,
    field: "startHour" | "endHour",
    delta: number
  ) => {
    const current = timeSlots[key]?.[field] ?? DEFAULT_TIME_SLOTS[key][field];
    const nextVal = (current + delta + 24) % 24;
    handleUpdateTimeSlot(key, field, nextVal);
  };

  // タイムラインバーの各時間（0〜23）の背景スタイル（単色または斜線ストライプ）を算出
  const getHourBackgroundStyle = (hour: number) => {
    const active = (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[])
      .map((k) => timeSlots[k] || DEFAULT_TIME_SLOTS[k])
      .filter((s) => isHourInSlotDef(hour, s));

    if (active.length === 0) {
      return { backgroundColor: activeTheme.bgSub };
    }
    if (active.length === 1) {
      return { backgroundColor: active[0].color };
    }
    // 2つ以上の重複（重なりOK）：斜線ストライプパターン
    if (active.length === 2) {
      return {
        backgroundImage: `repeating-linear-gradient(135deg, ${active[0].color}, ${active[0].color} 6px, ${active[1].color} 6px, ${active[1].color} 12px)`,
      };
    }
    // 3つ以上の重複
    const stripeParts = active
      .map((s, idx) => `${s.color} ${idx * 5}px, ${s.color} ${(idx + 1) * 5}px`)
      .join(", ");
    return {
      backgroundImage: `repeating-linear-gradient(135deg, ${stripeParts})`,
    };
  };

  // 各時間帯の重複（重なり）している他の時間帯名を取得
  const getSlotOverlaps = (key: TimeSlotKey) => {
    const slot = timeSlots[key] || DEFAULT_TIME_SLOTS[key];
    const otherKeys = (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).filter(
      (k) => k !== key
    );
    const overlappingLabels: string[] = [];
    otherKeys.forEach((otherKey) => {
      const other = timeSlots[otherKey] || DEFAULT_TIME_SLOTS[otherKey];
      for (let h = 0; h < 24; h++) {
        if (isHourInSlotDef(h, slot) && isHourInSlotDef(h, other)) {
          overlappingLabels.push(other.label);
          break;
        }
      }
    });
    return overlappingLabels;
  };

  // 日時を読みやすい形式に変換する関数
  const formatDate = (isoString: string) => {
    const d = new Date(isoString);
    const month = d.getMonth() + 1;
    const date = d.getDate();
    const hours = d.getHours().toString().padStart(2, "0");
    const minutes = d.getMinutes().toString().padStart(2, "0");
    return `${month}月${date}日 ${hours}:${minutes}`;
  };

  // 見返す日（リマインダー）の設定・変更・完了処理
  const handleSetNoteReminder = (noteId: string, nextRemindAt?: string) => {
    const normalized = nextRemindAt?.trim() || undefined;
    const updatedNotes = notes.map((note) =>
      note.id === noteId ? { ...note, remindAt: normalized } : note
    );
    setNotes(updatedNotes);
    try {
      localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));
    } catch (e) {
      console.error("リマインダーの保存に失敗しました", e);
    }

    if (currentUser) {
      supabase
        .from("notes")
        .update({ remind_at: normalized ?? null })
        .eq("id", noteId)
        .then(({ error }) => {
          if (error) console.warn("リマインダーのクラウド更新に失敗しました:", error.message);
        });
    }

    if (enableToast) {
      setToastMessage(normalized ? "🔔 見返す日を設定しました" : "✓ リマインダーを完了しました");
      setShowToast(true);
      setTimeout(() => {
        setShowToast(false);
      }, 1500);
    }
  };

  const handleOpenReminderModal = (note: Note) => {
    setReminderTargetNote(note);
    setReminderDateInput(note.remindAt || getLocalYmd(1));
    setActiveMenuNoteId(null);
  };

  // 鍵付きメモの本文が表示可能か判定
  const isNoteContentVisible = (note: Note) =>
    !note.isLocked || unlockedNoteIds.includes(note.id);

  // 鍵付きメモ関連の設定をクラウドへ同期
  const saveLockSettingsToCloud = (
    partial: Partial<{
      lock_password_hash: string;
      mask_locked_title: boolean;
      auto_lock_mode: AutoLockMode;
    }>
  ) => {
    if (!currentUser) return;
    supabase
      .from("user_settings")
      .update({
        ...partial,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", currentUser.id)
      .then(({ error }) => {
        if (error) console.warn("鍵設定のクラウド保存エラー:", error.message);
      });
  };

  const handleChangeMaskLockedTitle = (nextVal: boolean) => {
    setMaskLockedTitle(nextVal);
    localStorage.setItem("seednote_mask_locked_title", String(nextVal));
    saveLockSettingsToCloud({ mask_locked_title: nextVal });
  };

  const handleChangeAutoLockMode = (nextMode: AutoLockMode) => {
    setAutoLockMode(nextMode);
    localStorage.setItem("seednote_auto_lock_mode", nextMode);
    saveLockSettingsToCloud({ auto_lock_mode: nextMode });
  };

  const openLockModal = (
    mode: "unlock" | "setup" | "change" | "forgot",
    options?: {
      unlockNoteId?: string | null;
      action?:
        | { type: "toggleComposeLock" }
        | { type: "lockExistingNote"; noteId: string }
        | { type: "removeNoteLock"; noteId: string }
        | null;
    }
  ) => {
    setLockModalMode(mode);
    setPendingUnlockNoteId(options?.unlockNoteId ?? null);
    setPendingLockAction(options?.action ?? null);
    setLockInput1("");
    setLockInput2("");
    setLockInput3("");
    setShowLockInput1(false);
    setShowLockInput2(false);
    setShowLockInput3(false);
    setLockModalError(null);
    setIsLockModalBusy(false);
  };

  const closeLockModal = () => {
    setLockModalMode(null);
    setPendingUnlockNoteId(null);
    setPendingLockAction(null);
    setLockInput1("");
    setLockInput2("");
    setLockInput3("");
    setShowLockInput1(false);
    setShowLockInput2(false);
    setShowLockInput3(false);
    setLockModalError(null);
    setIsLockModalBusy(false);
  };

  const handleSetNoteLock = (noteId: string, nextLocked: boolean) => {
    const updatedNotes = notes.map((note) =>
      note.id === noteId ? { ...note, isLocked: nextLocked ? true : undefined } : note
    );
    setNotes(updatedNotes);
    try {
      localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));
    } catch (e) {
      console.error("鍵状態の保存に失敗しました", e);
    }

    if (nextLocked) {
      setUnlockedNoteIds((prev) => prev.filter((id) => id !== noteId));
      setExpandedHistoryNoteIds((prev) => prev.filter((id) => id !== noteId));
      setExpandedReplyNoteIds((prev) => prev.filter((id) => id !== noteId));
      if (replyingNoteId === noteId) {
        setReplyingNoteId(null);
        setReplyContent("");
      }
    } else {
      setUnlockedNoteIds((prev) => prev.filter((id) => id !== noteId));
    }

    if (currentUser) {
      supabase
        .from("notes")
        .update({ is_locked: nextLocked })
        .eq("id", noteId)
        .then(({ error }) => {
          if (error) console.warn("鍵状態のクラウド更新に失敗しました:", error.message);
        });
    }

    setToastMessage(nextLocked ? "🔒 メモに鍵をつけました" : "🔓 メモの鍵を外しました");
    setShowToast(true);
    setTimeout(() => setShowToast(false), 1800);
  };

  const handleToggleComposeLock = () => {
    if (newNoteIsLocked) {
      setNewNoteIsLocked(false);
      return;
    }
    if (!lockPasswordHash) {
      openLockModal("setup", { action: { type: "toggleComposeLock" } });
      return;
    }
    setNewNoteIsLocked(true);
  };

  const handleToggleNoteLock = (note: Note) => {
    setActiveMenuNoteId(null);
    if (!note.isLocked) {
      if (!lockPasswordHash) {
        openLockModal("setup", { action: { type: "lockExistingNote", noteId: note.id } });
        return;
      }
      handleSetNoteLock(note.id, true);
      return;
    }
    if (!isNoteContentVisible(note)) {
      if (!lockPasswordHash) {
        handleSetNoteLock(note.id, false);
        return;
      }
      openLockModal("unlock", { action: { type: "removeNoteLock", noteId: note.id } });
      return;
    }
    handleSetNoteLock(note.id, false);
  };

  const handleRequestUnlockNote = (noteId: string) => {
    if (!lockPasswordHash) {
      setUnlockedNoteIds((prev) => (prev.includes(noteId) ? prev : [...prev, noteId]));
      setIsLockSessionVerified(true);
      return;
    }
    if (isLockSessionVerified) {
      setUnlockedNoteIds((prev) => (prev.includes(noteId) ? prev : [...prev, noteId]));
      return;
    }
    openLockModal("unlock", { unlockNoteId: noteId });
  };

  const handleHideUnlockedNote = (noteId: string) => {
    setUnlockedNoteIds((prev) => prev.filter((id) => id !== noteId));
    setExpandedHistoryNoteIds((prev) => prev.filter((id) => id !== noteId));
    setExpandedReplyNoteIds((prev) => prev.filter((id) => id !== noteId));
    if (replyingNoteId === noteId) {
      setReplyingNoteId(null);
      setReplyContent("");
    }
  };

  const handleSubmitLockModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLockModalBusy) return;
    setLockModalError(null);

    if (lockModalMode === "unlock") {
      const entered = lockInput1.trim();
      if (!entered) {
        setLockModalError("鍵メモ用パスワードを入力してください");
        return;
      }
      const enteredHash = hashLockPassword(entered);
      if (enteredHash !== lockPasswordHash) {
        setLockModalError("パスワードが正しくありません");
        return;
      }
      setIsLockSessionVerified(true);
      if (pendingUnlockNoteId) {
        setUnlockedNoteIds((prev) =>
          prev.includes(pendingUnlockNoteId) ? prev : [...prev, pendingUnlockNoteId]
        );
      }
      const pendingActionCopy = pendingLockAction;
      closeLockModal();
      if (pendingActionCopy?.type === "removeNoteLock") {
        handleSetNoteLock(pendingActionCopy.noteId, false);
      }
      return;
    }

    if (lockModalMode === "setup") {
      const nextPass = lockInput1.trim();
      const confirmPass = lockInput2.trim();
      if (nextPass.length < 4 || nextPass.length > MAX_PASSWORD_LENGTH) {
        setLockModalError(`4〜${MAX_PASSWORD_LENGTH}文字で設定してください`);
        return;
      }
      if (nextPass !== confirmPass) {
        setLockModalError("確認用パスワードと一致しません");
        return;
      }
      const nextHash = hashLockPassword(nextPass);
      setLockPasswordHash(nextHash);
      localStorage.setItem("seednote_lock_password_hash", nextHash);
      saveLockSettingsToCloud({ lock_password_hash: nextHash });

      const pendingActionCopy = pendingLockAction;
      closeLockModal();
      if (pendingActionCopy?.type === "toggleComposeLock") {
        setNewNoteIsLocked(true);
      } else if (pendingActionCopy?.type === "lockExistingNote") {
        handleSetNoteLock(pendingActionCopy.noteId, true);
      }
      setToastMessage("🔐 鍵メモ用パスワードを設定しました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
      return;
    }

    if (lockModalMode === "change") {
      const curPass = lockInput1.trim();
      const nextPass = lockInput2.trim();
      const confirmPass = lockInput3.trim();
      if (!curPass) {
        setLockModalError("現在の鍵メモ用パスワードを入力してください");
        return;
      }
      if (hashLockPassword(curPass) !== lockPasswordHash) {
        setLockModalError("現在のパスワードが正しくありません");
        return;
      }
      if (nextPass.length < 4 || nextPass.length > MAX_PASSWORD_LENGTH) {
        setLockModalError(`新しいパスワードは4〜${MAX_PASSWORD_LENGTH}文字で入力してください`);
        return;
      }
      if (nextPass !== confirmPass) {
        setLockModalError("新しいパスワードが一致しません");
        return;
      }
      const nextHash = hashLockPassword(nextPass);
      setLockPasswordHash(nextHash);
      localStorage.setItem("seednote_lock_password_hash", nextHash);
      saveLockSettingsToCloud({ lock_password_hash: nextHash });
      closeLockModal();
      setToastMessage("🔐 鍵メモ用パスワードを変更しました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
      return;
    }

    if (lockModalMode === "forgot") {
      if (!currentUser || !currentUsername) {
        setLockModalError("ログイン中のみアカウントパスワードでの再設定が可能です");
        return;
      }
      const accountPass = lockInput1.trim();
      const nextPass = lockInput2.trim();
      const confirmPass = lockInput3.trim();
      if (!accountPass) {
        setLockModalError("アカウントのパスワードを入力してください");
        return;
      }
      if (nextPass.length < 4 || nextPass.length > MAX_PASSWORD_LENGTH) {
        setLockModalError(`新しい鍵パスワードは4〜${MAX_PASSWORD_LENGTH}文字で入力してください`);
        return;
      }
      if (nextPass !== confirmPass) {
        setLockModalError("新しい鍵パスワードが一致しません");
        return;
      }
      setIsLockModalBusy(true);
      try {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: getInternalEmail(currentUsername),
          password: accountPass,
        });
        if (error || !data.user) {
          setLockModalError("アカウントのパスワードが正しくありません");
          return;
        }
        const nextHash = hashLockPassword(nextPass);
        setLockPasswordHash(nextHash);
        localStorage.setItem("seednote_lock_password_hash", nextHash);
        saveLockSettingsToCloud({ lock_password_hash: nextHash });
        closeLockModal();
        setToastMessage("🔐 鍵メモ用パスワードを再設定しました");
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2000);
      } catch {
        setLockModalError("通信エラーが発生しました。接続をご確認ください。");
      } finally {
        setIsLockModalBusy(false);
      }
    }
  };

  // お気に入りの切り替え（☆ ⇄ ★）
  const handleToggleFavorite = (id: string) => {
    let nextFav = false;
    const updatedNotes = notes.map((note) => {
      if (note.id === id) {
        nextFav = !note.isFavorite;
        return { ...note, isFavorite: nextFav };
      }
      return note;
    });
    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser) {
      supabase.from("notes").update({ is_favorite: nextFav }).eq("id", id).then();
    }
  };

  // メモへの追記（リプライ）を保存（大元のメモにぶら下がる不可逆ログ）
  const handleAddReply = (parentNoteId: string) => {
    const trimmedReply = truncateByCodePoints(replyContent.trim(), MAX_NOTE_CONTENT_LENGTH);
    if (!trimmedReply) return;
    const newReply: NoteReply = {
      id: crypto.randomUUID(),
      content: trimmedReply,
      createdAt: new Date().toISOString(),
    };
    let updatedReplies: NoteReply[] = [];
    const updatedNotes = notes.map((n) => {
      if (n.id === parentNoteId) {
        updatedReplies = [...(n.replies || []), newReply];
        return {
          ...n,
          replies: updatedReplies,
        };
      }
      return n;
    });
    setNotes(updatedNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser && updatedReplies.length > 0) {
      supabase.from("notes").update({ replies: updatedReplies }).eq("id", parentNoteId).then();
    }

    setReplyContent("");
    setReplyingNoteId(null);
    // 追記した直後はそのメモの追記スレッドを展開して確認できるようにする
    setExpandedReplyNoteIds((prev) =>
      prev.includes(parentNoteId) ? prev : [...prev, parentNoteId]
    );
    if (enableToast) {
      setToastMessage("💬 追記を保存しました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    }
  };

  // 追記スレッドの展開・折りたたみ切り替え（デフォルトは折りたたみ）
  const handleToggleReplies = (noteId: string) => {
    setExpandedReplyNoteIds((prev) =>
      prev.includes(noteId)
        ? prev.filter((id) => id !== noteId)
        : [...prev, noteId]
    );
  };

  // メモのワンタッチコピー（タイトル＋本文をクリップボードにコピー）
  const handleCopyNote = async (note: Note) => {
    if (!isNoteContentVisible(note)) {
      handleRequestUnlockNote(note.id);
      return;
    }
    try {
      const baseText = note.title ? `【${note.title}】\n${note.content}` : note.content;
      const repliesText =
        note.replies && note.replies.length > 0
          ? `\n\n--- 追記 ---\n${note.replies.map((r) => r.content).join("\n\n")}`
          : "";
      const textToCopy = `${baseText}${repliesText}`;
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = textToCopy;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setToastMessage("📋 クリップボードにコピーしました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    } catch (err) {
      console.error("コピーに失敗しました", err);
      setToastMessage("コピーに失敗しました");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    }
  };

  // 訂正履歴アコーディオンの展開・折りたたみ切り替え
  const handleToggleEditHistory = (noteId: string) => {
    setExpandedHistoryNoteIds((prev) =>
      prev.includes(noteId) ? prev.filter((id) => id !== noteId) : [...prev, noteId]
    );
  };

  // 本文訂正モーダルを開く
  const handleOpenContentEditModal = (note: Note) => {
    setEditingContentNote(note);
    setEditContentInput(note.content);
    setActiveMenuNoteId(null);
  };

  // 本文訂正を保存（思考の不可逆性を保つため過去の文章を履歴として保持）
  const handleSaveContentEdit = async () => {
    if (!editingContentNote) return;
    const trimmed = truncateByCodePoints(editContentInput.trim(), MAX_NOTE_CONTENT_LENGTH);
    if (!trimmed) return;

    // 変更がない場合はそのまま閉じる
    if (trimmed === editingContentNote.content.trim()) {
      setEditingContentNote(null);
      return;
    }

    const historyItem: NoteEditHistory = {
      id: "eh_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 7),
      previousContent: editingContentNote.content,
      editedAt: new Date().toISOString(),
    };

    const updatedHistory = [historyItem, ...(editingContentNote.editHistory || [])];
    const updatedNote: Note = {
      ...editingContentNote,
      content: trimmed,
      editHistory: updatedHistory,
    };

    const newNotes = notes.map((n) => (n.id === updatedNote.id ? updatedNote : n));
    setNotes(newNotes);
    safeSetLocalStorage("seednote_items", JSON.stringify(newNotes));
    setEditingContentNote(null);

    setToastMessage("✏️ 本文を訂正しました（過去の文章も保存されています）");
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2500);

    // クラウド（Supabase）に反映
    if (currentUser) {
      try {
        const { error } = await supabase
          .from("notes")
          .update({
            content: updatedNote.content,
            edit_history: updatedHistory,
          })
          .eq("id", updatedNote.id);

        if (error) {
          // edit_history カラムが未追加のDB環境でも本文の更新は確実に成功させるフォールバック
          console.warn("Supabase edit_history 更新フォールバック:", error.message);
          await supabase
            .from("notes")
            .update({
              content: updatedNote.content,
            })
            .eq("id", updatedNote.id);
        }
      } catch (err) {
        console.error("クラウド同期エラー:", err);
      }
    }
  };

  const hasContent = content.trim().length > 0 || title.trim().length > 0;
  const activeNotes = notes.filter((n) => !n.isTrash);
  const trashNotes = notes.filter((n) => n.isTrash);

  const todayYmd = getLocalYmd(0);
  const reminderActiveNotes = activeNotes
    .filter((n) => Boolean(n.remindAt))
    .sort((a, b) => (a.remindAt || "").localeCompare(b.remindAt || ""));
  const dueReminderNotes = reminderActiveNotes.filter((n) => (n.remindAt || "") <= todayYmd);
  const upcomingReminderNotes = reminderActiveNotes.filter((n) => (n.remindAt || "") > todayYmd);

  const handleJumpToReminderNote = (noteId: string) => {
    setFilterOnlyFavorite(false);
    setFilterOnlyLocked(false);
    setFilterCategories([]);
    setIncludeTrashInSearch(false);
    setSearchQuery("");
    setFilterTimeSlots([]);
    setFilterDate("");
    setIsReminderPanelOpen(false);
    setTimeout(() => {
      const target = document.querySelector(`[data-note-id="${noteId}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  };

  // 通常一覧の対象メモ（ゴミ箱も含めるフラグがONなら全体、OFFなら通常メモのみ）
  const baseNotesForList = includeTrashInSearch ? notes : activeNotes;

  // 検索・絞り込み適用後のメモ一覧（複数AND検索＆キーワード検索＆日付検索対応）
  const displayedNotes = baseNotesForList.filter((note) => {
    if (filterOnlyFavorite && !note.isFavorite) return false;
    if (filterOnlyLocked && !note.isLocked) return false;
    if (filterCategories.length > 0) {
      const matchesAll = filterCategories.every((cat) => {
        if (cat === "uncategorized") {
          return !note.categories || note.categories.length === 0;
        }
        return note.categories && note.categories.includes(cat);
      });
      if (!matchesAll) return false;
    }
    if (searchQuery.trim()) {
      if (!isNoteContentVisible(note)) return false;
      const q = searchQuery.trim().toLowerCase();
      const matchTitle = note.title?.toLowerCase().includes(q) ?? false;
      const matchContent = note.content.toLowerCase().includes(q);
      const matchReplies = note.replies?.some((r) => r.content.toLowerCase().includes(q)) ?? false;
      if (!matchTitle && !matchContent && !matchReplies) return false;
    }
    // 時間帯フィルター（選択された時間帯のいずれかに合致：論理和 OR）
    if (filterTimeSlots.length > 0) {
      const matchTime = filterTimeSlots.some((slotKey) =>
        isNoteInTimeSlot(note.createdAt, slotKey, timeSlots)
      );
      if (!matchTime) return false;
    }
    // 日付フィルター（指定された日付 YYYY-MM-DD と作成日の年月日一致）
    if (filterDate) {
      const noteDate = new Date(note.createdAt).toLocaleDateString("sv-SE");
      if (noteDate !== filterDate) return false;
    }
    return true;
  });

  // ゴミ箱画面用の検索・絞り込み適用後メモ一覧（キーワード検索対応）
  const displayedTrashNotes = trashNotes.filter((note) => {
    if (trashFilterOnlyFavorite && !note.isFavorite) return false;
    if (trashFilterCategories.length > 0) {
      const matchesAll = trashFilterCategories.every((cat) => {
        if (cat === "uncategorized") {
          return !note.categories || note.categories.length === 0;
        }
        return note.categories && note.categories.includes(cat);
      });
      if (!matchesAll) return false;
    }
    if (trashSearchQuery.trim()) {
      if (!isNoteContentVisible(note)) return false;
      const q = trashSearchQuery.trim().toLowerCase();
      const matchTitle = note.title?.toLowerCase().includes(q) ?? false;
      const matchContent = note.content.toLowerCase().includes(q);
      const matchReplies = note.replies?.some((r) => r.content.toLowerCase().includes(q)) ?? false;
      if (!matchTitle && !matchContent && !matchReplies) return false;
    }
    return true;
  });

  return (
    <div
      className="min-h-screen flex flex-col justify-between p-4 sm:p-8 relative overflow-x-hidden transition-colors duration-300"
      style={{
        backgroundColor: activeTheme.bgApp,
        color: activeTheme.textPrimary,
        fontFamily: getFontFamilyStyle(fontFamily),
      }}
    >
      {/* メニューが開いている時に画面のどこを触っても確実に閉じる透明な膜 */}
      {activeMenuNoteId && (
        <div
          className="fixed inset-0 z-20 cursor-default"
          onClick={() => setActiveMenuNoteId(null)}
        />
      )}

      {/* 通知トースト（画面下部の中央に表示し、ヘッダーのボタンと重ならないようにする） */}
      <div
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 pointer-events-none ${
          showToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
        }`}
      >
        <div
          className="px-4 py-2 rounded-full text-xs font-medium shadow-lg flex items-center gap-1.5 transition-colors"
          style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
        >
          {toastMessage}
        </div>
      </div>

      {/* 画面上部ヘッダー（手描きスケッチの上部） */}
      <header className="flex justify-between items-center max-w-xl w-full mx-auto pt-2">
        {/* 左上：ハンバーガーメニューボタン ≡ */}
        <button
          id="tutorial-target-menu"
          type="button"
          onClick={() => setIsMenuOpen(true)}
          className={`relative ${
            buttonSize === "large" ? "w-11 h-11 text-2xl" : "w-9 h-9 text-xl"
          } flex items-center justify-center rounded-xl transition-all border`}
          style={{
            backgroundColor: activeTheme.bgSub,
            borderColor: activeTheme.border,
            color: activeTheme.textSecondary,
          }}
          aria-label="メニューを開く"
        >
          <span className="leading-none">≡</span>
          {unreadAnnouncementsCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
              style={{
                backgroundColor: "#c96256",
                borderColor: activeTheme.bgApp,
              }}
              aria-label={`未読のお知らせが${unreadAnnouncementsCount}件あります`}
            />
          )}
        </button>

        {/* 中央：書く / 見る クイックアクセス切り替え（カプセル型） */}
        <div
          id="tutorial-target-switch"
          className="flex items-center p-0.5 rounded-xl border transition-colors"
          style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
        >
          <button
            type="button"
            onClick={() => setActiveTab("home")}
            className={`flex items-center gap-1 ${
              buttonSize === "large" ? "px-3.5 py-1.5 text-xs" : "px-3 py-1 text-xs"
            } rounded-lg font-bold transition-all`}
            style={{
              backgroundColor: activeTab === "home" ? activeTheme.accent : "transparent",
              color: activeTab === "home" ? activeTheme.accentText : activeTheme.textSecondary,
            }}
            aria-label="メモを書く画面へ"
          >
            <span>✏️</span> 書く
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("list")}
            className={`flex items-center gap-1 ${
              buttonSize === "large" ? "px-3.5 py-1.5 text-xs" : "px-3 py-1 text-xs"
            } rounded-lg font-bold transition-all`}
            style={{
              backgroundColor: activeTab === "list" ? activeTheme.accent : "transparent",
              color: activeTab === "list" ? activeTheme.accentText : activeTheme.textSecondary,
            }}
            aria-label="メモを見る画面へ"
          >
            <span>📋</span> 見る
          </button>
        </div>

        {/* 右上：ガイド・ヘルプボタン ？ */}
        <button
          id="tutorial-target-help"
          type="button"
          onClick={() => setIsHelpOpen(true)}
          className={`${
            buttonSize === "large" ? "w-10 h-10 text-sm" : "w-8 h-8 text-xs"
          } flex items-center justify-center rounded-full font-bold border transition-all`}
          style={{
            backgroundColor: activeTheme.bgSub,
            borderColor: activeTheme.border,
            color: activeTheme.textSecondary,
          }}
          aria-label="ガイド・ヘルプを開く"
        >
          ?
        </button>
      </header>

      {/* スライドメニュー（ドロワー） & 背景の暗幕 */}
      {isMenuOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-[1px] z-40 transition-opacity"
          onClick={() => setIsMenuOpen(false)}
        />
      )}
      <aside
        id="tutorial-target-menu-aside"
        className={`fixed top-0 left-0 bottom-0 w-64 z-50 shadow-xl border-r flex flex-col justify-between p-6 transition-transform duration-300 ease-out ${
          isMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{
          backgroundColor: activeTheme.bgApp,
          borderColor: activeTheme.border,
          color: activeTheme.textPrimary,
        }}
      >
        <div>
          <div className="flex items-center justify-between mb-6 pb-3 border-b" style={{ borderColor: activeTheme.border }}>
            <div>
              <h2 className="font-bold text-base flex items-center gap-2" style={{ color: activeTheme.textPrimary }}>
                <img src="/icon.svg" alt="ライトNote" className="w-6 h-6 rounded-md shadow-2xs shrink-0" />
                <span>ライトNote</span>
              </h2>
              <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>メニュー</span>
            </div>
            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              className={`${
                buttonSize === "large" ? "p-2 text-sm" : "px-2 py-1 text-xs"
              } hover:opacity-70 transition-opacity`}
              style={{ color: activeTheme.textSecondary }}
            >
              ✕
            </button>
          </div>

          {/* クラウド同期・アカウント状態 */}
          <div
            className="mb-5 p-3 rounded-xl border shadow-2xs transition-colors"
            style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
          >
            {currentUser ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-[#529961] shrink-0" />
                    <span
                      className="text-xs font-bold truncate"
                      style={{ color: activeTheme.textPrimary }}
                    >
                      {currentUsername || "ログイン中"}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#529961] bg-[#eef6f0] px-1.5 py-0.5 rounded font-medium shrink-0">
                    同期中
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-1 border-t" style={{ borderColor: activeTheme.border }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (currentUser) fetchCloudNotes(currentUser.id);
                    }}
                    disabled={isSyncing}
                    className="flex-1 py-1 px-2 rounded-lg border text-[11px] font-medium transition-colors flex items-center justify-center gap-1 hover:opacity-85"
                    style={{
                      backgroundColor: activeTheme.bgCard,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  >
                    <span>🔄</span> {isSyncing ? "同期中..." : "今すぐ同期"}
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="py-1 px-2 rounded-lg hover:bg-[#fdeeed] text-[11px] font-medium text-[#b85448] transition-colors"
                  >
                    ログアウト
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIsAuthModalOpen(true);
                  setIsMenuOpen(false);
                }}
                className="w-full text-left group"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                    <span>🔐</span> クラウド同期
                  </span>
                  <span className="text-[10px]" style={{ color: activeTheme.textSecondary }}>
                    ログイン ›
                  </span>
                </div>
                <p className="text-[11px] mt-0.5 leading-snug" style={{ color: activeTheme.textSecondary }}>
                  PCとスマホでメモを同期（※IDとパスワードのみ）
                </p>
              </button>
            )}
          </div>

          <nav className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => {
                setActiveTab("home");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left`}
              style={{
                backgroundColor: activeTab === "home" ? activeTheme.bgSub : "transparent",
                color: activeTab === "home" ? activeTheme.textPrimary : activeTheme.textSecondary,
              }}
            >
              <div className="flex items-center gap-3">
                <span>✏️</span> メモを書く
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab("list");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left`}
              style={{
                backgroundColor: activeTab === "list" ? activeTheme.bgSub : "transparent",
                color: activeTab === "list" ? activeTheme.textPrimary : activeTheme.textSecondary,
              }}
            >
              <div className="flex items-center gap-3">
                <span>📋</span> メモを見る
              </div>
              <span
                className="text-xs px-2 py-0.5 rounded-full border"
                style={{
                  backgroundColor: activeTheme.bgApp,
                  borderColor: activeTheme.border,
                  color: activeTheme.textSecondary,
                }}
              >
                {activeNotes.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab("categories");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left`}
              style={{
                backgroundColor: activeTab === "categories" ? activeTheme.bgSub : "transparent",
                color: activeTab === "categories" ? activeTheme.textPrimary : activeTheme.textSecondary,
              }}
            >
              <div className="flex items-center gap-3">
                <span>🏷️</span> カテゴリ管理
              </div>
              {categoriesList.length > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full border"
                  style={{
                    backgroundColor: activeTheme.bgApp,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  {categoriesList.length}
                </span>
              )}
            </button>

            <div className="my-2 border-t" style={{ borderColor: activeTheme.border }} />

            <button
              type="button"
              onClick={() => {
                setActiveTab("trash");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left`}
              style={{
                backgroundColor: activeTab === "trash" ? activeTheme.bgSub : "transparent",
                color: activeTab === "trash" ? activeTheme.textPrimary : activeTheme.textSecondary,
              }}
            >
              <div className="flex items-center gap-3">
                <span>🗑️</span> ゴミ箱
              </div>
              {trashNotes.length > 0 && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full border"
                  style={{
                    backgroundColor: activeTheme.bgApp,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  {trashNotes.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleOpenAnnouncements}
              className={`w-full flex items-center justify-between ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left hover:opacity-80`}
              style={{
                backgroundColor: "transparent",
                color: unreadAnnouncementsCount > 0 ? activeTheme.textPrimary : activeTheme.textSecondary,
              }}
            >
              <div className="flex items-center gap-3">
                <span>📢</span> 運営からのお知らせ
              </div>
              {unreadAnnouncementsCount > 0 && (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: "#c96256",
                    color: "#ffffff",
                  }}
                >
                  新着 {unreadAnnouncementsCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setIsHelpOpen(true);
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left hover:opacity-80`}
              style={{
                backgroundColor: "transparent",
                color: activeTheme.textSecondary,
              }}
            >
              <span>❓</span> ガイド・ヘルプ
            </button>

            <button
              type="button"
              onClick={() => {
                setIsTermsOpen(true);
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left hover:opacity-80`}
              style={{
                backgroundColor: "transparent",
                color: activeTheme.textSecondary,
              }}
            >
              <span className="shrink-0">📜</span>
              <div className="flex flex-col text-left leading-tight">
                <span>利用規約・</span>
                <span>プライバシー</span>
              </div>
            </button>
          </nav>
        </div>

        {/* 最下部：設定ボタン（区切り線で独立） ＆ バージョン */}
        <div className="pt-3 border-t flex flex-col gap-1.5" style={{ borderColor: activeTheme.border }}>
          <button
            type="button"
            onClick={() => {
              setActiveTab("settings");
              setIsMenuOpen(false);
            }}
            className={`w-full flex items-center gap-3 ${
              buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
            } rounded-xl font-medium transition-colors text-left`}
            style={{
              backgroundColor: activeTab === "settings" ? activeTheme.bgSub : "transparent",
              color: activeTab === "settings" ? activeTheme.textPrimary : activeTheme.textSecondary,
            }}
          >
            <span>⚙️</span> 設定
          </button>
          <div
            className="text-[11px] text-center pt-1"
            style={{ color: activeTheme.textSecondary }}
          >
            ライトNote v0.2
          </div>
        </div>
      </aside>

      {/* メイン画面コンテンツ（タブによって切り替え） */}
      <main
        className={`max-w-xl w-full mx-auto flex-1 flex flex-col min-w-0 ${
          tutorialStep === 2 || tutorialStep === 3
            ? "justify-start pt-2 pb-72 sm:pb-6"
            : "justify-center py-3 sm:py-5"
        } min-h-0`}
      >
        {/* ① ホーム（メモ入力：ノイズゼロのメイン空間） */}
        {activeTab === "home" && (
          <div className="relative pt-3.5" id="tutorial-target-input">
            {/* 上部に通る真円スパイラルリング（ピタゴラス真円・穴のど真ん中に完全一致：計8個） */}
            <svg
              className="absolute top-0 left-1/2 -translate-x-1/2 w-[90%] max-w-[364px] h-7 z-10 pointer-events-none"
              viewBox="-30 0 260 28"
              fill="none"
              aria-hidden="true"
            >
              {[-5, 25, 55, 85, 115, 145, 175, 205].map((hx) => (
                <g key={hx}>
                  {/* カード上部のパンチ穴（上辺y=14から6px内側、完全左右対称） */}
                  <circle
                    cx={hx}
                    cy={20}
                    r={2.6}
                    fill={activeTheme.bgApp}
                    stroke={activeTheme.border}
                    strokeWidth="0.9"
                  />
                  {/* 真円スパイラルループ（半径6.5、中心(hx+2.5, 14) → 始点(hx, 20)が穴の中心に100%一致） */}
                  <path
                    d={`M ${hx} 20 A 6.5 6.5 0 0 1 ${hx - 4} 14 A 6.5 6.5 0 0 1 ${hx + 8.5} 11.5`}
                    stroke={activeTheme.accent}
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  />
                </g>
              ))}
            </svg>

            <div
              className="relative rounded-2xl p-6 sm:p-8 pt-7 sm:pt-8 shadow-sm border transition-all"
              style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            >
            {/* 本文に文字が入った時（またはチュートリアルStep 3）だけ現れるタイトル欄 */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-out ${
                hasContent || tutorialStep === 3
                  ? "max-h-16 opacity-100 mb-3"
                  : "max-h-0 opacity-0 mb-0 pointer-events-none"
              }`}
            >
              <div>
                <input
                  type="text"
                  placeholder="タイトル（省略可）"
                  maxLength={MAX_NOTE_TITLE_LENGTH}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={`w-full ${
                    fontSize === "large" ? "px-4 py-2.5 text-base" : "px-3.5 py-2 text-sm"
                  } rounded-xl border focus:outline-none transition-colors`}
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                  }}
                />
                <LengthLimitHint
                  length={title.length}
                  maxLength={MAX_NOTE_TITLE_LENGTH}
                  warnThreshold={NOTE_TITLE_WARN_THRESHOLD}
                  kind="title"
                  theme={activeTheme}
                />
              </div>
            </div>

            {/* 本文入力欄（文字はゼロ、薄い鉛筆マークのみ） */}
            <div className={`relative transition-all ${tutorialStep === 3 ? "min-h-[60px]" : "min-h-[160px]"}`}>
              {!content && (
                <div
                  className="absolute top-2 left-2 pointer-events-none select-none text-2xl sm:text-3xl transition-opacity opacity-40"
                  style={{ color: activeTheme.textSecondary }}
                >
                  ✏️
                </div>
              )}
              <textarea
                ref={noteTextareaRef}
                rows={tutorialStep === 3 ? 2 : 6}
                placeholder=""
                maxLength={MAX_NOTE_CONTENT_LENGTH}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus={tutorialStep === null}
                className={`w-full ${
                  fontSize === "large" ? "text-lg sm:text-xl" : "text-base"
                } bg-transparent border-0 focus:outline-none resize-none leading-relaxed relative z-10`}
                style={{
                  color: activeTheme.textPrimary,
                  fontFamily: getNoteFontFamilyStyle(noteFont),
                }}
              />
              <LengthLimitHint
                length={content.length}
                maxLength={MAX_NOTE_CONTENT_LENGTH}
                warnThreshold={NOTE_LENGTH_WARN_THRESHOLD}
                kind="body"
                theme={activeTheme}
              />
            </div>

            {/* 本文に文字が入った時だけ現れる下部エリア（左：カテゴリ選択、右：保存ボタン） */}
            <div
              id="tutorial-target-meta"
              className={`overflow-hidden transition-all duration-300 ease-out border-t pt-3 mt-1 ${
                hasContent || tutorialStep === 3
                  ? "max-h-96 opacity-100"
                  : "max-h-0 opacity-0 pointer-events-none pt-0 mt-0 border-t-0"
              }`}
              style={{ borderColor: activeTheme.border }}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                {/* カテゴリ選択エリア */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs flex-1">
                  <span
                    className="flex items-center gap-1 text-[11px] font-medium mr-0.5 select-none"
                    style={{ color: activeTheme.textSecondary }}
                  >
                    🏷️ カテゴリ:
                  </span>

                  {/* 登録済みカテゴリチップ（並び順設定を反映） */}
                  {sortedCategories.map((cat) => {
                    const isSelected = selectedCategories.includes(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => handleToggleCategory(cat.id)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                          isSelected ? "shadow-xs font-bold" : "border"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgSub,
                          borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {cat.name}
                      </button>
                    );
                  })}

                  {/* インライン新規追加フォーム or 「＋ 新規」ボタン */}
                  {isAddingCategoryInline ? (
                    <div
                      className="flex items-center gap-1 p-0.5 rounded-lg border"
                      style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                    >
                      <input
                        type="text"
                        placeholder="新しいカテゴリ"
                        maxLength={MAX_CATEGORY_NAME_LENGTH}
                        value={inlineNewCategoryName}
                        onChange={(e) => setInlineNewCategoryName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSaveInlineCategory();
                          }
                        }}
                        autoFocus
                        className="px-2 py-0.5 text-xs bg-transparent focus:outline-none w-28"
                        style={{ color: activeTheme.textPrimary }}
                      />
                      <button
                        type="button"
                        onClick={handleSaveInlineCategory}
                        className="px-2 py-0.5 rounded-md text-[11px] font-medium transition-opacity hover:opacity-90"
                        style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddingCategoryInline(false);
                          setInlineNewCategoryName("");
                        }}
                        className="px-1 text-[11px] hover:opacity-75"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAddingCategoryInline(true)}
                      className="px-2.5 py-1 rounded-lg border border-dashed transition-colors text-xs font-medium hover:opacity-85"
                      style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                    >
                      ＋ 新規
                    </button>
                  )}

                  {selectedCategories.length === 0 && !isAddingCategoryInline && (
                    <span className="text-[11px] select-none" style={{ color: activeTheme.textSecondary }}>
                      （未選択＝未分類）
                    </span>
                  )}
                </div>

                {/* 保存ボタン */}
                <div className="shrink-0 flex justify-end">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!content.trim()}
                    className={`${
                      buttonSize === "large" ? "px-7 py-2.5 text-base" : "px-6 py-2 text-sm"
                    } rounded-xl font-bold transition-all shadow-sm disabled:opacity-45 disabled:cursor-not-allowed`}
                    style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                  >
                    保存
                  </button>
                </div>
              </div>

              {/* リマインダー（見返す日）控えめ設定行（チュートリアルStep3では高さ維持のため非表示） */}
              {tutorialStep !== 3 && (
                <div
                  className="mt-2.5 pt-2.5 border-t flex flex-wrap items-center gap-1.5 text-xs"
                  style={{ borderColor: activeTheme.border }}
                >
                  <span
                    className="flex items-center gap-1 text-[11px] font-medium mr-0.5 select-none"
                    style={{ color: activeTheme.textSecondary }}
                  >
                    🔔 見返す日:
                  </span>
                  {REMINDER_PRESET_OFFSETS.map((preset) => {
                    const targetYmd = getLocalYmd(preset.days);
                    const isSelected = newNoteRemindAt === targetYmd;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setNewNoteRemindAt(isSelected ? "" : targetYmd)}
                        className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-all ${
                          isSelected ? "shadow-xs font-bold" : "border"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgSub,
                          borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                  <div
                    className={`relative inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] transition-all cursor-pointer ${
                      newNoteRemindAt ? "font-bold shadow-xs" : "border font-medium"
                    }`}
                    style={{
                      backgroundColor: newNoteRemindAt ? activeTheme.accent : activeTheme.bgSub,
                      borderColor: newNoteRemindAt ? activeTheme.accent : activeTheme.border,
                      color: newNoteRemindAt ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    <span>📅</span>
                    <span>
                      {newNoteRemindAt
                        ? (() => {
                            const [, m, d] = newNoteRemindAt.split("-");
                            return m && d ? `${Number(m)}/${Number(d)}` : newNoteRemindAt;
                          })()
                        : "日付を選ぶ"}
                    </span>
                    <input
                      type="date"
                      value={newNoteRemindAt}
                      onChange={(e) => setNewNoteRemindAt(e.target.value)}
                      aria-label="見返す日を指定"
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                  </div>
                  {newNoteRemindAt && (
                    <button
                      type="button"
                      onClick={() => setNewNoteRemindAt("")}
                      className="text-[11px] px-1.5 py-0.5 rounded-md hover:opacity-75"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      ✕ 解除
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleToggleComposeLock}
                    className={`ml-auto px-2.5 py-0.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 ${
                      newNoteIsLocked ? "shadow-xs font-bold" : "border"
                    }`}
                    style={{
                      backgroundColor: newNoteIsLocked ? activeTheme.accent : activeTheme.bgSub,
                      borderColor: newNoteIsLocked ? activeTheme.accent : activeTheme.border,
                      color: newNoteIsLocked ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    <span>{newNoteIsLocked ? "🔒" : "🔓"}</span>
                    <span>{newNoteIsLocked ? "鍵付きで保存" : "鍵をつける"}</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* メモが0件の時は常に表示される控えめなチュートリアル案内カード（Rule 3 厳守） */}
          {isLoaded && notes.length === 0 && !isTutorialPromptDismissed && tutorialStep === null && (
            <div
              className="mt-4 p-4 rounded-xl border flex items-center justify-between gap-3 animate-fadeIn"
              style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <img src="/icon.svg" alt="ライトNote" className="w-7 h-7 rounded-md shadow-2xs shrink-0" />
                <div className="text-xs min-w-0">
                  <span className="font-bold block truncate" style={{ color: activeTheme.textPrimary }}>
                    初めてご利用の方へ
                  </span>
                  <span className="block truncate text-[11px]" style={{ color: activeTheme.textSecondary }}>
                    1分でわかる簡単な使い方を体験してみませんか？
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsTutorialPromptDismissed(true)}
                  className="px-2.5 py-1 text-xs rounded-lg transition-colors hover:opacity-80"
                  style={{ color: activeTheme.textSecondary }}
                >
                  スキップ
                </button>
                <button
                  type="button"
                  onClick={handleStartTutorial}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg shadow-xs transition-all hover:opacity-90"
                  style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                >
                  はじめる
                </button>
              </div>
            </div>
          )}
        </div>
      )}

        {/* ② メモを見る（通常一覧：Twitter風のすっきり二層表示） */}
        {activeTab === "list" && (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold`}
                  style={{ color: activeTheme.textPrimary }}
                >
                  メモ一覧 ({activeNotes.length}件)
                </h2>
                {currentUser && (isSyncing || syncStatus === "syncing") && (
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full border"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textSecondary,
                    }}
                  >
                    🔄 同期中...
                  </span>
                )}
                {currentUser && !isSyncing && (syncStatus === "offline" || syncStatus === "error") && (
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textSecondary,
                    }}
                  >
                    <span>
                      {syncStatus === "offline" ? "📡 オフライン（端末保存済み）" : "⚠️ 同期保留中"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        fetchCloudNotes(currentUser.id);
                        fetchUserSettings(currentUser.id);
                      }}
                      className="underline font-bold hover:opacity-75"
                      style={{ color: activeTheme.accent }}
                    >
                      再同期
                    </button>
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setIsReminderPanelOpen((prev) => !prev)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all border shrink-0"
                style={{
                  backgroundColor:
                    dueReminderNotes.length > 0 || isReminderPanelOpen
                      ? activeTheme.accent
                      : activeTheme.bgSub,
                  borderColor:
                    dueReminderNotes.length > 0 || isReminderPanelOpen
                      ? activeTheme.accent
                      : activeTheme.border,
                  color:
                    dueReminderNotes.length > 0 || isReminderPanelOpen
                      ? activeTheme.accentText
                      : activeTheme.textSecondary,
                }}
                aria-expanded={isReminderPanelOpen}
              >
                <span>🔔</span>
                {dueReminderNotes.length > 0 ? (
                  <span>今日見返す ({dueReminderNotes.length})</span>
                ) : upcomingReminderNotes.length > 0 ? (
                  <span>予定 ({upcomingReminderNotes.length})</span>
                ) : (
                  <span>リマインダー</span>
                )}
              </button>
            </div>

            {/* スクロール領域（検索バーとメモが一緒に流れるため、下スクロールでメモが画面いっぱいに広がる） */}
            <div className="flex-1 overflow-y-auto pr-1 pb-16 flex flex-col">
              {/* リマインダー折りたたみパネル（メモ一覧横の 🔔 ボタンで開閉） */}
              {isReminderPanelOpen && (
                <div
                  className="mb-3 p-3.5 rounded-xl border flex flex-col gap-3 shrink-0"
                  style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                      <span>🔔</span> 見返すメモ（リマインダー）
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsReminderPanelOpen(false)}
                      className="text-[11px] font-medium hover:opacity-75"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      閉じる ✕
                    </button>
                  </div>

                  {reminderActiveNotes.length === 0 ? (
                    <p className="text-xs py-2 text-center leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                      見返す日が設定されたメモはありません。<br />
                      メモ右上の「…」メニューや新規保存時に設定できます。
                    </p>
                  ) : (
                    <>
                      {[
                        { heading: "📌 今日見返すメモ", items: dueReminderNotes },
                        { heading: "📅 これからの予定", items: upcomingReminderNotes },
                      ]
                      .filter((section) => section.items.length > 0)
                      .map((section) => (
                        <div key={section.heading} className="flex flex-col gap-2">
                          <div className="text-[11px] font-bold" style={{ color: activeTheme.textSecondary }}>
                            {section.heading} ({section.items.length})
                          </div>
                          {section.items.map((rNote) => {
                            const meta = formatReminderLabel(rNote.remindAt || todayYmd);
                            return (
                              <div
                                key={rNote.id}
                                className="p-3 rounded-xl border flex flex-col gap-2"
                                style={{
                                  backgroundColor: activeTheme.bgCard,
                                  borderColor: meta.isDue ? activeTheme.accent : activeTheme.border,
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleJumpToReminderNote(rNote.id)}
                                    className="text-left flex-1 min-w-0 hover:opacity-80 transition-opacity"
                                  >
                                    {(() => {
                                      const rVisible = isNoteContentVisible(rNote);
                                      return (
                                        <>
                                          {rNote.title && (
                                            <div className="text-xs font-bold truncate" style={{ color: activeTheme.textPrimary }}>
                                              {rVisible || !maskLockedTitle ? rNote.title : maskLockedText(rNote.title)}
                                            </div>
                                          )}
                                          <p
                                            className={`text-xs line-clamp-2 whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere] ${
                                              !rVisible ? "break-all" : ""
                                            }`}
                                            style={{ color: activeTheme.textSecondary }}
                                          >
                                            {rVisible ? rNote.content : maskLockedText(rNote.content)}
                                          </p>
                                        </>
                                      );
                                    })()}
                                  </button>
                                  <span
                                    className="text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0 border"
                                    style={
                                      meta.isDue
                                        ? {
                                            backgroundColor: activeTheme.accent,
                                            borderColor: activeTheme.accent,
                                            color: activeTheme.accentText,
                                          }
                                        : {
                                            backgroundColor: activeTheme.bgSub,
                                            borderColor: activeTheme.border,
                                            color: activeTheme.textSecondary,
                                          }
                                    }
                                  >
                                    🔔 {meta.label}
                                  </span>
                                </div>
                                <div className="flex items-center justify-end gap-1.5 flex-wrap">
                                  <button
                                    type="button"
                                    onClick={() => handleJumpToReminderNote(rNote.id)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium border hover:opacity-80"
                                    style={{
                                      backgroundColor: activeTheme.bgSub,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textSecondary,
                                    }}
                                  >
                                    メモへ
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenReminderModal(rNote)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium border hover:opacity-80"
                                    style={{
                                      backgroundColor: activeTheme.bgSub,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                  >
                                    📅 日付変更
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleSetNoteReminder(rNote.id, undefined)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold hover:opacity-90"
                                    style={{
                                      backgroundColor: activeTheme.accent,
                                      color: activeTheme.accentText,
                                    }}
                                  >
                                    ✓ 確認済み
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* 検索・絞り込み機能エリア（スケッチの実装） */}
              <div className="shrink-0 mb-3">
              {!isSearchPanelOpen ? (
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                  <button
                    id="tutorial-target-search-btn"
                    type="button"
                    onClick={() => setIsSearchPanelOpen(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all border`}
                    style={{
                      backgroundColor:
                        filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate)
                          ? activeTheme.accent
                          : activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color:
                        filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate)
                          ? activeTheme.accentText
                          : activeTheme.textSecondary,
                    }}
                  >
                    <span>🔍</span>
                    {filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate) ? (
                      <span>絞り込み中 ({displayedNotes.length}件)</span>
                    ) : (
                      <span>検索機能</span>
                    )}
                  </button>
                  {(unlockedNoteIds.length > 0 || isLockSessionVerified) && (
                    <button
                      type="button"
                      onClick={() => lockAllNotes(true)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold border transition-opacity hover:opacity-85"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.accent,
                        color: activeTheme.textPrimary,
                      }}
                    >
                      <span>🔒</span>
                      <span>
                        {unlockedNoteIds.length > 0
                          ? `すべて隠す (${unlockedNoteIds.length})`
                          : "鍵をロック"}
                      </span>
                    </button>
                  )}
                  </div>
                  {(filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate)) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilterOnlyFavorite(false);
                        setFilterCategories([]);
                        setIncludeTrashInSearch(false);
                        setSearchQuery("");
                        setFilterTimeSlots([]);
                        setFilterDate("");
                      }}
                      className="text-[11px] underline font-medium hover:opacity-80 transition-opacity"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      絞り込みを解除
                    </button>
                  )}
                </div>
              ) : (
                <div
                  id="tutorial-target-search-panel"
                  className="mb-3 p-3.5 rounded-xl border shadow-xs flex flex-col gap-3 transition-all shrink-0"
                  style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                >
                  {/* パネル上部: タイトル & とじるボタン */}
                  <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: activeTheme.border }}>
                    <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                      <span>🔍</span> 検索機能
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsSearchPanelOpen(false)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs transition-colors hover:opacity-80"
                      style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                    >
                      <span>✕</span> とじる
                    </button>
                  </div>

                  {/* ① キーワード検索入力欄 */}
                  <div>
                    <span className="block text-[11px] font-bold mb-1.5" style={{ color: activeTheme.textSecondary }}>
                      🔤 キーワードで探す
                    </span>
                    <div className="relative flex items-center">
                      <input
                        type="text"
                        placeholder="タイトル、本文、追記から探す..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className={`w-full ${
                          fontSize === "large" ? "text-sm py-2 px-3 pr-8" : "text-xs py-1.5 px-2.5 pr-7"
                        } rounded-xl border focus:outline-none transition-colors`}
                        style={{
                          backgroundColor: activeTheme.bgSub,
                          borderColor: activeTheme.border,
                          color: activeTheme.textPrimary,
                        }}
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2 text-xs p-1 font-bold hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                          title="入力をクリア"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ② 絞り込みオプション（お気に入り & ゴミ箱） */}
                  <div>
                    <span className="block text-[11px] font-bold mb-1.5" style={{ color: activeTheme.textSecondary }}>
                      📌 絞り込みオプション
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setFilterOnlyFavorite(!filterOnlyFavorite)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border`}
                        style={{
                          backgroundColor: filterOnlyFavorite ? "#d49e35" : activeTheme.bgSub,
                          borderColor: filterOnlyFavorite ? "#d49e35" : activeTheme.border,
                          color: filterOnlyFavorite ? "#ffffff" : activeTheme.textSecondary,
                        }}
                      >
                        <span>{filterOnlyFavorite ? "★" : "☆"}</span>
                        {filterOnlyFavorite ? "お気に入りのみ表示中" : "お気に入りのみ"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setIncludeTrashInSearch(!includeTrashInSearch)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border`}
                        style={{
                          backgroundColor: includeTrashInSearch ? activeTheme.accent : activeTheme.bgSub,
                          borderColor: includeTrashInSearch ? activeTheme.accent : activeTheme.border,
                          color: includeTrashInSearch ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        <span>🗑️</span>
                        {includeTrashInSearch ? "ゴミ箱も含めて表示中" : "ゴミ箱も含める"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setFilterOnlyLocked(!filterOnlyLocked)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border`}
                        style={{
                          backgroundColor: filterOnlyLocked ? activeTheme.accent : activeTheme.bgSub,
                          borderColor: filterOnlyLocked ? activeTheme.accent : activeTheme.border,
                          color: filterOnlyLocked ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        <span>🔒</span>
                        {filterOnlyLocked ? "鍵付きのみ表示中" : "鍵付きのみ"}
                      </button>
                    </div>
                  </div>

                  {/* ② カテゴリからさがす（アコーディオン） */}
                  <div className="border-t border-[#f0eae1] pt-2">
                    <button
                      type="button"
                      onClick={() => setIsSearchCategoryOpen(!isSearchCategoryOpen)}
                      className="flex items-center justify-between w-full text-left py-0.5 group cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-[#8a7f72] group-hover:text-[#3d3731] transition-colors flex items-center gap-1">
                          <span className="text-[9px] font-mono">{isSearchCategoryOpen ? "▼" : "▶"}</span>
                          <span>🏷️ カテゴリからさがす</span>
                        </span>
                        {filterCategories.length > 0 && !isSearchCategoryOpen && (
                          <span className="text-[10px] text-[#8a7f72] bg-[#f4f0e8] px-2 py-0.5 rounded-md font-normal">
                            {filterCategories.includes("uncategorized")
                              ? "未分類"
                              : `${filterCategories.length}個選択中`}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-[#9c9184] group-hover:text-[#5c5348] font-mono">
                        {isSearchCategoryOpen ? "たたむ" : "広げる"}
                      </span>
                    </button>

                    {isSearchCategoryOpen && (
                      <div className="mt-2 flex flex-col gap-1.5">
                        {filterCategories.length > 1 && (
                          <span className="text-[10px] text-[#8a7f72] bg-[#f4f0e8] px-2 py-0.5 rounded-md self-start">
                            {filterCategories.length}個のカテゴリで絞り込み中 (AND検索)
                          </span>
                        )}
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {/* ”すべてのメモ” ボタン（全解除） */}
                          <button
                            type="button"
                            onClick={() => setFilterCategories([])}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                              filterCategories.length === 0
                                ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                            }`}
                          >
                            ”すべてのメモ”
                          </button>

                          {/* ”未分類” ボタン（単独選択） */}
                          {(() => {
                            const isUncategorizedSelected = filterCategories.includes("uncategorized");
                            return (
                              <button
                                type="button"
                                onClick={() =>
                                  setFilterCategories(isUncategorizedSelected ? [] : ["uncategorized"])
                                }
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                                  isUncategorizedSelected
                                    ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                    : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                                }`}
                              >
                                ”未分類”
                              </button>
                            );
                          })()}

                          {/* 各カテゴリボタン（ソート順反映） */}
                          {sortedCategories.map((cat) => {
                            const isSelected = filterCategories.includes(cat.id);
                            return (
                              <button
                                key={cat.id}
                                type="button"
                                onClick={() =>
                                  setFilterCategories((prev) => {
                                    const withoutUncategorized = prev.filter((c) => c !== "uncategorized");
                                    return isSelected
                                      ? withoutUncategorized.filter((c) => c !== cat.id)
                                      : [...withoutUncategorized, cat.id];
                                  })
                                }
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                                  isSelected
                                    ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                    : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                                }`}
                              >
                                {cat.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ③ 時間帯から探す（アコーディオン） */}
                  <div className="border-t border-[#f0eae1] pt-2">
                    <button
                      type="button"
                      onClick={() => setIsSearchTimeSlotOpen(!isSearchTimeSlotOpen)}
                      className="flex items-center justify-between w-full text-left py-0.5 group cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-[#8a7f72] group-hover:text-[#3d3731] transition-colors flex items-center gap-1">
                          <span className="text-[9px] font-mono">{isSearchTimeSlotOpen ? "▼" : "▶"}</span>
                          <span>⏰ 時間帯から探す</span>
                        </span>
                        {filterTimeSlots.length > 0 && (
                          <span className="text-[10px] text-[#8a7f72] bg-[#f4f0e8] px-2 py-0.5 rounded-md font-normal">
                            {filterTimeSlots.length}個選択中
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-[#9c9184] group-hover:text-[#5c5348] font-mono">
                        {isSearchTimeSlotOpen ? "たたむ" : "広げる"}
                      </span>
                    </button>

                    {isSearchTimeSlotOpen && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).map((key) => {
                          const slot = timeSlots[key] || DEFAULT_TIME_SLOTS[key];
                          const isSelected = filterTimeSlots.includes(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() =>
                                setFilterTimeSlots((prev) =>
                                  isSelected ? prev.filter((k) => k !== key) : [...prev, key]
                                )
                              }
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                                isSelected
                                  ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                  : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                              }`}
                            >
                              <span
                                className="w-2 h-2 rounded-full inline-block shrink-0 shadow-xs"
                                style={{ backgroundColor: slot.color }}
                              />
                              <span>{slot.icon}</span>
                              <span>{slot.label}</span>
                              <span className="text-[10px] opacity-75 font-mono">
                                ({slot.startHour}:00〜{slot.endHour}:59)
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* ④ 日付・カレンダーから探す（オリジナル・ミニカレンダー） */}
                  <div className="border-t border-[#f0eae1] pt-2">
                    <button
                      type="button"
                      onClick={() => setIsSearchDateOpen(!isSearchDateOpen)}
                      className="flex items-center justify-between w-full text-left py-0.5 group cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-[#8a7f72] group-hover:text-[#3d3731] transition-colors flex items-center gap-1">
                          <span className="text-[9px] font-mono">{isSearchDateOpen ? "▼" : "▶"}</span>
                          <span>📅 日付・カレンダーから探す</span>
                        </span>
                        {filterDate && (
                          <span className="text-[10px] text-[#3d3731] bg-[#e8e0d3] px-2 py-0.5 rounded-md font-mono font-bold flex items-center gap-1">
                            <span>{filterDate}</span>
                            <span>({noteDatesMap.get(filterDate) || 0}件)</span>
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-[#9c9184] group-hover:text-[#5c5348] font-mono">
                        {isSearchDateOpen ? "たたむ" : "広げる"}
                      </span>
                    </button>

                    {isSearchDateOpen && (
                      <div className="mt-2.5 p-3 bg-[#faf8f5] rounded-xl border border-[#ded5c8] shadow-2xs flex flex-col gap-2.5">
                        {/* カレンダーの年月ヘッダー（1行で絶対に改行しない横並びレイアウト） */}
                        <div className="flex items-center justify-between px-1 pb-1.5 border-b border-[#eee7dc]">
                          <button
                            type="button"
                            onClick={handlePrevCalendarMonth}
                            className="px-2 py-1 rounded-lg text-xs font-bold text-[#6b6257] hover:bg-[#e8e0d3] active:bg-[#ded5c8] transition-colors flex items-center gap-1"
                            title="前月へ"
                          >
                            <span>◀</span>
                            <span className="text-[11px]">前月</span>
                          </button>
                          <div className="font-bold text-xs sm:text-sm text-[#3d3731] font-mono tracking-wider flex items-center gap-1.5">
                            <span>📅</span>
                            <span>{calendarYear}年 {calendarMonth}月</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleNextCalendarMonth}
                            className="px-2 py-1 rounded-lg text-xs font-bold text-[#6b6257] hover:bg-[#e8e0d3] active:bg-[#ded5c8] transition-colors flex items-center gap-1"
                            title="次月へ"
                          >
                            <span className="text-[11px]">次月</span>
                            <span>▶</span>
                          </button>
                        </div>

                        {/* 曜日ヘッダー（日〜土） */}
                        <div className="grid grid-cols-7 gap-1 text-center font-bold text-[11px]">
                          <span className="text-[#c25e4e]">日</span>
                          <span className="text-[#7d7367]">月</span>
                          <span className="text-[#7d7367]">火</span>
                          <span className="text-[#7d7367]">水</span>
                          <span className="text-[#7d7367]">木</span>
                          <span className="text-[#7d7367]">金</span>
                          <span className="text-[#4a7bb0]">土</span>
                        </div>

                        {/* カレンダーグリッド（日付セル） */}
                        {(() => {
                          const firstDayOfWeek = new Date(calendarYear, calendarMonth - 1, 1).getDay();
                          const daysInMonth = new Date(calendarYear, calendarMonth, 0).getDate();
                          const todayStr = new Date().toLocaleDateString("sv-SE");

                          const cells = [];
                          // 月初までの空セル
                          for (let i = 0; i < firstDayOfWeek; i++) {
                            cells.push(<div key={`empty-${i}`} className="h-8" />);
                          }

                          // 1日〜末日
                          for (let day = 1; day <= daysInMonth; day++) {
                            const dateStr = `${calendarYear}-${String(calendarMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                            const isSelected = filterDate === dateStr;
                            const isToday = todayStr === dateStr;
                            const noteCount = noteDatesMap.get(dateStr) || 0;
                            const hasNotes = noteCount > 0;

                            cells.push(
                              <button
                                key={dateStr}
                                type="button"
                                onClick={() => setFilterDate(isSelected ? "" : dateStr)}
                                className={`relative h-8 flex flex-col items-center justify-center rounded-lg text-xs font-mono transition-all ${
                                  isSelected
                                    ? "bg-[#3d3731] text-[#faf8f5] font-bold shadow-xs scale-105"
                                    : isToday
                                    ? "border-2 border-[#3d3731] font-bold"
                                    : ""
                                } ${
                                  !isSelected && hasNotes
                                    ? "text-[#2d2926] font-bold bg-[#eae3d7] hover:bg-[#ded5c8]"
                                    : !isSelected
                                    ? "text-[#a09485] hover:bg-[#f2ede4]"
                                    : ""
                                }`}
                                title={`${dateStr}${hasNotes ? ` (${noteCount}件のメモ)` : " (メモなし)"}`}
                              >
                                <span className={!isSelected && !hasNotes ? "opacity-60" : ""}>{day}</span>
                                {hasNotes && !isSelected && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-[#529961] -mt-0.5 shadow-2xs" />
                                )}
                              </button>
                            );
                          }

                          return <div className="grid grid-cols-7 gap-1">{cells}</div>;
                        })()}

                        {/* カレンダー下部：説明とクイックボタン */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#eee7dc] text-xs">
                          {/* 凡例（メモがある日の説明） */}
                          <div className="flex items-center gap-1.5 text-[10px] text-[#7d7367]">
                            <span className="inline-block w-2 h-2 rounded-full bg-[#529961]" />
                            <span>濃い色＋緑点＝メモがある日</span>
                          </div>

                          {/* クイック選択ボタン */}
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                const now = new Date();
                                setCalendarYear(now.getFullYear());
                                setCalendarMonth(now.getMonth() + 1);
                                const today = now.toLocaleDateString("sv-SE");
                                setFilterDate(filterDate === today ? "" : today);
                              }}
                              className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                                filterDate === new Date().toLocaleDateString("sv-SE")
                                  ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                  : "bg-[#f0eade] text-[#5c5348] hover:bg-[#e5ded2]"
                              }`}
                            >
                              今日
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const yest = new Date();
                                yest.setDate(yest.getDate() - 1);
                                setCalendarYear(yest.getFullYear());
                                setCalendarMonth(yest.getMonth() + 1);
                                const yesterday = getLocalYmd(-1);
                                setFilterDate(filterDate === yesterday ? "" : yesterday);
                              }}
                              className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                                filterDate === getLocalYmd(-1)
                                  ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                  : "bg-[#f0eade] text-[#5c5348] hover:bg-[#e5ded2]"
                              }`}
                            >
                              昨日
                            </button>
                            {filterDate && (
                              <button
                                type="button"
                                onClick={() => setFilterDate("")}
                                className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium ml-1"
                              >
                                解除
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ヒット件数 */}
                  {(filterOnlyFavorite || filterOnlyLocked || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate)) && (
                    <div className="text-[11px] text-[#8a7f72] pt-1 border-t border-[#f4f0e8] flex items-center justify-between">
                      <span>該当するメモ: {displayedNotes.length}件</span>
                      <button
                        type="button"
                        onClick={() => {
                          setFilterOnlyFavorite(false);
                          setFilterOnlyLocked(false);
                          setFilterCategories([]);
                          setIncludeTrashInSearch(false);
                          setSearchQuery("");
                          setFilterTimeSlots([]);
                          setFilterDate("");
                        }}
                        className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium"
                      >
                        条件をリセット
                      </button>
                    </div>
                  )}
                </div>
              )}
              </div>

              {/* メモ一覧カードリスト */}
              <div className="flex flex-col gap-3 min-w-0">
              {!isLoaded ? (
                <div className="text-center py-8 text-sm text-[#b0a598]">
                  読み込み中...
                </div>
              ) : activeNotes.length === 0 ? (
                <div
                  id="tutorial-target-irreversible"
                  className="text-center py-10 text-sm rounded-xl border border-dashed p-4"
                  style={{
                    backgroundColor: activeTheme.bgCard,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  まだメモがありません。ホームから思いつきを書いてみましょう。
                </div>
              ) : displayedNotes.length === 0 ? (
                <div className="text-center py-10 text-xs text-[#8a7f72] bg-white/50 rounded-xl border border-dashed border-[#ded6c9] p-4">
                  条件に一致するメモが見つかりませんでした。<br />
                  <button
                    type="button"
                    onClick={() => {
                      setFilterOnlyFavorite(false);
                      setFilterOnlyLocked(false);
                      setFilterCategories([]);
                      setIncludeTrashInSearch(false);
                      setSearchQuery("");
                      setFilterTimeSlots([]);
                      setFilterDate("");
                    }}
                    className="mt-2 text-xs text-[#3d3731] font-bold underline hover:text-black"
                  >
                    条件をリセットして全件表示
                  </button>
                </div>
              ) : (
                displayedNotes.map((note, index) => {
                  const isMenuThisNoteOpen = activeMenuNoteId === note.id;
                  const isContentVisible = isNoteContentVisible(note);

                  return (
                    <article
                      key={note.id}
                      data-note-id={note.id}
                      id={index === 0 ? "tutorial-target-irreversible" : undefined}
                      className={`w-full min-w-0 p-4 rounded-xl shadow-2xs relative transition-colors border ${
                        note.isTrash ? "border-dashed opacity-90" : ""
                      }`}
                      style={{
                        backgroundColor: note.isTrash ? activeTheme.bgSub : activeTheme.bgCard,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap pr-2 min-w-0 flex-1">
                          <h3
                            className={`font-bold min-w-0 max-w-full break-all [overflow-wrap:anywhere] ${
                              fontSize === "large" ? "text-base" : "text-sm"
                            }`}
                            style={{ color: activeTheme.textPrimary }}
                          >
                            {note.title ? (
                              isContentVisible || !maskLockedTitle ? (
                                note.title
                              ) : (
                                maskLockedText(note.title)
                              )
                            ) : (
                              <span className="font-normal italic" style={{ color: activeTheme.textSecondary }}>
                                （無題）
                              </span>
                            )}
                          </h3>
                          {note.isLocked && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded font-medium border shrink-0"
                              style={{
                                backgroundColor: activeTheme.bgSub,
                                borderColor: activeTheme.border,
                                color: activeTheme.textSecondary,
                              }}
                            >
                              {isContentVisible ? "🔓 解除中" : "🔒 ロック中"}
                            </span>
                          )}
                          {note.isTrash && (
                            <span className="text-[10px] bg-[#eedcd8] text-[#a6483b] px-1.5 py-0.5 rounded font-medium border border-[#e0c0b8] shrink-0">
                              🗑️ ゴミ箱内
                            </span>
                          )}
                        </div>

                        {/* 右上：ワンタッチコピー、お気に入りボタン ＆ 控えめな「…」メニューまたは「元に戻す」ボタン */}
                        <div className="relative shrink-0 flex items-center gap-1.5">
                          {/* ワンタッチコピーボタン */}
                          <button
                            type="button"
                            onClick={() => {
                              if (tutorialStep !== null) return;
                              handleCopyNote(note);
                            }}
                            aria-disabled={tutorialStep !== null || !isContentVisible}
                            className={`w-7 h-7 flex items-center justify-center rounded-lg text-xs leading-none transition-colors ${
                              tutorialStep !== null || !isContentVisible ? "opacity-40 cursor-default" : "hover:opacity-80"
                            }`}
                            style={{ color: activeTheme.textSecondary }}
                            aria-label="メモをクリップボードにコピー"
                            title={isContentVisible ? "メモをコピー" : "ロック中はコピーできません"}
                          >
                            <CopyIcon className="w-3.5 h-3.5" />
                          </button>

                          {/* お気に入りボタン */}
                          <button
                            type="button"
                            onClick={() => {
                              if (tutorialStep !== null) return;
                              handleToggleFavorite(note.id);
                            }}
                            aria-disabled={tutorialStep !== null}
                            className={`w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none transition-colors ${
                              tutorialStep !== null ? "opacity-55 cursor-default" : "hover:opacity-80"
                            }`}
                            aria-label={note.isFavorite ? "お気に入りを解除" : "お気に入りに登録"}
                            title={note.isFavorite ? "お気に入り解除" : "お気に入り登録"}
                          >
                            <span className={note.isFavorite ? "text-[#d49e35]" : "text-[#c2b8aa]"}>
                              {note.isFavorite ? "★" : "☆"}
                            </span>
                          </button>

                          <div className="flex items-center gap-2">
                            <time
                              className={`${
                                fontSize === "large" ? "text-xs" : "text-[11px]"
                              } font-mono`}
                              style={{ color: activeTheme.textSecondary }}
                            >
                              {formatDate(note.createdAt)}
                            </time>
                            {note.isTrash ? (
                              <button
                                type="button"
                                onClick={() => handleRestoreFromTrash(note.id)}
                                className={`${
                                  buttonSize === "large"
                                    ? "text-xs px-2.5 py-1.5"
                                    : "text-[11px] px-2 py-1"
                                } rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0 border`}
                                style={{
                                  backgroundColor: activeTheme.bgSub,
                                  borderColor: activeTheme.border,
                                  color: activeTheme.textPrimary,
                                }}
                                title="ゴミ箱から通常メモに戻す"
                              >
                                <span>↩️</span> 元に戻す
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuNoteId(
                                    isMenuThisNoteOpen ? null : note.id
                                  );
                                }}
                                className={`${
                                  buttonSize === "large"
                                    ? "w-8 h-8 text-base"
                                    : "w-6 h-6 text-sm"
                                } flex items-center justify-center rounded-lg leading-none font-bold transition-colors hover:opacity-80`}
                                style={{ color: activeTheme.textSecondary }}
                                aria-label="操作メニュー"
                              >
                                …
                              </button>
                            )}
                          </div>

                          {/* タップした時だけ開くポップアップメニュー */}
                          {isMenuThisNoteOpen && (
                            <div
                              className="absolute right-0 top-7 w-48 rounded-xl shadow-lg border p-1 z-30 transition-all flex flex-col gap-0.5"
                              style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  if (!isContentVisible) {
                                    setActiveMenuNoteId(null);
                                    handleRequestUnlockNote(note.id);
                                    return;
                                  }
                                  handleCopyNote(note);
                                  setActiveMenuNoteId(null);
                                }}
                                aria-disabled={tutorialStep !== null || !isContentVisible}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null || !isContentVisible ? "opacity-50 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <CopyIcon className="w-3.5 h-3.5 shrink-0" /> 本文をコピー
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  if (!isContentVisible) {
                                    setActiveMenuNoteId(null);
                                    handleRequestUnlockNote(note.id);
                                    return;
                                  }
                                  handleOpenContentEditModal(note);
                                }}
                                aria-disabled={tutorialStep !== null || !isContentVisible}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null || !isContentVisible ? "opacity-50 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>✏️</span> 本文を訂正する
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  if (!isContentVisible) {
                                    setActiveMenuNoteId(null);
                                    handleRequestUnlockNote(note.id);
                                    return;
                                  }
                                  handleOpenEditModal(note);
                                }}
                                aria-disabled={tutorialStep !== null || !isContentVisible}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null || !isContentVisible ? "opacity-50 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>🏷️</span> タイトル・カテゴリの変更
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  if (!isContentVisible) {
                                    setActiveMenuNoteId(null);
                                    handleRequestUnlockNote(note.id);
                                    return;
                                  }
                                  setReplyingNoteId(note.id);
                                  setReplyContent("");
                                  setActiveMenuNoteId(null);
                                  setExpandedReplyNoteIds((prev) =>
                                    prev.includes(note.id) ? prev : [...prev, note.id]
                                  );
                                }}
                                aria-disabled={tutorialStep !== null || !isContentVisible}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null || !isContentVisible ? "opacity-50 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>💬</span> 追記する
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  handleOpenReminderModal(note);
                                }}
                                aria-disabled={tutorialStep !== null}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null ? "opacity-60 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>🔔</span> {note.remindAt ? "見返す日を変更" : "見返す日を設定"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  handleToggleNoteLock(note);
                                }}
                                aria-disabled={tutorialStep !== null}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null ? "opacity-60 cursor-default" : "hover:opacity-80"
                                }`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>{note.isLocked ? "🔓" : "🔒"}</span>
                                {note.isLocked ? "鍵を外す" : "鍵をつける"}
                              </button>
                              <div className="my-0.5 border-t" style={{ borderColor: activeTheme.border }} />
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  handleMoveToTrash(note.id);
                                }}
                                aria-disabled={tutorialStep !== null}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } text-[#b85448] rounded-lg flex items-center gap-1.5 font-medium transition-colors ${
                                  tutorialStep !== null ? "opacity-60 cursor-default" : "hover:bg-[#fdf2f0]"
                                }`}
                              >
                                <span>🗑️</span> ゴミ箱へ移動
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* カテゴリタグ・リマインダー一覧 */}
                      {((note.categories && note.categories.length > 0) || note.remindAt) && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {note.categories?.map((cat) => (
                            <span
                              key={cat}
                              className="text-[10px] px-2 py-0.5 rounded-md font-medium border"
                              style={{
                                backgroundColor: activeTheme.bgSub,
                                borderColor: activeTheme.border,
                                color: activeTheme.textSecondary,
                              }}
                            >
                              🏷️ {getCategoryName(cat)}
                            </span>
                          ))}
                          {note.remindAt && (() => {
                            const rMeta = formatReminderLabel(note.remindAt);
                            return (
                              <button
                                type="button"
                                onClick={() => {
                                  if (tutorialStep !== null) return;
                                  handleOpenReminderModal(note);
                                }}
                                className="text-[10px] px-2 py-0.5 rounded-md font-medium border transition-opacity hover:opacity-80"
                                style={
                                  rMeta.isDue
                                    ? {
                                        backgroundColor: activeTheme.accent,
                                        borderColor: activeTheme.accent,
                                        color: activeTheme.accentText,
                                      }
                                    : {
                                        backgroundColor: activeTheme.bgSub,
                                        borderColor: activeTheme.border,
                                        color: activeTheme.textSecondary,
                                      }
                                }
                              >
                                🔔 {rMeta.label}
                              </button>
                            );
                          })()}
                        </div>
                      )}

                      <CollapsibleNoteBody
                        text={isContentVisible ? note.content : maskLockedText(note.content)}
                        maxLines={noteCollapseLines}
                        isExpanded={expandedBodyNoteIds.includes(note.id)}
                        onToggle={() => handleToggleNoteBody(note.id)}
                        isMasked={!isContentVisible}
                        accentColor={activeTheme.accent}
                        className={`${
                          fontSize === "large" ? "text-base" : "text-sm"
                        } whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere] ${
                          !isContentVisible ? "break-all select-none opacity-80 tracking-wider" : ""
                        }`}
                        style={{
                          color: activeTheme.textPrimary,
                          fontFamily: getNoteFontFamilyStyle(noteFont),
                        }}
                      />

                      {note.isLocked && (
                        <div className="mt-2.5 flex items-center justify-end">
                          {isContentVisible ? (
                            <button
                              type="button"
                              onClick={() => handleHideUnlockedNote(note.id)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium border flex items-center gap-1 transition-opacity hover:opacity-80"
                              style={{
                                backgroundColor: activeTheme.bgSub,
                                borderColor: activeTheme.border,
                                color: activeTheme.textSecondary,
                              }}
                            >
                              <span>🔒</span> 非表示にする
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (tutorialStep !== null) return;
                                handleRequestUnlockNote(note.id);
                              }}
                              className="px-3 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 shadow-2xs transition-opacity hover:opacity-90"
                              style={{
                                backgroundColor: activeTheme.accent,
                                color: activeTheme.accentText,
                              }}
                            >
                              <span>🔓</span> {isLockSessionVerified ? "タップして表示" : "ロック解除して読む"}
                            </button>
                          )}
                        </div>
                      )}

                      {/* 訂正履歴表示（過去の文章をいつでも確認・振り返り可能） */}
                      {note.editHistory && note.editHistory.length > 0 && isContentVisible && (
                        <div className="mt-2 pt-1.5 border-t border-dashed" style={{ borderColor: activeTheme.border }}>
                          <button
                            type="button"
                            onClick={() => handleToggleEditHistory(note.id)}
                            className="text-[11px] flex items-center gap-1 font-medium transition-colors cursor-pointer group hover:opacity-80"
                            style={{ color: activeTheme.textSecondary }}
                          >
                            <span className="font-mono text-[9px]">
                              {expandedHistoryNoteIds.includes(note.id) ? "▼" : "▶"}
                            </span>
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] font-bold border"
                              style={{
                                backgroundColor: activeTheme.bgSub,
                                borderColor: activeTheme.border,
                                color: activeTheme.textPrimary,
                              }}
                            >
                              ✏️ 訂正済み ({note.editHistory.length}回)
                            </span>
                            <span className="text-[10px]" style={{ color: activeTheme.textSecondary }}>
                              {expandedHistoryNoteIds.includes(note.id) ? "過去の文章を隠す" : "過去の文章を見る"}
                            </span>
                          </button>

                          {expandedHistoryNoteIds.includes(note.id) && (
                            <div
                              className="mt-2 p-2.5 rounded-xl border text-xs flex flex-col gap-2"
                              style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                            >
                              <div
                                className="text-[10px] font-bold pb-1 border-b flex items-center justify-between"
                                style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                              >
                                <span>📜 訂正前の思考ログ（不可逆アーカイブ）</span>
                                <span className="text-[9px]">※過去の思考も消えずに残ります</span>
                              </div>
                              {note.editHistory.map((history, idx) => (
                                <div
                                  key={history.id}
                                  className="text-[11px] p-2 rounded-lg border"
                                  style={{
                                    backgroundColor: activeTheme.bgCard,
                                    borderColor: activeTheme.border,
                                    color: activeTheme.textPrimary,
                                  }}
                                >
                                  <div
                                    className="flex items-center justify-between text-[10px] mb-1 font-mono"
                                    style={{ color: activeTheme.textSecondary }}
                                  >
                                    <span className="font-bold">第{note.editHistory!.length - idx}版</span>
                                    <time>{formatDate(history.editedAt)}</time>
                                  </div>
                                  <p
                                    className="line-through opacity-80 whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]"
                                    style={{
                                      color: activeTheme.textSecondary,
                                      fontFamily: getNoteFontFamilyStyle(noteFont),
                                    }}
                                  >
                                    {history.previousContent}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* 追記スレッド表示（デフォルトは折りたたみ） */}
                      {note.replies && note.replies.length > 0 && isContentVisible && (
                        <div className="mt-3 pt-2.5 border-t flex flex-col gap-2" style={{ borderColor: activeTheme.border }}>
                          <button
                            type="button"
                            onClick={() => handleToggleReplies(note.id)}
                            className="text-[11px] font-bold flex items-center justify-between w-full text-left py-1 px-1.5 rounded-lg transition-colors group cursor-pointer hover:opacity-80"
                            style={{ color: activeTheme.textPrimary }}
                          >
                            <span className="flex items-center gap-1.5">
                              <span>💬</span> 追記 ({note.replies.length}件)
                            </span>
                            <span
                              className="text-[10px] flex items-center gap-1 font-normal font-mono"
                              style={{ color: activeTheme.textSecondary }}
                            >
                              {expandedReplyNoteIds.includes(note.id) ? (
                                <>
                                  <span>たたむ</span>
                                  <span className="text-xs">▼</span>
                                </>
                              ) : (
                                <>
                                  <span>表示する</span>
                                  <span className="text-xs">▶</span>
                                </>
                              )}
                            </span>
                          </button>

                          {expandedReplyNoteIds.includes(note.id) && (
                            <div className="flex flex-col gap-2 pl-2.5 border-l-2" style={{ borderColor: activeTheme.border }}>
                              {note.replies.map((reply) => (
                                <div
                                  key={reply.id}
                                  className="p-2.5 rounded-xl border shadow-3xs"
                                  style={{
                                    backgroundColor: activeTheme.bgSub,
                                    borderColor: activeTheme.border,
                                    color: activeTheme.textPrimary,
                                  }}
                                >
                                  <div className="flex justify-end mb-1">
                                    <time className="text-[10px] font-mono" style={{ color: activeTheme.textSecondary }}>
                                      {formatDate(reply.createdAt)}
                                    </time>
                                  </div>
                                  <p
                                    className={`${
                                      fontSize === "large" ? "text-sm" : "text-xs"
                                    } whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]`}
                                    style={{
                                      color: activeTheme.textPrimary,
                                      fontFamily: getNoteFontFamilyStyle(noteFont),
                                    }}
                                  >
                                    {reply.content}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* 追記入力フォーム（「💬 追記する」を押した時だけスッと展開） */}
                      {replyingNoteId === note.id && (
                        <div className="mt-3 pt-2.5 border-t flex flex-col gap-2" style={{ borderColor: activeTheme.border }}>
                          <span className="text-[11px] font-bold flex items-center gap-1" style={{ color: activeTheme.textPrimary }}>
                            <span>💬</span> このメモに追記する
                          </span>
                          <textarea
                            rows={3}
                            placeholder="追記を入力..."
                            maxLength={MAX_NOTE_CONTENT_LENGTH}
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            className={`w-full ${
                              fontSize === "large" ? "text-sm p-3" : "text-xs p-2.5"
                            } rounded-xl border focus:outline-none resize-none transition-colors`}
                            style={{
                              backgroundColor: activeTheme.bgSub,
                              borderColor: activeTheme.border,
                              color: activeTheme.textPrimary,
                              fontFamily: getNoteFontFamilyStyle(noteFont),
                            }}
                            autoFocus
                          />
                          <LengthLimitHint
                            length={replyContent.length}
                            maxLength={MAX_NOTE_CONTENT_LENGTH}
                            warnThreshold={NOTE_LENGTH_WARN_THRESHOLD}
                            kind="body"
                            theme={activeTheme}
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setReplyingNoteId(null);
                                setReplyContent("");
                              }}
                              className={`${
                                buttonSize === "large" ? "px-3.5 py-1.5 text-xs" : "px-3 py-1 text-[11px]"
                              } rounded-lg font-medium transition-colors hover:opacity-80`}
                              style={{ color: activeTheme.textSecondary }}
                            >
                              キャンセル
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddReply(note.id)}
                              disabled={!replyContent.trim()}
                              className={`${
                                buttonSize === "large" ? "px-4 py-1.5 text-xs" : "px-3.5 py-1 text-[11px]"
                              } rounded-lg disabled:opacity-40 font-bold transition-all shadow-2xs`}
                              style={{
                                backgroundColor: activeTheme.accent,
                                color: activeTheme.accentText,
                              }}
                            >
                              追記を保存
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })
              )}
              </div>
            </div>
          </div>
        )}

        {/* ③ ゴミ箱画面（二層化） */}
        {activeTab === "trash" && (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <div className="flex items-center justify-between mb-3 pb-2 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <div>
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold`}
                  style={{ color: activeTheme.textPrimary }}
                >
                  ゴミ箱 ({trashNotes.length}件)
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  ※データは安全に保持されています
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } font-medium transition-colors hover:opacity-80`}
                style={{ color: activeTheme.textSecondary }}
              >
                ← ホームへ
              </button>
            </div>

            {/* スクロール領域（検索バーとメモが一緒に流れるため、下スクロールでメモが画面いっぱいに広がる） */}
            <div className="flex-1 overflow-y-auto pr-1 pb-16 flex flex-col">
              {/* 検索・絞り込み機能エリア（ゴミ箱内） */}
              {trashNotes.length > 0 && (
                !isTrashSearchPanelOpen ? (
                  <div className="mb-3 flex items-center justify-between shrink-0">
                    <button
                      type="button"
                      onClick={() => setIsTrashSearchPanelOpen(true)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all border`}
                      style={{
                        backgroundColor:
                          trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0
                            ? activeTheme.accent
                            : activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color:
                          trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0
                            ? activeTheme.accentText
                            : activeTheme.textSecondary,
                      }}
                    >
                      <span>🔍</span>
                      {trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0 ? (
                        <span>絞り込み中 ({displayedTrashNotes.length}件)</span>
                      ) : (
                        <span>検索機能</span>
                      )}
                    </button>
                    {(trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0) && (
                      <button
                        type="button"
                        onClick={() => {
                          setTrashFilterOnlyFavorite(false);
                          setTrashFilterCategories([]);
                          setTrashSearchQuery("");
                        }}
                        className="text-[11px] underline font-medium hover:opacity-80 transition-opacity"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        絞り込みを解除
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    className="mb-3 p-3.5 rounded-xl border shadow-xs flex flex-col gap-3 transition-all shrink-0"
                    style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                  >
                  {/* パネル上部: タイトル & とじるボタン */}
                  <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: activeTheme.border }}>
                    <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                      <span>🔍</span> ゴミ箱内の検索機能
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsTrashSearchPanelOpen(false)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs transition-colors hover:opacity-80"
                      style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                    >
                      <span>✕</span> とじる
                    </button>
                  </div>

                  {/* ① キーワード検索入力欄 */}
                  <div>
                    <span className="block text-[11px] font-bold mb-1.5" style={{ color: activeTheme.textSecondary }}>
                      🔤 キーワードで探す
                    </span>
                    <div className="relative flex items-center">
                      <input
                        type="text"
                        placeholder="タイトル、本文、追記から探す..."
                        value={trashSearchQuery}
                        onChange={(e) => setTrashSearchQuery(e.target.value)}
                        className={`w-full ${
                          fontSize === "large" ? "text-sm py-2 px-3 pr-8" : "text-xs py-1.5 px-2.5 pr-7"
                        } rounded-xl border focus:outline-none transition-colors`}
                        style={{
                          backgroundColor: activeTheme.bgSub,
                          borderColor: activeTheme.border,
                          color: activeTheme.textPrimary,
                        }}
                      />
                      {trashSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setTrashSearchQuery("")}
                          className="absolute right-2 text-xs p-1 font-bold hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                          title="入力をクリア"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ② お気に入り表示 */}
                  <div>
                    <span className="block text-[11px] font-bold mb-1.5" style={{ color: activeTheme.textSecondary }}>
                      ⭐ お気に入り
                    </span>
                    <button
                      type="button"
                      onClick={() => setTrashFilterOnlyFavorite(!trashFilterOnlyFavorite)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border ${
                        trashFilterOnlyFavorite ? "shadow-xs font-bold" : "hover:opacity-85"
                      }`}
                      style={{
                        backgroundColor: trashFilterOnlyFavorite ? activeTheme.accent : activeTheme.bgSub,
                        borderColor: trashFilterOnlyFavorite ? activeTheme.accent : activeTheme.border,
                        color: trashFilterOnlyFavorite ? activeTheme.accentText : activeTheme.textSecondary,
                      }}
                    >
                      <span>{trashFilterOnlyFavorite ? "★" : "☆"}</span>
                      {trashFilterOnlyFavorite ? "お気に入りのみ表示中" : "お気に入りのみ表示"}
                    </button>
                  </div>

                  {/* ③ カテゴリからさがす（折りたたみアコーディオン） */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setIsTrashSearchCategoryOpen(!isTrashSearchCategoryOpen)}
                      className="w-full flex items-center justify-between mb-1.5 text-left group"
                    >
                      <span className="text-[11px] font-bold flex items-center gap-1 transition-opacity hover:opacity-80" style={{ color: activeTheme.textSecondary }}>
                        <span>{isTrashSearchCategoryOpen ? "▼" : "▶"}</span> 🏷️ カテゴリからさがす
                      </span>
                      {trashFilterCategories.includes("uncategorized") ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-md border" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border, color: activeTheme.textSecondary }}>
                          ”未分類” のメモを表示中
                        </span>
                      ) : trashFilterCategories.length > 1 ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-md border" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border, color: activeTheme.textSecondary }}>
                          {trashFilterCategories.length}個のカテゴリで絞り込み中 (AND検索)
                        </span>
                      ) : null}
                    </button>
                    {isTrashSearchCategoryOpen && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {/* ”すべてのメモ” ボタン（全解除） */}
                        <button
                          type="button"
                          onClick={() => setTrashFilterCategories([])}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                            trashFilterCategories.length === 0
                              ? "shadow-xs font-bold"
                              : "hover:opacity-85"
                          }`}
                          style={{
                            backgroundColor: trashFilterCategories.length === 0 ? activeTheme.accent : activeTheme.bgSub,
                            borderColor: trashFilterCategories.length === 0 ? activeTheme.accent : activeTheme.border,
                            color: trashFilterCategories.length === 0 ? activeTheme.accentText : activeTheme.textSecondary,
                          }}
                        >
                          ”すべてのメモ”
                        </button>

                        {/* ”未分類” ボタン（単独選択） */}
                        {(() => {
                          const isUncategorizedSelected = trashFilterCategories.includes("uncategorized");
                          return (
                            <button
                              type="button"
                              onClick={() =>
                                setTrashFilterCategories(isUncategorizedSelected ? [] : ["uncategorized"])
                              }
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                                isUncategorizedSelected
                                  ? "shadow-xs font-bold"
                                  : "hover:opacity-85"
                              }`}
                              style={{
                                backgroundColor: isUncategorizedSelected ? activeTheme.accent : activeTheme.bgSub,
                                borderColor: isUncategorizedSelected ? activeTheme.accent : activeTheme.border,
                                color: isUncategorizedSelected ? activeTheme.accentText : activeTheme.textSecondary,
                              }}
                            >
                              ”未分類”
                            </button>
                          );
                        })()}

                        {/* 各カテゴリボタン（トグル複数AND選択：並び順設定を反映） */}
                        {sortedCategories.map((cat) => {
                          const isSelected = trashFilterCategories.includes(cat.id);
                          return (
                            <button
                              key={cat.id}
                              type="button"
                              onClick={() =>
                                setTrashFilterCategories((prev) => {
                                  const withoutUncategorized = prev.filter((c) => c !== "uncategorized");
                                  return isSelected
                                    ? withoutUncategorized.filter((c) => c !== cat.id)
                                    : [...withoutUncategorized, cat.id];
                                })
                              }
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                                isSelected
                                  ? "shadow-xs font-bold"
                                  : "hover:opacity-85"
                              }`}
                              style={{
                                backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgSub,
                                borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                                color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                              }}
                            >
                              {cat.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* ヒット件数 */}
                  {(trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0) && (
                    <div className="text-[11px] pt-1 border-t flex items-center justify-between" style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}>
                      <span>該当するメモ: {displayedTrashNotes.length}件</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTrashFilterOnlyFavorite(false);
                          setTrashFilterCategories([]);
                          setTrashSearchQuery("");
                        }}
                        className="text-[11px] underline hover:opacity-80"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        条件をリセット
                      </button>
                    </div>
                  )}
                </div>
              )
            )}

              {/* メモ一覧カードリスト */}
              <div className="flex flex-col gap-3 min-w-0">
              {trashNotes.length === 0 ? (
                <div className="text-center py-10 text-sm" style={{ color: activeTheme.textSecondary }}>
                  ゴミ箱は空です。
                </div>
              ) : displayedTrashNotes.length === 0 ? (
                <div
                  className="text-center py-10 text-xs rounded-xl border border-dashed p-4"
                  style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                >
                  条件に一致するメモが見つかりませんでした。<br />
                  <button
                    type="button"
                    onClick={() => {
                      setTrashFilterOnlyFavorite(false);
                      setTrashFilterCategories([]);
                      setTrashSearchQuery("");
                    }}
                    className="mt-2 text-xs font-bold underline hover:opacity-80"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    条件をリセットして全件表示
                  </button>
                </div>
              ) : (
                displayedTrashNotes.map((note) => {
                  const isTrashVisible = isNoteContentVisible(note);
                  return (
                  <article
                    key={note.id}
                    className="w-full min-w-0 p-4 rounded-xl border opacity-90 transition-colors"
                    style={{
                      backgroundColor: activeTheme.bgCard,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                        <h3
                          className={`font-bold min-w-0 max-w-full break-all [overflow-wrap:anywhere] ${
                            fontSize === "large" ? "text-base" : "text-sm"
                          }`}
                          style={{ color: activeTheme.textPrimary }}
                        >
                          {note.title ? (
                            isTrashVisible || !maskLockedTitle ? (
                              note.title
                            ) : (
                              maskLockedText(note.title)
                            )
                          ) : (
                            <span className="opacity-50 font-normal italic">（無題）</span>
                          )}
                        </h3>
                        {note.isLocked && (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded font-medium border shrink-0"
                            style={{
                              backgroundColor: activeTheme.bgSub,
                              borderColor: activeTheme.border,
                              color: activeTheme.textSecondary,
                            }}
                          >
                            {isTrashVisible ? "🔓 解除中" : "🔒 ロック中"}
                          </span>
                        )}
                      </div>
                      <time
                        className={`${
                          fontSize === "large" ? "text-xs" : "text-[11px]"
                        } shrink-0 font-mono`}
                        style={{ color: activeTheme.textSecondary }}
                      >
                        {formatDate(note.createdAt)}
                      </time>
                    </div>

                    {/* カテゴリタグ一覧 */}
                    {note.categories && note.categories.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {note.categories.map((cat) => (
                          <span
                            key={cat}
                            className="text-[10px] px-2 py-0.5 rounded-md font-medium border"
                            style={{
                              backgroundColor: activeTheme.bgSub,
                              borderColor: activeTheme.border,
                              color: activeTheme.textSecondary,
                            }}
                          >
                            🏷️ {getCategoryName(cat)}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="mb-2">
                      <CollapsibleNoteBody
                        text={isTrashVisible ? note.content : maskLockedText(note.content)}
                        maxLines={noteCollapseLines}
                        isExpanded={expandedBodyNoteIds.includes(note.id)}
                        onToggle={() => handleToggleNoteBody(note.id)}
                        isMasked={!isTrashVisible}
                        accentColor={activeTheme.accent}
                        className={`${
                          fontSize === "large" ? "text-base" : "text-sm"
                        } whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere] ${
                          !isTrashVisible ? "break-all select-none opacity-80 tracking-wider" : ""
                        }`}
                        style={{
                          color: activeTheme.textPrimary,
                          fontFamily: getNoteFontFamilyStyle(noteFont),
                        }}
                      />
                    </div>

                    {note.isLocked && (
                      <div className="mb-2 flex items-center justify-end">
                        {isTrashVisible ? (
                          <button
                            type="button"
                            onClick={() => handleHideUnlockedNote(note.id)}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium border flex items-center gap-1 transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: activeTheme.bgSub,
                              borderColor: activeTheme.border,
                              color: activeTheme.textSecondary,
                            }}
                          >
                            <span>🔒</span> 非表示にする
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRequestUnlockNote(note.id)}
                            className="px-3 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1 shadow-2xs transition-opacity hover:opacity-90"
                            style={{
                              backgroundColor: activeTheme.accent,
                              color: activeTheme.accentText,
                            }}
                          >
                            <span>🔓</span> {isLockSessionVerified ? "タップして表示" : "ロック解除して読む"}
                          </button>
                        )}
                      </div>
                    )}

                    {/* 訂正履歴表示（過去の文章をいつでも確認・振り返り可能） */}
                    {note.editHistory && note.editHistory.length > 0 && isTrashVisible && (
                      <div className="mt-2 pt-1.5 border-t border-dashed" style={{ borderColor: activeTheme.border }}>
                        <button
                          type="button"
                          onClick={() => handleToggleEditHistory(note.id)}
                          className="text-[11px] flex items-center gap-1 font-medium transition-colors cursor-pointer group hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                        >
                          <span className="font-mono text-[9px]">
                            {expandedHistoryNoteIds.includes(note.id) ? "▼" : "▶"}
                          </span>
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px] font-bold border"
                            style={{
                              backgroundColor: activeTheme.bgSub,
                              borderColor: activeTheme.border,
                              color: activeTheme.textPrimary,
                            }}
                          >
                            ✏️ 訂正済み ({note.editHistory.length}回)
                          </span>
                          <span className="text-[10px]" style={{ color: activeTheme.textSecondary }}>
                            {expandedHistoryNoteIds.includes(note.id) ? "過去の文章を隠す" : "過去の文章を見る"}
                          </span>
                        </button>

                        {expandedHistoryNoteIds.includes(note.id) && (
                          <div
                            className="mt-2 p-2.5 rounded-xl border text-xs flex flex-col gap-2"
                            style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                          >
                            <div
                              className="text-[10px] font-bold pb-1 border-b flex items-center justify-between"
                              style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                            >
                              <span>📜 訂正前の思考ログ（不可逆アーカイブ）</span>
                              <span className="text-[9px]">※過去の思考も消えずに残ります</span>
                            </div>
                            {note.editHistory.map((history, idx) => (
                              <div
                                key={history.id}
                                className="text-[11px] p-2 rounded-lg border"
                                style={{
                                  backgroundColor: activeTheme.bgCard,
                                  borderColor: activeTheme.border,
                                  color: activeTheme.textPrimary,
                                }}
                              >
                                <div
                                  className="flex items-center justify-between text-[10px] mb-1 font-mono"
                                  style={{ color: activeTheme.textSecondary }}
                                >
                                  <span className="font-bold">第{note.editHistory!.length - idx}版</span>
                                  <time>{formatDate(history.editedAt)}</time>
                                </div>
                                <p
                                  className="line-through opacity-80 whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]"
                                  style={{
                                    color: activeTheme.textSecondary,
                                    fontFamily: getNoteFontFamilyStyle(noteFont),
                                  }}
                                >
                                  {history.previousContent}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 追記スレッド表示（デフォルトは折りたたみ） */}
                    {note.replies && note.replies.length > 0 && isTrashVisible && (
                      <div className="mt-2 mb-3 pt-2 border-t flex flex-col gap-2" style={{ borderColor: activeTheme.border }}>
                        <button
                          type="button"
                          onClick={() => handleToggleReplies(note.id)}
                          className="text-[11px] font-bold flex items-center justify-between w-full text-left py-1 px-1.5 rounded-lg transition-colors group cursor-pointer hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                        >
                          <span className="flex items-center gap-1.5">
                            <span>💬</span> 追記 ({note.replies.length}件)
                          </span>
                          <span className="text-[10px] flex items-center gap-1 font-normal font-mono">
                            {expandedReplyNoteIds.includes(note.id) ? (
                              <>
                                <span>たたむ</span>
                                <span className="text-xs">▼</span>
                              </>
                            ) : (
                              <>
                                <span>表示する</span>
                                <span className="text-xs">▶</span>
                              </>
                            )}
                          </span>
                        </button>

                        {expandedReplyNoteIds.includes(note.id) && (
                          <div className="flex flex-col gap-1.5 pl-2.5 border-l-2" style={{ borderColor: activeTheme.border }}>
                            {note.replies.map((reply) => (
                              <div
                                key={reply.id}
                                className="p-2 rounded-lg border text-xs"
                                style={{
                                  backgroundColor: activeTheme.bgSub,
                                  borderColor: activeTheme.border,
                                  color: activeTheme.textPrimary,
                                }}
                              >
                                <div className="flex justify-end mb-0.5">
                                  <time className="text-[10px] font-mono" style={{ color: activeTheme.textSecondary }}>
                                    {formatDate(reply.createdAt)}
                                  </time>
                                </div>
                                <p
                                  className="whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]"
                                  style={{ fontFamily: getNoteFontFamilyStyle(noteFont) }}
                                >
                                  {reply.content}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex justify-end pt-2 border-t" style={{ borderColor: activeTheme.border }}>
                      <button
                        type="button"
                        onClick={() => handleRestoreFromTrash(note.id)}
                        className={`${
                          buttonSize === "large"
                            ? "text-sm px-4 py-2"
                            : "text-xs px-3 py-1"
                        } rounded-lg transition-colors flex items-center gap-1 font-medium border hover:opacity-85`}
                        style={{
                          backgroundColor: activeTheme.bgSub,
                          borderColor: activeTheme.border,
                          color: activeTheme.textPrimary,
                        }}
                      >
                        <span>↩️</span> 元に戻す
                      </button>
                    </div>
                  </article>
                  );
                })
              )}
              </div>
            </div>
          </div>
        )}

        {/* ③-2 カテゴリ管理画面（二層化） */}
        {activeTab === "categories" && (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <div className="flex items-center justify-between mb-3 pb-2 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <div>
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold`}
                  style={{ color: activeTheme.textPrimary }}
                >
                  カテゴリ管理 ({activeCategories.length}件)
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  メモを分類するカテゴリの作成・並び順設定ができます
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } font-medium transition-colors hover:opacity-80`}
                style={{ color: activeTheme.textSecondary }}
              >
                ← ホームへ
              </button>
            </div>

            {/* 新規カテゴリ作成フォーム */}
            <div
              className="mb-4 p-3.5 rounded-xl border shrink-0 transition-colors"
              style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            >
              <span className="block text-xs font-bold mb-2" style={{ color: activeTheme.textPrimary }}>
                新しいカテゴリを追加（{MAX_CATEGORY_NAME_LENGTH}文字まで）
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="カテゴリ名を入力..."
                  maxLength={MAX_CATEGORY_NAME_LENGTH}
                  value={newCategoryInput}
                  onChange={(e) => setNewCategoryInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateCategoryFromManagement();
                    }
                  }}
                  className={`flex-1 ${
                    fontSize === "large" ? "text-sm px-3.5 py-2" : "text-xs px-3 py-1.5"
                  } rounded-xl border focus:outline-none transition-colors`}
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                  }}
                />
                <button
                  type="button"
                  onClick={handleCreateCategoryFromManagement}
                  className={`${
                    buttonSize === "large" ? "px-5 py-2 text-sm" : "px-4 py-1.5 text-xs"
                  } rounded-xl font-bold transition-all shadow-xs shrink-0`}
                  style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                >
                  追加
                </button>
              </div>
            </div>

            {/* エリアの仕切り線 */}
            <div className="border-b mb-3 shrink-0" style={{ borderColor: activeTheme.border }} />

            {/* 登録済みカテゴリ一覧ヘッダー & 並び順切り替え */}
            <div className="flex items-center justify-between mb-2 shrink-0 flex-wrap gap-2">
              <span className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                登録済みカテゴリ ({activeCategories.length}件)
              </span>
              <div
                className="flex items-center gap-1 p-0.5 rounded-lg border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("usage")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "usage"
                      ? "shadow-2xs font-bold"
                      : "hover:opacity-80"
                  }`}
                  style={{
                    backgroundColor: categorySortOrder === "usage" ? activeTheme.accent : "transparent",
                    color: categorySortOrder === "usage" ? activeTheme.accentText : activeTheme.textSecondary,
                  }}
                  title="メモ件数が多い順に並べる"
                >
                  🔥 よく使う順
                </button>
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("alphabetical")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "alphabetical"
                      ? "shadow-2xs font-bold"
                      : "hover:opacity-80"
                  }`}
                  style={{
                    backgroundColor: categorySortOrder === "alphabetical" ? activeTheme.accent : "transparent",
                    color: categorySortOrder === "alphabetical" ? activeTheme.accentText : activeTheme.textSecondary,
                  }}
                  title="あいうえお順に並べる"
                >
                  🔤 五十音順
                </button>
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("created")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "created"
                      ? "shadow-2xs font-bold"
                      : "hover:opacity-80"
                  }`}
                  style={{
                    backgroundColor: categorySortOrder === "created" ? activeTheme.accent : "transparent",
                    color: categorySortOrder === "created" ? activeTheme.accentText : activeTheme.textSecondary,
                  }}
                  title="作成した順に並べる"
                >
                  🕒 登録順
                </button>
              </div>
            </div>

            {/* 登録済みカテゴリ一覧 */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 pb-12 flex flex-col gap-2">
              {activeCategories.length === 0 ? (
                <div
                  className="text-center py-8 text-xs rounded-xl border border-dashed p-4"
                  style={{
                    backgroundColor: activeTheme.bgCard,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  まだ登録されたカテゴリはありません。<br />
                  上の入力欄から追加するか、メモを書くときに「＋ 新規」から作成できます。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {sortedCategories.map((cat) => {
                    const count = notes.filter(
                      (n) => !n.isTrash && n.categories && n.categories.includes(cat.id)
                    ).length;

                    return (
                      <div
                        key={cat.id}
                        className="flex items-center justify-between p-3 rounded-xl border transition-colors"
                        style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                            🏷️ {cat.name}
                          </span>
                          <span className="text-[11px] font-mono" style={{ color: activeTheme.textSecondary }}>
                            ({count}件のメモ)
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setCategoryToRename(cat);
                              setRenameCategoryInput(cat.name);
                              setRenameCategoryError(null);
                            }}
                            className="w-7 h-7 flex items-center justify-center rounded-lg transition-colors text-xs hover:opacity-80"
                            style={{ color: activeTheme.textSecondary }}
                            title="カテゴリ名を変更"
                            aria-label={`${cat.name}の名前を変更`}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            onClick={() => setCategoryToDelete(cat)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:text-[#b85448] transition-colors text-xs font-bold hover:opacity-80"
                            style={{ color: activeTheme.textSecondary }}
                            title="カテゴリを消去"
                            aria-label={`${cat.name}を消去`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ④ 設定画面 */}
        {activeTab === "settings" && (
          <div
            className="rounded-2xl p-6 border shadow-sm transition-colors"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
          >
            <div className="flex items-center justify-between mb-6 pb-2 border-b" style={{ borderColor: activeTheme.border }}>
              <h2
                className={`${
                  fontSize === "large" ? "text-xl" : "text-lg"
                } font-bold`}
                style={{ color: activeTheme.textPrimary }}
              >
                設定
              </h2>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } hover:opacity-80 transition-opacity`}
                style={{ color: activeTheme.textSecondary }}
              >
                ← ホームへ
              </button>
            </div>

            <div className="flex flex-col gap-4 text-sm">
              {/* テーマカラー設定（アコーディオン形式：タップで広げる方式） */}
              <div
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                className="rounded-xl border shadow-xs overflow-hidden transition-colors"
              >
                <button
                  type="button"
                  onClick={() => setIsThemeAccordionOpen(!isThemeAccordionOpen)}
                  className="w-full p-4 flex items-center justify-between text-left hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <div>
                    <span className="font-bold block text-sm" style={{ color: activeTheme.textPrimary }}>
                      🎨 テーマカラー設定
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className="text-xs font-mono font-bold px-2.5 py-1 rounded-md border shadow-2xs"
                      style={{
                        backgroundColor: activeTheme.bgCard,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    >
                      {activeTheme.name}
                    </span>
                    <span
                      className={`text-xs transition-transform duration-200 ${
                        isThemeAccordionOpen ? "rotate-90" : ""
                      }`}
                      style={{ color: activeTheme.textSecondary }}
                    >
                      ▶
                    </span>
                  </div>
                </button>

                {isThemeAccordionOpen && (
                  <div className="p-4 pt-1 border-t flex flex-col gap-3" style={{ borderColor: activeTheme.border }}>
                    {/* 明るさトーン選択（パステル調／ダーク調） */}
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs font-bold" style={{ color: activeTheme.textSecondary }}>
                        トーン:
                      </span>
                      <div
                        className="flex gap-1 p-1 rounded-lg border transition-colors"
                        style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                      >
                        <button
                          type="button"
                          onClick={() => handleChangeTheme(selectedHue === "black" ? "cream" : selectedHue, "pastel")}
                          className="px-3 py-1 text-xs rounded-md font-bold transition-all"
                          style={{
                            backgroundColor:
                              themeBrightness === "pastel" && selectedHue !== "black" ? "#e8e2d5" : "transparent",
                            color:
                              themeBrightness === "pastel" && selectedHue !== "black"
                                ? "#2d2926"
                                : activeTheme.textSecondary,
                            boxShadow:
                              themeBrightness === "pastel" && selectedHue !== "black"
                                ? "0 1px 2px rgba(0,0,0,0.15)"
                                : "none",
                          }}
                        >
                          ☀️ パステル調（淡色）
                        </button>
                        <button
                          type="button"
                          onClick={() => handleChangeTheme(selectedHue === "cream" ? "black" : selectedHue, "dark")}
                          className="px-3 py-1 text-xs rounded-md font-bold transition-all"
                          style={{
                            backgroundColor:
                              themeBrightness === "dark" || selectedHue === "black" ? "#e8e2d5" : "transparent",
                            color:
                              themeBrightness === "dark" || selectedHue === "black"
                                ? "#2d2926"
                                : activeTheme.textSecondary,
                            boxShadow:
                              themeBrightness === "dark" || selectedHue === "black"
                                ? "0 1px 2px rgba(0,0,0,0.15)"
                                : "none",
                          }}
                        >
                          🌙 ダーク調（深色）
                        </button>
                      </div>
                    </div>

                    {/* 基本カラー（標準クリーム ＆ 黒） */}
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs font-bold shrink-0" style={{ color: activeTheme.textSecondary }}>
                        基本色:
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleChangeTheme("cream", "pastel")}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
                            selectedHue === "cream"
                              ? "ring-2 ring-[#3d3731] font-bold shadow-xs scale-102"
                              : "hover:opacity-85"
                          }`}
                          style={{ backgroundColor: "#e8e2d5", color: "#2d2926", borderColor: "#c7bcac" }}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-black/20 transition-colors"
                            style={{ backgroundColor: selectedHue === "cream" ? "#3d3731" : "#f2efe9" }}
                          />
                          <span>標準クリーム</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleChangeTheme("black", "dark")}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
                            selectedHue === "black"
                              ? "ring-2 ring-white font-bold shadow-xs scale-102"
                              : "hover:opacity-85"
                          }`}
                          style={{ backgroundColor: "#1a1918", color: "#eae5dc", borderColor: "#3d3935" }}
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-white/20 transition-colors"
                            style={{ backgroundColor: selectedHue === "black" ? "#d49e35" : "#262422" }}
                          />
                          <span>黒（ダークモード）</span>
                        </button>
                      </div>
                    </div>

                    {/* 10色のカラーパレット */}
                    <div className="pt-2 border-t" style={{ borderColor: activeTheme.border }}>
                      <span className="text-xs font-bold block mb-2" style={{ color: activeTheme.textSecondary }}>
                        10色のカラーパレット ({themeBrightness === "pastel" ? "パステル調" : "ダーク調"}):
                      </span>
                      <div className="grid grid-cols-5 sm:grid-cols-10 gap-1.5">
                        {HUE_OPTIONS.map((opt) => {
                          const isSelected = selectedHue === opt.id;
                          const optPalette = getThemePalette(opt.id, themeBrightness);
                          // イラストの指定：選択前は淡い色、選択後は濃い色（ダーク調は彩度の上がった鮮やかな色）
                          const dotColor = isSelected
                            ? optPalette.accent
                            : themeBrightness === "pastel"
                            ? opt.pastelDot
                            : opt.darkDot;

                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => handleChangeTheme(opt.id)}
                              className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border transition-all cursor-pointer ${
                                isSelected
                                  ? "shadow-sm scale-105"
                                  : "hover:scale-102 hover:opacity-85"
                              }`}
                              style={{
                                backgroundColor: activeTheme.bgCard,
                                borderColor: isSelected ? optPalette.accent : activeTheme.border,
                              }}
                              title={`${opt.label}（${themeBrightness === "pastel" ? "パステル" : "ダーク"}）`}
                            >
                              <span
                                className={`w-5 h-5 rounded-full transition-all border shadow-2xs ${
                                  isSelected ? "scale-110 shadow-sm" : ""
                                }`}
                                style={{
                                  backgroundColor: dotColor,
                                  borderColor: isSelected
                                    ? optPalette.accent
                                    : themeBrightness === "pastel"
                                    ? "rgba(0,0,0,0.15)"
                                    : "rgba(255,255,255,0.2)",
                                }}
                              />
                              <span
                                className={`text-[10px] leading-tight ${
                                  isSelected ? "font-bold" : "font-normal"
                                }`}
                                style={{ color: isSelected ? optPalette.accent : activeTheme.textPrimary }}
                              >
                                {opt.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 文字の大きさ */}
              <div
                className="flex items-center justify-between p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>文字の大きさ</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>メモの本文や入力欄の文字サイズ</span>
                </div>
                <div
                  className="flex gap-1.5 p-1 rounded-lg border transition-colors"
                  style={{ backgroundColor: activeTheme.bgApp, borderColor: activeTheme.border }}
                >
                  <button
                    type="button"
                    onClick={() => handleFontSizeChange("normal")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      fontSize === "normal" ? "shadow-xs font-bold" : "hover:opacity-80"
                    }`}
                    style={{
                      backgroundColor: fontSize === "normal" ? activeTheme.accent : "transparent",
                      color: fontSize === "normal" ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    標準
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFontSizeChange("large")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      fontSize === "large" ? "shadow-xs font-bold" : "hover:opacity-80"
                    }`}
                    style={{
                      backgroundColor: fontSize === "large" ? activeTheme.accent : "transparent",
                      color: fontSize === "large" ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    大きめ
                  </button>
                </div>
              </div>

              {/* 文字フォント */}
              <div
                className="flex items-center justify-between p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>文字フォント</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>画面全体の文字の書体・雰囲気</span>
                </div>
                <div
                  className="flex gap-1.5 p-1 rounded-lg border transition-colors"
                  style={{ backgroundColor: activeTheme.bgApp, borderColor: activeTheme.border }}
                >
                  {[
                    { id: "sans" as FontFamily, label: "ゴシック" },
                    { id: "serif" as FontFamily, label: "明朝体" },
                    { id: "rounded" as FontFamily, label: "丸ゴシック" },
                  ].map((f) => {
                    const isSelected = fontFamily === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setFontFamily(f.id);
                          localStorage.setItem("seednote_font_family", f.id);
                          saveCloudSettings({ font_family: f.id }, true);
                        }}
                        className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                          isSelected ? "shadow-xs font-bold" : "hover:opacity-80"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : "transparent",
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* メモ本文のフォント */}
              <div
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>📝 メモ本文のフォント</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>メモや追記の入力・表示の書体</span>
                </div>
                <div
                  className="flex flex-wrap gap-1.5 p-1 rounded-lg border transition-colors"
                  style={{ backgroundColor: activeTheme.bgApp, borderColor: activeTheme.border }}
                >
                  {[
                    { id: "sans" as NoteFontFamily, label: "標準" },
                    { id: "klee" as NoteFontFamily, label: "手帳ペン字" },
                    { id: "yomogi" as NoteFontFamily, label: "ほっこり手書き" },
                    { id: "mincho" as NoteFontFamily, label: "読書明朝" },
                    { id: "mono" as NoteFontFamily, label: "レトロ等幅" },
                  ].map((f) => {
                    const isSelected = noteFont === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setNoteFont(f.id);
                          localStorage.setItem("seednote_note_font", f.id);
                          saveCloudSettings({ note_font: f.id }, true);
                        }}
                        className={`px-2.5 py-1.5 text-xs rounded-md font-medium transition-all ${
                          isSelected ? "shadow-xs font-bold" : "hover:opacity-80"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : "transparent",
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                          fontFamily: getNoteFontFamilyStyle(f.id),
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ボタンの大きさ */}
              <div
                className="flex items-center justify-between p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>ボタンの大きさ</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>メニューや保存ボタンなどの押しやすさ</span>
                </div>
                <div
                  className="flex gap-1.5 p-1 rounded-lg border transition-colors"
                  style={{ backgroundColor: activeTheme.bgApp, borderColor: activeTheme.border }}
                >
                  <button
                    type="button"
                    onClick={() => handleButtonSizeChange("normal")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      buttonSize === "normal" ? "shadow-xs font-bold" : "hover:opacity-80"
                    }`}
                    style={{
                      backgroundColor: buttonSize === "normal" ? activeTheme.accent : "transparent",
                      color: buttonSize === "normal" ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    標準
                  </button>
                  <button
                    type="button"
                    onClick={() => handleButtonSizeChange("large")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      buttonSize === "large" ? "shadow-xs font-bold" : "hover:opacity-80"
                    }`}
                    style={{
                      backgroundColor: buttonSize === "large" ? activeTheme.accent : "transparent",
                      color: buttonSize === "large" ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    大きめ
                  </button>
                </div>
              </div>

              {/* 長文メモの折りたたみ */}
              <div
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>
                    長文メモの折りたたみ
                  </span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>
                    一覧やゴミ箱で長いメモを折りたたむ行数
                  </span>
                </div>
                <div
                  className="flex gap-1 p-1 rounded-lg border transition-colors self-start sm:self-auto"
                  style={{ backgroundColor: activeTheme.bgApp, borderColor: activeTheme.border }}
                >
                  {(
                    [
                      { value: 0, label: "なし" },
                      { value: 5, label: "5行" },
                      { value: 8, label: "8行" },
                      { value: 12, label: "12行" },
                    ] as { value: NoteCollapseLines; label: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleNoteCollapseLinesChange(opt.value)}
                      className={`px-2.5 py-1.5 text-xs rounded-md font-medium transition-all ${
                        noteCollapseLines === opt.value ? "shadow-xs font-bold" : "hover:opacity-80"
                      }`}
                      style={{
                        backgroundColor: noteCollapseLines === opt.value ? activeTheme.accent : "transparent",
                        color: noteCollapseLines === opt.value ? activeTheme.accentText : activeTheme.textSecondary,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 保存通知 */}
              <div
                className="flex items-center justify-between p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>保存通知</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>メモ保存時に「保存しました」を表示する</span>
                </div>
                <input
                  type="checkbox"
                  checked={enableToast}
                  onChange={(e) => handleToggleToast(e.target.checked)}
                  className="w-4 h-4 cursor-pointer"
                  style={{ accentColor: activeTheme.accent }}
                />
              </div>

              {/* 編集破棄の確認 */}
              <div
                className="flex items-center justify-between p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div>
                  <span className="font-medium block" style={{ color: activeTheme.textPrimary }}>編集破棄の確認</span>
                  <span className="text-xs" style={{ color: activeTheme.textSecondary }}>タイトルやカテゴリを変更中に保存せず閉じる際、確認ダイアログを表示する</span>
                </div>
                <input
                  type="checkbox"
                  checked={confirmDiscardOnEdit}
                  onChange={(e) => handleToggleConfirmDiscard(e.target.checked)}
                  className="w-4 h-4 cursor-pointer"
                  style={{ accentColor: activeTheme.accent }}
                />
              </div>

              {/* 時間帯の設定（アコーディオン形式で折りたたみ可能） */}
              <div
                className="rounded-xl border overflow-hidden transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <button
                  type="button"
                  onClick={() => setIsTimeSlotsAccordionOpen(!isTimeSlotsAccordionOpen)}
                  className="w-full p-4 flex items-center justify-between text-left hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <div>
                    <span className="font-bold block" style={{ color: activeTheme.textPrimary }}>
                      ⏰ 時間帯の設定
                    </span>
                    <span className="text-xs" style={{ color: activeTheme.textSecondary }}>
                      {isTimeSlotsAccordionOpen
                        ? "バーの操作やボタンで、生活リズムに合わせて調整できます（重なりOK）"
                        : "生活リズムに合わせて調整（タップして設定を展開）"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!isTimeSlotsAccordionOpen && (
                      <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                        5つの時間帯
                      </span>
                    )}
                    <span
                      className={`text-xs transition-transform duration-200 ${
                        isTimeSlotsAccordionOpen ? "rotate-90" : ""
                      }`}
                      style={{ color: activeTheme.textSecondary }}
                    >
                      ▶
                    </span>
                  </div>
                </button>

                {isTimeSlotsAccordionOpen && (
                  <div className="p-4 pt-1 border-t" style={{ borderColor: activeTheme.border }}>
                    <div className="flex justify-end pt-1 mb-2">
                      <button
                        type="button"
                        onClick={handleResetTimeSlots}
                        className="text-xs px-2.5 py-1 rounded-lg transition-colors font-medium shrink-0 border hover:opacity-85"
                        style={{
                          backgroundColor: activeTheme.bgCard,
                          borderColor: activeTheme.border,
                          color: activeTheme.textSecondary,
                        }}
                      >
                        標準に戻す
                      </button>
                    </div>

                    {/* ── 24時間タイムラインバー ── */}
                    <div
                      className="my-4 p-3 rounded-xl border transition-colors"
                      style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                          <span>📊 24時間タイムライン</span>
                          <span className="text-[10px] font-normal" style={{ color: activeTheme.textSecondary }}>
                            （タップで時間帯を選択・調整）
                          </span>
                        </span>
                        <span className="text-[11px] font-medium" style={{ color: activeTheme.textSecondary }}>
                          調整中: <span className="font-bold" style={{ color: activeTheme.textPrimary }}>{timeSlots[selectedSlotForEdit]?.icon} {timeSlots[selectedSlotForEdit]?.label}</span>
                        </span>
                      </div>

                      {/* タイムライン上部の目盛りラベル (0:00, 6:00, 12:00, 18:00, 24:00) */}
                      <div className="relative h-4 text-[10px] font-mono select-none" style={{ color: activeTheme.textSecondary }}>
                        <span className="absolute left-0 -translate-x-0">0:00</span>
                        <span className="absolute left-1/4 -translate-x-1/2">6:00</span>
                        <span className="absolute left-2/4 -translate-x-1/2">12:00</span>
                        <span className="absolute left-3/4 -translate-x-1/2">18:00</span>
                        <span className="absolute right-0 translate-x-0">24:00</span>
                      </div>

                      {/* ピン配置エリア（選択中の時間帯の開始・終了ピン） */}
                      <div className="relative h-7 select-none">
                        {/* 開始ピン */}
                        {(() => {
                          const cur = timeSlots[selectedSlotForEdit] || DEFAULT_TIME_SLOTS[selectedSlotForEdit];
                          const leftPercent = (cur.startHour / 24) * 100;
                          return (
                            <div
                              className="absolute bottom-0 -translate-x-1/2 flex flex-col items-center cursor-ew-resize z-20 touch-none group"
                              style={{ left: `${leftPercent}%` }}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.currentTarget.setPointerCapture(e.pointerId);
                              }}
                              onPointerMove={(e) => {
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                  const track = e.currentTarget.parentElement?.nextElementSibling;
                                  if (track) {
                                    const rect = track.getBoundingClientRect();
                                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                                    const hour = Math.min(23, Math.max(0, Math.floor((x / rect.width) * 24)));
                                    handleUpdateTimeSlot(selectedSlotForEdit, "startHour", hour);
                                  }
                                }
                              }}
                              onPointerUp={(e) => {
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                  e.currentTarget.releasePointerCapture(e.pointerId);
                                }
                              }}
                            >
                              <div
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white shadow-sm flex items-center gap-0.5 whitespace-nowrap"
                                style={{ backgroundColor: cur.color }}
                              >
                                <span>◀</span>
                                <span>開始 {cur.startHour}:00</span>
                                <span>▶</span>
                              </div>
                              <div
                                className="w-1.5 h-1.5 rotate-45 -mt-0.5"
                                style={{ backgroundColor: cur.color }}
                              />
                            </div>
                          );
                        })()}
                      </div>

                      {/* 24時間のカラーバー本体（24分割） */}
                      <div
                        data-timeline-track
                        className="w-full h-9 rounded-lg overflow-hidden border flex shadow-inner relative cursor-pointer"
                        style={{ borderColor: activeTheme.border }}
                      >
                        {Array.from({ length: 24 }, (_, h) => {
                          const activeSlots = (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[])
                            .map((k) => timeSlots[k] || DEFAULT_TIME_SLOTS[k])
                            .filter((s) => isHourInSlotDef(h, s));
                          const activeLabels = activeSlots.map((s) => s.label).join("・");
                          const bgStyle = getHourBackgroundStyle(h);
                          const isHourInSelected = isHourInSlotDef(
                            h,
                            timeSlots[selectedSlotForEdit] || DEFAULT_TIME_SLOTS[selectedSlotForEdit]
                          );

                          return (
                            <div
                              key={h}
                              onClick={() => {
                                if (activeSlots.length > 0) {
                                  const matchingKey = (Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).find(
                                    (k) => isHourInSlotDef(h, timeSlots[k] || DEFAULT_TIME_SLOTS[k])
                                  );
                                  if (matchingKey) setSelectedSlotForEdit(matchingKey);
                                }
                              }}
                              title={`${h}:00〜${h}:59\n該当: ${activeLabels || "（未設定）"}`}
                              style={bgStyle}
                              className={`flex-1 h-full border-r border-black/10 last:border-r-0 relative transition-opacity ${
                                isHourInSelected ? "opacity-100" : "opacity-85 hover:opacity-100"
                              }`}
                            >
                              {/* 選択中の時間帯に属している場合の控えめなドット */}
                              {isHourInSelected && (
                                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white/90 shadow-xs pointer-events-none" />
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* ピン配置エリア（選択中の時間帯の終了ピン） */}
                      <div className="relative h-7 select-none">
                        {(() => {
                          const cur = timeSlots[selectedSlotForEdit] || DEFAULT_TIME_SLOTS[selectedSlotForEdit];
                          const endRightPercent = ((cur.endHour + 1) / 24) * 100;
                          return (
                            <div
                              className="absolute top-0 -translate-x-1/2 flex flex-col items-center cursor-ew-resize z-20 touch-none group"
                              style={{ left: `${endRightPercent}%` }}
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.currentTarget.setPointerCapture(e.pointerId);
                              }}
                              onPointerMove={(e) => {
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                  const track = e.currentTarget.parentElement?.previousElementSibling;
                                  if (track) {
                                    const rect = track.getBoundingClientRect();
                                    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                                    const hour = Math.min(23, Math.max(0, Math.floor((x / rect.width) * 24)));
                                    handleUpdateTimeSlot(selectedSlotForEdit, "endHour", hour);
                                  }
                                }
                              }}
                              onPointerUp={(e) => {
                                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                                  e.currentTarget.releasePointerCapture(e.pointerId);
                                }
                              }}
                            >
                              <div
                                className="w-1.5 h-1.5 rotate-45 -mb-0.5"
                                style={{ backgroundColor: cur.color }}
                              />
                              <div
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white shadow-sm flex items-center gap-0.5 whitespace-nowrap"
                                style={{ backgroundColor: cur.color }}
                              >
                                <span>◀</span>
                                <span>終了 {cur.endHour}:59</span>
                                <span>▶</span>
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      {/* 重なりOK（斜線ストライプ）の説明キャプション */}
                      <div className="mt-1 flex items-center justify-between text-[11px]" style={{ color: activeTheme.textSecondary }}>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block w-4 h-3 rounded-xs border"
                            style={{
                              borderColor: activeTheme.border,
                              backgroundImage:
                                "repeating-linear-gradient(135deg, #529961, #529961 3px, #4a7bb0 3px, #4a7bb0 6px)",
                            }}
                          />
                          <span>斜線の区間＝複数時間帯の重複（重なりOK）</span>
                        </span>
                        <span className="text-[10px]">ピンを左右にドラッグして伸縮</span>
                      </div>
                    </div>

                    {/* ── 縦並びの時間帯リスト ── */}
                    <div className="space-y-2.5">
                      {(Object.keys(DEFAULT_TIME_SLOTS) as TimeSlotKey[]).map((key) => {
                        const slot = timeSlots[key] || DEFAULT_TIME_SLOTS[key];
                        const isSelected = selectedSlotForEdit === key;
                        const overlaps = getSlotOverlaps(key);

                        return (
                          <div
                            key={key}
                            onClick={() => setSelectedSlotForEdit(key)}
                            className={`p-3 rounded-xl transition-all cursor-pointer border ${
                              isSelected ? "shadow-sm ring-1" : "hover:opacity-90"
                            }`}
                            style={{
                              backgroundColor: activeTheme.bgCard,
                              borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                            }}
                          >
                            {/* 上段：アイコン・名称・現在の範囲・重なりバッジ */}
                            <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs"
                                  style={{ backgroundColor: slot.color }}
                                />
                                <span className="text-base leading-none">{slot.icon}</span>
                                <span className="font-bold text-xs" style={{ color: activeTheme.textPrimary }}>
                                  {slot.label}
                                </span>
                                <span
                                  className="font-mono text-xs font-semibold px-2 py-0.5 rounded-md border"
                                  style={{
                                    backgroundColor: activeTheme.bgSub,
                                    borderColor: activeTheme.border,
                                    color: activeTheme.textPrimary,
                                  }}
                                >
                                  {slot.startHour}:00 〜 {slot.endHour}:59
                                  {slot.endHour < slot.startHour && (
                                    <span className="ml-1 text-[10px] font-normal" style={{ color: activeTheme.textSecondary }}>
                                      (翌日)
                                    </span>
                                  )}
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {overlaps.length > 0 && (
                                  <span
                                    className="text-[10px] px-2 py-0.5 rounded-full border"
                                    style={{
                                      backgroundColor: activeTheme.bgSub,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textSecondary,
                                    }}
                                  >
                                    🔄 「{overlaps.join("・")}」と重なり
                                  </span>
                                )}
                                {isSelected && (
                                  <span
                                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                    style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                                  >
                                    選択中
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* 下段：開始・終了時間の微調整（[-] / [+] ステッパー ＆ セレクト） */}
                            <div
                              className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-2 border-t"
                              style={{ borderColor: activeTheme.border }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* 開始時間 */}
                              <div
                                className="flex items-center justify-between sm:justify-start gap-2 px-2.5 py-1.5 rounded-lg border"
                                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                              >
                                <span className="text-[11px] font-medium shrink-0" style={{ color: activeTheme.textSecondary }}>開始:</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "startHour", -1)}
                                    className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs transition-colors hover:opacity-80 border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                    title="1時間戻す"
                                  >
                                    －
                                  </button>
                                  <select
                                    value={slot.startHour}
                                    onChange={(e) =>
                                      handleUpdateTimeSlot(key, "startHour", Number(e.target.value))
                                    }
                                    className="rounded px-1.5 py-0.5 font-mono text-xs font-semibold focus:outline-none border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                  >
                                    {Array.from({ length: 24 }, (_, i) => (
                                      <option key={i} value={i} style={{ backgroundColor: activeTheme.bgCard, color: activeTheme.textPrimary }}>
                                        {i.toString().padStart(2, "0")}:00
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "startHour", 1)}
                                    className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs transition-colors hover:opacity-80 border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                    title="1時間進める"
                                  >
                                    ＋
                                  </button>
                                </div>
                              </div>

                              {/* 終了時間 */}
                              <div
                                className="flex items-center justify-between sm:justify-start gap-2 px-2.5 py-1.5 rounded-lg border"
                                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                              >
                                <span className="text-[11px] font-medium shrink-0" style={{ color: activeTheme.textSecondary }}>終了:</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "endHour", -1)}
                                    className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs transition-colors hover:opacity-80 border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                    title="1時間戻す"
                                  >
                                    －
                                  </button>
                                  <select
                                    value={slot.endHour}
                                    onChange={(e) =>
                                      handleUpdateTimeSlot(key, "endHour", Number(e.target.value))
                                    }
                                    className="rounded px-1.5 py-0.5 font-mono text-xs font-semibold focus:outline-none border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                  >
                                    {Array.from({ length: 24 }, (_, i) => (
                                      <option key={i} value={i} style={{ backgroundColor: activeTheme.bgCard, color: activeTheme.textPrimary }}>
                                        {i.toString().padStart(2, "0")}:59
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "endHour", 1)}
                                    className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs transition-colors hover:opacity-80 border"
                                    style={{
                                      backgroundColor: activeTheme.bgCard,
                                      borderColor: activeTheme.border,
                                      color: activeTheme.textPrimary,
                                    }}
                                    title="1時間進める"
                                  >
                                    ＋
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* 容量・メモ情報 */}
              <div
                className="p-3.5 rounded-xl border transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <span className="font-medium block mb-2" style={{ color: activeTheme.textPrimary }}>
                  容量・メモ情報
                </span>
                <div className="text-xs flex flex-col gap-1" style={{ color: activeTheme.textSecondary }}>
                  <div>通常メモ：{activeNotes.length} 件</div>
                  <div>ゴミ箱内：{trashNotes.length} 件</div>
                  <div>総データ数：{notes.length} 件</div>
                </div>
              </div>

              {/* ── 項目X：🔐 鍵付きメモ設定 ── */}
              <div
                className="p-4 rounded-xl border flex flex-col gap-3 transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-sm flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                      <span>🔐</span> 鍵付きメモ設定
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: activeTheme.textSecondary }}>
                      鍵をかけたメモを「・」で隠すためのパスワードと表示ルール
                    </div>
                  </div>
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0"
                    style={{
                      backgroundColor: lockPasswordHash ? activeTheme.accent : activeTheme.bgCard,
                      borderColor: lockPasswordHash ? activeTheme.accent : activeTheme.border,
                      color: lockPasswordHash ? activeTheme.accentText : activeTheme.textSecondary,
                    }}
                  >
                    {lockPasswordHash ? "設定済み" : "未設定"}
                  </span>
                </div>

                {/* 鍵パスワードの設定・変更・再設定 */}
                <div
                  className="p-3 rounded-xl border flex flex-col gap-2"
                  style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                      鍵メモ専用パスワード
                    </span>
                    <button
                      type="button"
                      onClick={() => openLockModal(lockPasswordHash ? "change" : "setup")}
                      className="px-3 py-1 rounded-lg text-xs font-bold transition-all shadow-2xs hover:opacity-90"
                      style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                    >
                      {lockPasswordHash ? "パスワードを変更" : "パスワードを設定"}
                    </button>
                  </div>
                  <div className="text-[11px] leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                    アカウントのログインパスワードとは別に管理されます（4〜{MAX_PASSWORD_LENGTH}文字）。
                  </div>
                  {lockPasswordHash && currentUser && (
                    <div className="flex justify-end pt-1 border-t" style={{ borderColor: activeTheme.border }}>
                      <button
                        type="button"
                        onClick={() => openLockModal("forgot")}
                        className="text-[11px] underline hover:opacity-80"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        鍵パスワードを忘れた場合（アカウントパスワードで再設定）
                      </button>
                    </div>
                  )}
                </div>

                {/* ロック中のタイトル表示 */}
                <div
                  className="p-3 rounded-xl border flex items-center justify-between gap-2 flex-wrap"
                  style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                      ロック中のタイトル表示
                    </div>
                    <div className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                      鍵がかかっている間のタイトルの扱い
                    </div>
                  </div>
                  <div className="flex items-center gap-1 p-0.5 rounded-lg border" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                    {[
                      { label: "隠す（・・・）", value: true },
                      { label: "表示する", value: false },
                    ].map((opt) => {
                      const active = maskLockedTitle === opt.value;
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => handleChangeMaskLockedTitle(opt.value)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                            active ? "font-bold shadow-2xs" : "hover:opacity-80"
                          }`}
                          style={{
                            backgroundColor: active ? activeTheme.accent : "transparent",
                            color: active ? activeTheme.accentText : activeTheme.textSecondary,
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 自動ロックのタイミング */}
                <div
                  className="p-3 rounded-xl border flex flex-col gap-2"
                  style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                >
                  <div>
                    <div className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                      自動で隠すタイミング
                    </div>
                    <div className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                      解除したメモを自動でロック状態に戻す条件を選べます
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        { id: "manual", label: "手動・再読込時のみ" },
                        { id: "5m", label: "無操作 5分" },
                        { id: "15m", label: "無操作 15分" },
                        { id: "background", label: "別画面に切替時" },
                      ] as const
                    ).map((opt) => {
                      const active = autoLockMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => handleChangeAutoLockMode(opt.id)}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-all text-center ${
                            active ? "font-bold shadow-2xs" : "hover:opacity-80"
                          }`}
                          style={{
                            backgroundColor: active ? activeTheme.accent : activeTheme.bgSub,
                            borderColor: active ? activeTheme.accent : activeTheme.border,
                            color: active ? activeTheme.accentText : activeTheme.textSecondary,
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* アカウント・クラウド同期・復旧キー */}
              <div
                className="p-3.5 rounded-xl border flex flex-col gap-2.5 transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                    <span>👤</span> クラウド同期・アカウント
                  </span>
                  {currentUser ? (
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="px-2.5 py-1 text-xs text-[#b85448] hover:text-[#9e3a2f] border rounded-lg transition-colors font-medium"
                      style={{ borderColor: activeTheme.border }}
                    >
                      ログアウト
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthMode("login");
                        setAuthError(null);
                        setAuthSuccessMsg(null);
                        setIsAuthModalOpen(true);
                      }}
                      className="px-3 py-1 text-xs font-bold rounded-lg transition-all shadow-2xs hover:opacity-90"
                      style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                    >
                      ログイン / 新規登録
                    </button>
                  )}
                </div>

                {currentUser ? (
                  <div className="flex flex-col gap-2.5 pt-1 border-t" style={{ borderColor: activeTheme.border }}>
                    <div className="text-xs flex items-center justify-between" style={{ color: activeTheme.textSecondary }}>
                      <span>ログイン中のユーザー名:</span>
                      <strong className="font-mono text-sm" style={{ color: activeTheme.textPrimary }}>{currentUsername}</strong>
                    </div>

                    {/* 復旧キー枠 */}
                    <div
                      className="p-3 rounded-xl border flex flex-col gap-2"
                      style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold" style={{ color: activeTheme.textSecondary }}>
                          🔑 パスワード復旧キー
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowRecoveryKeyInSettings(!showRecoveryKeyInSettings)}
                          className="text-[11px] underline font-medium hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                        >
                          {showRecoveryKeyInSettings ? "キーを隠す" : "キーを表示する"}
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <code
                          className="flex-1 px-3 py-1.5 rounded-lg border text-xs font-mono font-bold tracking-wider select-all"
                          style={{
                            backgroundColor: activeTheme.bgSub,
                            borderColor: activeTheme.border,
                            color: activeTheme.textPrimary,
                          }}
                        >
                          {showRecoveryKeyInSettings ? (recoveryKey || "未設定") : "••••-••••-••••"}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            if (recoveryKey) {
                              navigator.clipboard.writeText(recoveryKey);
                              setCopiedKeyToast(true);
                              setTimeout(() => setCopiedKeyToast(false), 2000);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 flex items-center gap-1 shadow-2xs cursor-pointer hover:opacity-90"
                          style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                        >
                          <CopyIcon className="w-3.5 h-3.5" /> {copiedKeyToast ? "コピー完了!" : "コピー"}
                        </button>
                      </div>

                      <div
                        className="text-[10px] leading-relaxed pt-1 border-t flex flex-col gap-0.5"
                        style={{ borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                      >
                        <span>⚠️ <strong>誰にも教えてはいけません</strong>（パスワード再設定用の重要キーです）</span>
                        <span>⚠️ <strong>ライトNote内にはメモせず</strong>、スクショや別メモ等に保存してください</span>
                      </div>
                    </div>

                    {/* アカウント削除ボタン（ログイン中のみ表示） */}
                    <div className="pt-2 border-t flex justify-end" style={{ borderColor: activeTheme.border }}>
                      <button
                        type="button"
                        onClick={handleOpenDeleteAccountModal}
                        className="text-[11px] font-medium text-[#b85448] hover:text-[#9e3a2f] underline transition-colors cursor-pointer"
                      >
                        アカウントを削除する
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                    アカウントを作成すると、スマホやPC間でメモが自動同期されます。メールアドレス不要で登録できます。
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* フッター */}
      <footer className="text-center py-2 text-xs text-transparent select-none">
        ライトNote
      </footer>

      {/* ガイド・ヘルプモーダル（右上の？を押した時に表示：アコーディオン形式） */}
      {isHelpOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setIsHelpOpen(false)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-lg w-full max-h-[85vh] flex flex-col border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘルプモーダルのヘッダー */}
            <div className="shrink-0 flex items-center justify-between pb-3 mb-3 border-b" style={{ borderColor: activeTheme.border }}>
              <div>
                <h2 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                  <img src="/icon.svg" alt="ライトNote" className="w-5 h-5 rounded-md shadow-2xs shrink-0" />
                  <span>ライトNote ガイド・ヘルプ</span>
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  気になる項目をタップして詳細をご覧ください
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="w-7 h-7 rounded-full text-xs font-bold transition-opacity hover:opacity-75 flex items-center justify-center shrink-0 border"
                style={{
                  backgroundColor: activeTheme.bgSub,
                  borderColor: activeTheme.border,
                  color: activeTheme.textSecondary,
                }}
              >
                ✕
              </button>
            </div>

            {/* チュートリアル＆アコーディオンリスト（全11項目：高さが縮んでも潰れずスクロールする） */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1.5 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleStartTutorial}
                className="w-full text-left px-4 py-3 rounded-xl border transition-opacity hover:opacity-85 flex items-center justify-between gap-3 shrink-0"
                style={{
                  backgroundColor: activeTheme.bgSub,
                  borderColor: activeTheme.accent,
                  color: activeTheme.textPrimary,
                }}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-base shrink-0">📖</span>
                  <div className="min-w-0">
                    <div className="text-xs font-bold">チュートリアルを見る</div>
                    <div className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                      基本の使い方を実際に触って体験（約1分）
                    </div>
                  </div>
                </div>
                <span
                  className="text-xs font-bold px-2.5 py-1 rounded-lg shrink-0"
                  style={{
                    backgroundColor: activeTheme.accent,
                    color: activeTheme.accentText,
                  }}
                >
                  開始 →
                </span>
              </button>
              {HELP_ITEMS.map((item) => {
                const isOpen = openHelpSection === item.id;
                return (
                  <div
                    key={item.id}
                    className="shrink-0 border rounded-xl overflow-hidden transition-colors"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setOpenHelpSection(isOpen ? null : item.id)
                      }
                      className="w-full flex items-center justify-between p-3.5 text-left text-sm font-bold transition-opacity hover:opacity-85 min-h-[48px]"
                      style={{ color: activeTheme.textPrimary }}
                    >
                      <span>{item.title}</span>
                      <span
                        className={`text-xs transition-transform duration-200 ${
                          isOpen ? "rotate-90" : ""
                        }`}
                        style={{ color: activeTheme.textSecondary }}
                      >
                        ▶
                      </span>
                    </button>

                    {isOpen && (
                      <div
                        className="px-4 pb-4 pt-1 text-xs sm:text-sm leading-relaxed border-t transition-colors"
                        style={{
                          backgroundColor: activeTheme.bgCard,
                          borderColor: activeTheme.border,
                          color: activeTheme.textPrimary,
                        }}
                      >
                        {item.content}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* お問い合わせ案内（枠なしのプレーンテキスト＋コピーボタン） */}
              <div
                className="shrink-0 mt-2 pt-3 border-t flex flex-col gap-1.5"
                style={{ borderColor: activeTheme.border, color: activeTheme.textPrimary }}
              >
                <p className="text-xs leading-relaxed">
                  ガイドヘルプでも解決できないご質問、またはご意見のある方は、こちらのメールアドレスにご連絡ください。
                </p>
                <div className="flex items-center justify-between gap-2 pl-2 flex-wrap">
                  <span className="text-xs sm:text-sm font-medium select-all break-all">
                    app746.tahry@gmail.com
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyContactEmail}
                    className="px-2.5 py-1 rounded-lg border text-xs font-medium transition-opacity hover:opacity-80 flex items-center gap-1 shrink-0 cursor-pointer"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                    aria-label="お問い合わせメールアドレスをコピー"
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                    <span>{copiedContactEmail ? "コピー完了!" : "コピー"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 鍵付きメモ パスワード設定・解除モーダル */}
      {lockModalMode && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={closeLockModal}
        >
          <form
            onSubmit={handleSubmitLockModal}
            className="rounded-2xl p-6 max-w-sm w-full border shadow-2xl transition-all flex flex-col gap-3.5"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                <span>{lockModalMode === "unlock" ? "🔓" : "🔐"}</span>
                <span>
                  {lockModalMode === "unlock" && "鍵メモのロック解除"}
                  {lockModalMode === "setup" && "鍵メモ用パスワードを設定"}
                  {lockModalMode === "change" && "鍵メモ用パスワードを変更"}
                  {lockModalMode === "forgot" && "鍵パスワードを再設定"}
                </span>
              </h3>
              <p className="text-xs mt-1 leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                {lockModalMode === "unlock" &&
                  "一度解除すると、他の鍵メモもタップだけで開けるようになります（「隠す」でロック）。"}
                {lockModalMode === "setup" &&
                  "すべての鍵付きメモに共通で使うパスワードを決めてください（4文字以上・アカウントパスワードと別でOK）。"}
                {lockModalMode === "change" &&
                  "現在の鍵パスワードを確認したうえで、新しいパスワードに変更します。"}
                {lockModalMode === "forgot" &&
                  "ログイン中アカウントのパスワードで本人確認を行い、新しい鍵パスワードを再設定します。"}
              </p>
            </div>

            {lockModalError && (
              <div
                className="p-2.5 rounded-xl border text-xs font-medium"
                style={{
                  backgroundColor: "rgba(184, 84, 72, 0.12)",
                  borderColor: "rgba(184, 84, 72, 0.35)",
                  color: activeTheme.isDark ? "#f5a398" : "#b85448",
                }}
              >
                ⚠️ {lockModalError}
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              <div>
                <label className="block text-xs font-bold mb-1" style={{ color: activeTheme.textPrimary }}>
                  {lockModalMode === "unlock" && "鍵メモ用パスワード"}
                  {lockModalMode === "setup" && `新しい鍵パスワード（4〜${MAX_PASSWORD_LENGTH}文字）`}
                  {lockModalMode === "change" && "現在の鍵パスワード"}
                  {lockModalMode === "forgot" && "アカウントのログインパスワード"}
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showLockInput1 ? "text" : "password"}
                    maxLength={MAX_PASSWORD_LENGTH}
                    value={lockInput1}
                    onChange={(e) => setLockInput1(e.target.value)}
                    autoFocus
                    className="w-full px-3 py-2 pr-9 text-sm rounded-xl border focus:outline-none"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowLockInput1((prev) => !prev)}
                    className="absolute right-2.5 p-1 hover:opacity-75"
                    style={{ color: activeTheme.textSecondary }}
                    aria-label={showLockInput1 ? "パスワードを隠す" : "パスワードを表示"}
                  >
                    {showLockInput1 ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              {(lockModalMode === "setup" || lockModalMode === "change" || lockModalMode === "forgot") && (
                <div>
                  <label className="block text-xs font-bold mb-1" style={{ color: activeTheme.textPrimary }}>
                    {lockModalMode === "setup" ? "確認用（もう一度入力）" : `新しい鍵パスワード（4〜${MAX_PASSWORD_LENGTH}文字）`}
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showLockInput2 ? "text" : "password"}
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={lockInput2}
                      onChange={(e) => setLockInput2(e.target.value)}
                      className="w-full px-3 py-2 pr-9 text-sm rounded-xl border focus:outline-none"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowLockInput2((prev) => !prev)}
                      className="absolute right-2.5 p-1 hover:opacity-75"
                      style={{ color: activeTheme.textSecondary }}
                      aria-label={showLockInput2 ? "パスワードを隠す" : "パスワードを表示"}
                    >
                      {showLockInput2 ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </div>
              )}

              {(lockModalMode === "change" || lockModalMode === "forgot") && (
                <div>
                  <label className="block text-xs font-bold mb-1" style={{ color: activeTheme.textPrimary }}>
                    新しい鍵パスワード（確認用）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showLockInput3 ? "text" : "password"}
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={lockInput3}
                      onChange={(e) => setLockInput3(e.target.value)}
                      className="w-full px-3 py-2 pr-9 text-sm rounded-xl border focus:outline-none"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowLockInput3((prev) => !prev)}
                      className="absolute right-2.5 p-1 hover:opacity-75"
                      style={{ color: activeTheme.textSecondary }}
                      aria-label={showLockInput3 ? "パスワードを隠す" : "パスワードを表示"}
                    >
                      {showLockInput3 ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {lockModalMode === "unlock" && currentUser && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => openLockModal("forgot")}
                  className="text-[11px] underline hover:opacity-80"
                  style={{ color: activeTheme.textSecondary }}
                >
                  パスワードを忘れた場合
                </button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t" style={{ borderColor: activeTheme.border }}>
              <button
                type="button"
                onClick={closeLockModal}
                className="px-3.5 py-2 rounded-xl text-xs font-medium hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={isLockModalBusy}
                className="px-4 py-2 rounded-xl text-xs font-bold shadow-xs hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
              >
                {isLockModalBusy
                  ? "確認中..."
                  : lockModalMode === "unlock"
                  ? "解除する"
                  : "保存する"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* リマインダー（見返す日）設定モーダル */}
      {reminderTargetNote && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setReminderTargetNote(null)}
        >
          <div
            className="rounded-2xl p-6 max-w-sm w-full border shadow-2xl transition-all flex flex-col gap-4"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                <span>🔔</span> 見返す日を設定
              </h3>
              <p
                className={`text-xs mt-1 line-clamp-2 break-words [overflow-wrap:anywhere] ${
                  !isNoteContentVisible(reminderTargetNote) ? "break-all" : ""
                }`}
                style={{ color: activeTheme.textSecondary }}
              >
                {isNoteContentVisible(reminderTargetNote)
                  ? reminderTargetNote.title || reminderTargetNote.content
                  : reminderTargetNote.title && !maskLockedTitle
                  ? reminderTargetNote.title
                  : maskLockedText(reminderTargetNote.title || reminderTargetNote.content)}
              </p>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-1.5">
                {[{ label: "今日", days: 0 }, ...REMINDER_PRESET_OFFSETS].map((preset) => {
                  const targetYmd = getLocalYmd(preset.days);
                  const isSelected = reminderDateInput === targetYmd;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setReminderDateInput(targetYmd)}
                      className="px-3 py-1.5 rounded-xl text-xs font-medium border transition-all"
                      style={{
                        backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgSub,
                        borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                        color: isSelected ? activeTheme.accentText : activeTheme.textPrimary,
                      }}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>

              <input
                type="date"
                value={reminderDateInput}
                onChange={(e) => setReminderDateInput(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border text-sm bg-transparent focus:outline-none"
                style={{
                  backgroundColor: activeTheme.bgSub,
                  borderColor: activeTheme.border,
                  color: activeTheme.textPrimary,
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t" style={{ borderColor: activeTheme.border }}>
              {reminderTargetNote.remindAt ? (
                <button
                  type="button"
                  onClick={() => {
                    handleSetNoteReminder(reminderTargetNote.id, undefined);
                    setReminderTargetNote(null);
                  }}
                  className="px-3 py-2 rounded-xl text-xs font-medium text-[#b85448] hover:opacity-80"
                >
                  解除する
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setReminderTargetNote(null)}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium hover:opacity-80"
                  style={{ color: activeTheme.textSecondary }}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  disabled={!reminderDateInput}
                  onClick={() => {
                    if (!reminderDateInput) return;
                    handleSetNoteReminder(reminderTargetNote.id, reminderDateInput);
                    setReminderTargetNote(null);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-bold shadow-xs hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                >
                  保存する
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 運営からのお知らせモーダル */}
      {isAnnouncementsOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setIsAnnouncementsOpen(false)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-lg w-full max-h-[85vh] flex flex-col border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="shrink-0 flex items-center justify-between pb-3 mb-3 border-b"
              style={{ borderColor: activeTheme.border }}
            >
              <div>
                <h2
                  className="text-base font-bold flex items-center gap-1.5"
                  style={{ color: activeTheme.textPrimary }}
                >
                  <span>📢</span>
                  <span>運営からのお知らせ</span>
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  アップデート情報や大切なお知らせをお届けします
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    fetchAnnouncements();
                  }}
                  disabled={isLoadingAnnouncements}
                  className="px-2.5 py-1 rounded-full text-[11px] font-medium border transition-opacity hover:opacity-75 disabled:opacity-50"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  {isLoadingAnnouncements ? "読込中..." : "更新"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsAnnouncementsOpen(false)}
                  className="w-7 h-7 rounded-full text-xs font-bold transition-opacity hover:opacity-75 flex items-center justify-center shrink-0 border"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-3">
              {isLoadingAnnouncements && announcements.length === 0 ? (
                <div className="py-10 text-center text-xs" style={{ color: activeTheme.textSecondary }}>
                  お知らせを読み込んでいます...
                </div>
              ) : announcementsFetchError && announcements.length === 0 ? (
                <div
                  className="p-4 rounded-xl border text-center flex flex-col items-center gap-2.5"
                  style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                >
                  <p className="text-xs leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                    お知らせを読み込めませんでした。通信環境をご確認のうえ、再度お試しください。
                  </p>
                  <button
                    type="button"
                    onClick={fetchAnnouncements}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-medium border transition-opacity hover:opacity-80"
                    style={{
                      backgroundColor: activeTheme.bgCard,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  >
                    再読み込み
                  </button>
                </div>
              ) : announcements.length === 0 ? (
                <div
                  className="py-10 px-4 rounded-xl border text-center text-xs leading-relaxed"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  現在、新しいお知らせはありません。
                </div>
              ) : (
                announcements.map((item) => {
                  const categoryMeta = getAnnouncementCategoryLabel(item.category);
                  const isNewlyOpened = newlyOpenedAnnouncementIds.includes(item.id);
                  const dateLabel = (() => {
                    const parsed = new Date(item.published_at);
                    if (Number.isNaN(parsed.getTime())) return item.published_at;
                    return parsed.toLocaleDateString("ja-JP", {
                      year: "numeric",
                      month: "numeric",
                      day: "numeric",
                    });
                  })();

                  return (
                    <article
                      key={item.id}
                      className="p-4 rounded-xl border flex flex-col gap-1.5"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: categoryMeta.isImportant ? "#c96256" : activeTheme.border,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-md border"
                            style={
                              categoryMeta.isImportant
                                ? {
                                    backgroundColor: "rgba(201, 98, 86, 0.14)",
                                    borderColor: "rgba(201, 98, 86, 0.45)",
                                    color: "#c96256",
                                  }
                                : {
                                    backgroundColor: activeTheme.bgCard,
                                    borderColor: activeTheme.border,
                                    color: activeTheme.textSecondary,
                                  }
                            }
                          >
                            {categoryMeta.label}
                          </span>
                          {isNewlyOpened && (
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                              style={{ backgroundColor: "#c96256", color: "#ffffff" }}
                            >
                              NEW
                            </span>
                          )}
                        </div>
                        <time className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                          {dateLabel}
                        </time>
                      </div>
                      <h3 className="text-sm font-bold leading-snug" style={{ color: activeTheme.textPrimary }}>
                        {item.title}
                      </h3>
                      <p
                        className="text-xs leading-relaxed whitespace-pre-wrap break-words"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        {item.content}
                      </p>
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* カテゴリ名変更モーダル */}
      {categoryToRename && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => {
            setCategoryToRename(null);
            setRenameCategoryError(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleConfirmRenameCategory();
            }}
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full border shadow-2xl transition-all flex flex-col gap-3"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                <span>✏️</span> カテゴリ名を変更
              </h3>
              <p className="text-xs mt-1" style={{ color: activeTheme.textSecondary }}>
                「{categoryToRename.name}」がついている過去のメモも自動的に新しい名前で表示されます。
              </p>
            </div>
            <div>
              <input
                type="text"
                maxLength={MAX_CATEGORY_NAME_LENGTH}
                value={renameCategoryInput}
                onChange={(e) => {
                  setRenameCategoryInput(e.target.value);
                  if (renameCategoryError) setRenameCategoryError(null);
                }}
                autoFocus
                placeholder="新しいカテゴリ名"
                className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none"
                style={{
                  backgroundColor: activeTheme.bgSub,
                  borderColor: activeTheme.border,
                  color: activeTheme.textPrimary,
                }}
              />
              {renameCategoryError && (
                <p className="text-xs mt-1.5 text-[#b85448] font-medium">{renameCategoryError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setCategoryToRename(null);
                  setRenameCategoryError(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                キャンセル
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-xs hover:opacity-90"
                style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
              >
                変更する
              </button>
            </div>
          </form>
        </div>
      )}

      {/* カテゴリ消去の確認モーダル */}
      {categoryToDelete && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setCategoryToDelete(null)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="text-base font-bold mb-1"
              style={{ color: activeTheme.textPrimary }}
            >
              「{categoryToDelete.name}」
            </h3>
            <p
              className="text-sm font-bold mb-3"
              style={{ color: activeTheme.textPrimary }}
            >
              本当にこのカテゴリを消去しますか？
            </p>
            <p
              className="text-xs leading-relaxed mb-6 p-3 rounded-xl border"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.border,
                color: activeTheme.textSecondary,
              }}
            >
              （※このカテゴリに分類されているメモは未分類、または他のカテゴリがついている場合は消去するカテゴリのみなくなります）
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setCategoryToDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteCategory}
                className="px-4 py-2 rounded-xl text-xs font-medium bg-[#b85448] text-white hover:bg-[#a34438] transition-colors shadow-xs"
              >
                消去
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ⑤ メモのタイトル・カテゴリ変更モーダル */}
      {editingNote && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={handleRequestCloseEditModal}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-md w-full border shadow-2xl transition-all max-h-[90vh] flex flex-col"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* モーダルのヘッダー */}
            <div className="shrink-0 pb-3 mb-4 border-b" style={{ borderColor: activeTheme.border }}>
              <h2
                className="text-base font-bold flex items-center gap-1.5"
                style={{ color: activeTheme.textPrimary }}
              >
                <span>🏷️</span> タイトル・カテゴリの変更
              </h2>
              <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                見出しやジャンルを整理できます（※本文は保護されます）
              </span>
            </div>

            {/* スクロール可能な編集エリア */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-4">
              {/* タイトル入力 */}
              <div>
                <label
                  className="block text-xs font-bold mb-1.5"
                  style={{ color: activeTheme.textPrimary }}
                >
                  タイトル
                </label>
                <input
                  type="text"
                  placeholder="タイトルを入力（空欄なら無題）"
                  maxLength={MAX_NOTE_TITLE_LENGTH}
                  value={editTitleInput}
                  onChange={(e) => setEditTitleInput(e.target.value)}
                  className={`w-full ${
                    fontSize === "large" ? "px-4 py-2.5 text-base" : "px-3.5 py-2 text-sm"
                  } rounded-xl border focus:outline-none transition-colors`}
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                  }}
                />
                <LengthLimitHint
                  length={editTitleInput.length}
                  maxLength={MAX_NOTE_TITLE_LENGTH}
                  warnThreshold={NOTE_TITLE_WARN_THRESHOLD}
                  kind="title"
                  theme={activeTheme}
                />
              </div>

              {/* カテゴリ選択エリア */}
              <div>
                <label
                  className="block text-xs font-bold mb-1.5"
                  style={{ color: activeTheme.textPrimary }}
                >
                  カテゴリ
                </label>
                <div
                  className="flex flex-wrap items-center gap-1.5 p-2.5 rounded-xl border"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                  }}
                >
                  {sortedCategories.map((cat) => {
                    const isSelected = editCategories.includes(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => handleToggleEditCategory(cat.id)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                          isSelected ? "shadow-xs font-bold" : "hover:opacity-85"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgCard,
                          borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {cat.name}
                      </button>
                    );
                  })}

                  {/* モーダル内インライン新規作成 */}
                  {isAddingCategoryInEdit ? (
                    <div
                      className="flex items-center gap-1 p-0.5 rounded-lg border"
                      style={{
                        backgroundColor: activeTheme.bgCard,
                        borderColor: activeTheme.border,
                      }}
                    >
                      <input
                        type="text"
                        placeholder="新しいカテゴリ"
                        maxLength={MAX_CATEGORY_NAME_LENGTH}
                        value={inlineNewCategoryInEdit}
                        onChange={(e) => setInlineNewCategoryInEdit(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSaveCategoryInEdit();
                          }
                        }}
                        autoFocus
                        className="px-2 py-0.5 text-xs bg-transparent focus:outline-none w-24"
                        style={{ color: activeTheme.textPrimary }}
                      />
                      <button
                        type="button"
                        onClick={handleSaveCategoryInEdit}
                        className="px-2 py-0.5 rounded-md text-[11px] font-medium hover:opacity-85"
                        style={{
                          backgroundColor: activeTheme.accent,
                          color: activeTheme.accentText,
                        }}
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddingCategoryInEdit(false);
                          setInlineNewCategoryInEdit("");
                        }}
                        className="px-1 text-[11px] hover:opacity-80"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAddingCategoryInEdit(true)}
                      className="px-2.5 py-1 rounded-lg border border-dashed text-xs font-medium transition-colors hover:opacity-85"
                      style={{
                        borderColor: activeTheme.border,
                        color: activeTheme.textSecondary,
                      }}
                    >
                      ＋ 新規
                    </button>
                  )}

                  {editCategories.length === 0 && !isAddingCategoryInEdit && (
                    <span
                      className="text-[11px] select-none ml-1"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      （未選択＝未分類）
                    </span>
                  )}
                </div>
              </div>

              {/* 本文の確認プレビュー（編集不可・思考の不可逆性を保護） */}
              <div>
                <label
                  className="block text-xs font-bold mb-1.5 flex items-center justify-between"
                  style={{ color: activeTheme.textSecondary }}
                >
                  <span>本文（プレビュー）</span>
                  <span className="text-[10px] font-normal">※本文の編集はできません</span>
                </label>
                <div
                  className="p-3.5 rounded-xl border text-xs sm:text-sm whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto select-text"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                    fontFamily: getNoteFontFamilyStyle(noteFont),
                  }}
                >
                  {editingNote.content}
                </div>
              </div>
            </div>

            {/* モーダルのフッターボタン */}
            <div className="shrink-0 flex justify-end gap-2.5 pt-4 mt-3 border-t" style={{ borderColor: activeTheme.border }}>
              <button
                type="button"
                onClick={handleRequestCloseEditModal}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSaveNoteEdit}
                className="px-5 py-2 rounded-xl text-xs font-medium transition-all shadow-xs hover:opacity-85"
                style={{
                  backgroundColor: activeTheme.accent,
                  color: activeTheme.accentText,
                }}
              >
                保存する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑤-2 メモの本文訂正モーダル（思考の不可逆性を保つため過去の文章を記録） */}
      {editingContentNote && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4"
          onClick={() => setEditingContentNote(null)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-md w-full border shadow-2xl transition-all max-h-[90vh] flex flex-col"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* モーダルのヘッダー */}
            <div className="shrink-0 pb-3 mb-4 border-b" style={{ borderColor: activeTheme.border }}>
              <h2
                className="text-base font-bold flex items-center gap-1.5"
                style={{ color: activeTheme.textPrimary }}
              >
                <span>✏️</span> 本文の訂正
              </h2>
              <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                誤字や表現を訂正できます。過去の文章は履歴として安全に保存されます。
              </span>
            </div>

            {/* スクロール可能な編集エリア */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-4">
              {/* 訂正前の文章（参照用） */}
              <div>
                <label
                  className="block text-xs font-bold mb-1"
                  style={{ color: activeTheme.textSecondary }}
                >
                  訂正前の文章（第{(editingContentNote.editHistory?.length || 0) + 1}版として保存されます）
                </label>
                <div
                  className="p-3 rounded-xl border text-xs whitespace-pre-wrap leading-relaxed max-h-28 overflow-y-auto select-text"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                    fontFamily: getNoteFontFamilyStyle(noteFont),
                  }}
                >
                  {editingContentNote.content}
                </div>
              </div>

              {/* 新しい本文入力欄 */}
              <div>
                <label
                  className="block text-xs font-bold mb-1.5"
                  style={{ color: activeTheme.textPrimary }}
                >
                  訂正後の新しい本文
                </label>
                <textarea
                  rows={6}
                  maxLength={MAX_NOTE_CONTENT_LENGTH}
                  value={editContentInput}
                  onChange={(e) => setEditContentInput(e.target.value)}
                  placeholder="新しい本文を入力してください..."
                  autoFocus
                  className={`w-full ${
                    fontSize === "large" ? "p-3.5 text-base" : "p-3 text-sm"
                  } rounded-xl border focus:outline-none leading-relaxed resize-none transition-colors`}
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                    fontFamily: getNoteFontFamilyStyle(noteFont),
                  }}
                />
                <LengthLimitHint
                  length={editContentInput.length}
                  maxLength={MAX_NOTE_CONTENT_LENGTH}
                  warnThreshold={NOTE_LENGTH_WARN_THRESHOLD}
                  kind="body"
                  theme={activeTheme}
                />
              </div>
            </div>

            {/* モーダルのフッターボタン */}
            <div className="shrink-0 flex justify-end gap-2.5 pt-4 mt-3 border-t" style={{ borderColor: activeTheme.border }}>
              <button
                type="button"
                onClick={() => setEditingContentNote(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSaveContentEdit}
                disabled={!editContentInput.trim()}
                className="px-5 py-2 rounded-xl text-xs font-medium transition-all shadow-xs"
                style={{
                  backgroundColor: editContentInput.trim() ? activeTheme.accent : activeTheme.bgSub,
                  color: editContentInput.trim() ? activeTheme.accentText : activeTheme.textSecondary,
                  cursor: editContentInput.trim() ? "pointer" : "not-allowed",
                  borderColor: activeTheme.border,
                  borderWidth: editContentInput.trim() ? "0px" : "1px",
                }}
              >
                訂正を保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑥ 編集内容破棄の確認モーダル（フールプルーフ） */}
      {showDiscardConfirmModal && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-60 flex items-center justify-center p-4"
          onClick={() => setShowDiscardConfirmModal(false)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="text-base font-bold mb-2"
              style={{ color: activeTheme.textPrimary }}
            >
              変更内容を破棄しますか？
            </h3>
            <p
              className="text-xs leading-relaxed mb-6 p-3 rounded-xl border"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.border,
                color: activeTheme.textSecondary,
              }}
            >
              保存されていないタイトルやカテゴリの変更は失われます。
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowDiscardConfirmModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                style={{ color: activeTheme.textSecondary }}
              >
                編集を続ける
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscardEdit}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-[#b85448] text-white hover:bg-[#a34438] transition-colors shadow-xs"
              >
                破棄する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑦ ユーザー名＋パスワードによるクラウドログイン／新規登録／再設定モーダル */}
      {isAuthModalOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-60 flex items-center justify-center p-4"
          onClick={handleCloseAuthModal}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full max-h-[90vh] overflow-y-auto border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-4 pb-2 border-b" style={{ borderColor: activeTheme.border }}>
              <h2
                className="text-base font-bold flex items-center gap-1.5"
                style={{ color: activeTheme.textPrimary }}
              >
                <span>{authMode === "reset" ? "🔑" : "🔐"}</span>{" "}
                {authMode === "reset" ? "パスワードの再設定" : "クラウド同期"}
              </h2>
              <button
                type="button"
                onClick={handleCloseAuthModal}
                className="text-xs px-2 py-1 transition-opacity hover:opacity-75"
                style={{ color: activeTheme.textSecondary }}
              >
                ✕
              </button>
            </div>

            {/* モード切り替えタブ（ログイン / 新規登録 / 再設定時の戻るリンク） */}
            {authMode !== "reset" ? (
              <div
                className="flex p-1 rounded-xl mb-4 border"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <button
                  type="button"
                  onClick={() => handleSwitchAuthMode("login")}
                  className="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
                  style={{
                    backgroundColor: authMode === "login" ? activeTheme.accent : "transparent",
                    color: authMode === "login" ? activeTheme.accentText : activeTheme.textSecondary,
                  }}
                >
                  ログイン
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchAuthMode("signup")}
                  className="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all"
                  style={{
                    backgroundColor: authMode === "signup" ? activeTheme.accent : "transparent",
                    color: authMode === "signup" ? activeTheme.accentText : activeTheme.textSecondary,
                  }}
                >
                  新規登録
                </button>
              </div>
            ) : (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => handleSwitchAuthMode("login")}
                  className="text-xs flex items-center gap-1 font-medium cursor-pointer transition-opacity hover:opacity-80"
                  style={{ color: activeTheme.textSecondary }}
                >
                  <span>←</span> ログイン画面に戻る
                </button>
              </div>
            )}

            {authMode === "reset" ? (
              <form onSubmit={handleResetPasswordSubmit} className="space-y-3.5">
                <p
                  className="text-xs leading-relaxed"
                  style={{ color: activeTheme.textSecondary }}
                >
                  登録時に保存した【復旧キー】を入力して、新しいパスワードを設定します。
                </p>

                {/* ユーザー名入力 */}
                <AuthUsernameField
                  value={authUsernameInput}
                  onChange={setAuthUsernameInput}
                  placeholder="登録時のユーザー名"
                  theme={activeTheme}
                />

                {/* 復旧キー入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    復旧キー
                  </label>
                  <input
                    type="text"
                    placeholder="例: SEED-7K9A-3M2P"
                    value={resetRecoveryKeyInput}
                    onChange={(e) => setResetRecoveryKeyInput(e.target.value)}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    required
                    className="w-full px-3 py-2 text-sm font-mono rounded-xl border focus:outline-none transition-colors"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  />
                </div>

                {/* 新しいパスワード入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    新しいパスワード（6〜64文字）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="新しいパスワードを入力"
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={authPasswordInput}
                      onChange={(e) => setAuthPasswordInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm rounded-xl border focus:outline-none transition-colors"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 text-sm p-1 transition-opacity hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                      title={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                      aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPassword ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* 新しいパスワード確認用入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    新しいパスワード（確認用）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPasswordConfirm ? "text" : "password"}
                      placeholder="もう一度入力"
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={authPasswordConfirmInput}
                      onChange={(e) => setAuthPasswordConfirmInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm rounded-xl border focus:outline-none transition-colors"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPasswordConfirm(!showPasswordConfirm)}
                      className="absolute right-2.5 text-sm p-1 transition-opacity hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                      title={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                      aria-label={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPasswordConfirm ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* エラーメッセージ */}
                {authError && (
                  <div className="p-2 rounded-lg bg-[#fdeeed] border border-[#f5c6cb] text-xs text-[#b85448]">
                    {authError}
                  </div>
                )}

                {/* 成功メッセージ */}
                {authSuccessMsg && (
                  <div className="p-2 rounded-lg bg-[#eef6f0] border border-[#c3e6cb] text-xs text-[#529961] font-bold">
                    {authSuccessMsg}
                  </div>
                )}

                {/* 送信ボタン */}
                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={isAuthLoading}
                    className="w-full py-2.5 rounded-xl text-sm font-bold active:scale-[0.99] transition-all disabled:opacity-50 shadow-xs cursor-pointer hover:opacity-85"
                    style={{
                      backgroundColor: activeTheme.accent,
                      color: activeTheme.accentText,
                    }}
                  >
                    {isAuthLoading ? "再設定中..." : "パスワードを再設定してログイン"}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleAuthSubmit} className="space-y-3.5">
                {/* ユーザー名入力 */}
                <AuthUsernameField
                  value={authUsernameInput}
                  onChange={setAuthUsernameInput}
                  placeholder="例: nickname"
                  theme={activeTheme}
                />

                {/* パスワード入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    パスワード（6〜64文字）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="パスワードを入力"
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={authPasswordInput}
                      onChange={(e) => setAuthPasswordInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm rounded-xl border focus:outline-none transition-colors"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 text-sm p-1 transition-opacity hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                      title={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                      aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPassword ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* 新規登録時のみ：パスワード確認用入力 */}
                {authMode === "signup" && (
                  <div>
                    <label
                      className="block text-xs font-bold mb-1"
                      style={{ color: activeTheme.textPrimary }}
                    >
                      パスワード（確認用）
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type={showPasswordConfirm ? "text" : "password"}
                        placeholder="もう一度パスワードを入力"
                        maxLength={MAX_PASSWORD_LENGTH}
                        value={authPasswordConfirmInput}
                        onChange={(e) => setAuthPasswordConfirmInput(e.target.value)}
                        required
                        className="w-full px-3 py-2 pr-10 text-sm rounded-xl border focus:outline-none transition-colors"
                        style={{
                          backgroundColor: activeTheme.bgSub,
                          borderColor: activeTheme.border,
                          color: activeTheme.textPrimary,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPasswordConfirm(!showPasswordConfirm)}
                        className="absolute right-2.5 text-sm p-1 transition-opacity hover:opacity-80"
                        style={{ color: activeTheme.textSecondary }}
                        title={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                        aria-label={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                      >
                        {showPasswordConfirm ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}

                {/* 新規登録時のみ：利用規約・プライバシーへの同意 */}
                {authMode === "signup" && (
                  <div
                    className="p-3 rounded-xl border space-y-2 text-[11px] leading-relaxed"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textSecondary,
                    }}
                  >
                    <p>
                      アカウントを作成した際には、本ウェブアプリの利用規約とプライバシーに同意したものとします。
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsTermsOpen(true)}
                      className="underline font-bold cursor-pointer hover:opacity-80 inline-flex items-center gap-1"
                      style={{ color: activeTheme.textPrimary }}
                    >
                      <span>📜</span> 利用規約とプライバシーを開く →
                    </button>
                    <label
                      className="flex items-center gap-2 pt-2 border-t cursor-pointer select-none"
                      style={{ borderColor: activeTheme.border, color: activeTheme.textPrimary }}
                    >
                      <input
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => setAgreedToTerms(e.target.checked)}
                        className="w-4 h-4 rounded shrink-0 cursor-pointer"
                        style={{ accentColor: activeTheme.accent }}
                      />
                      <span className="text-xs font-bold">利用規約とプライバシーに同意する</span>
                    </label>
                  </div>
                )}

                {/* エラーメッセージ */}
                {authError && (
                  <div className="p-2 rounded-lg bg-[#fdeeed] border border-[#f5c6cb] text-xs text-[#b85448]">
                    {authError}
                  </div>
                )}

                {/* 成功メッセージ */}
                {authSuccessMsg && (
                  <div className="p-2 rounded-lg bg-[#eef6f0] border border-[#c3e6cb] text-xs text-[#529961] font-bold">
                    {authSuccessMsg}
                  </div>
                )}

                {/* 送信ボタン */}
                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={isAuthLoading || (authMode === "signup" && !agreedToTerms)}
                    className="w-full py-2.5 rounded-xl text-sm font-bold active:scale-[0.99] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50 shadow-xs cursor-pointer hover:opacity-85"
                    style={{
                      backgroundColor: activeTheme.accent,
                      color: activeTheme.accentText,
                    }}
                  >
                    {isAuthLoading
                      ? "通信中..."
                      : authMode === "login"
                      ? "ログインする"
                      : "アカウントを作成する"}
                  </button>
                </div>

                {/* ログイン時のみ：パスワード忘れリンク */}
                {authMode === "login" && (
                  <div className="text-center pt-1">
                    <button
                      type="button"
                      onClick={() => handleSwitchAuthMode("reset")}
                      className="text-xs underline font-medium cursor-pointer hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      パスワードをお忘れの方はこちら →
                    </button>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      )}

      {/* ⑧ アカウント新規作成完了＆復旧キー案内モーダル */}
      {newlyRegisteredKey && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-xs z-70 flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => {
            // 背景クリックでは閉じない（確実にボタンを押してもらう）
          }}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full max-h-[90vh] overflow-y-auto border shadow-2xl transition-all flex flex-col gap-4 text-center"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center gap-1">
              <span className="text-3xl">🌱</span>
              <h2
                className="text-base font-bold"
                style={{ color: activeTheme.textPrimary }}
              >
                アカウントを作成しました！
              </h2>
              <span
                className="text-xs"
                style={{ color: activeTheme.textSecondary }}
              >
                ログインやパスワード再設定に必要な【ID】と【復旧キー】です
              </span>
            </div>

            {/* ユーザー名（ID）と復旧キー枠 */}
            <div
              className="p-3.5 rounded-xl border-2 shadow-xs flex flex-col items-center gap-2.5"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.accent,
              }}
            >
              {/* ユーザー名（ID） */}
              <div className="w-full flex flex-col items-center gap-1">
                <span
                  className="text-[11px] font-bold"
                  style={{ color: activeTheme.textSecondary }}
                >
                  あなたのユーザー名（ID）
                </span>
                <code
                  className="text-sm font-mono font-bold select-all px-3 py-1 rounded-lg border"
                  style={{
                    backgroundColor: activeTheme.bgCard,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                  }}
                >
                  {currentUsername || "—"}
                </code>
              </div>

              <div className="w-full border-t" style={{ borderColor: activeTheme.border }} />

              {/* 復旧キー */}
              <div className="w-full flex flex-col items-center gap-1">
                <span
                  className="text-[11px] font-bold"
                  style={{ color: activeTheme.textSecondary }}
                >
                  あなたの復旧キー
                </span>
                <code
                  className="text-lg font-mono font-bold tracking-widest select-all px-3 py-1 rounded-lg border"
                  style={{
                    backgroundColor: activeTheme.bgCard,
                    borderColor: activeTheme.border,
                    color: activeTheme.textPrimary,
                  }}
                >
                  {newlyRegisteredKey}
                </code>
              </div>

              {/* まとめてコピーボタン */}
              <button
                type="button"
                onClick={() => {
                  const bundleText = `【ライトNote】アカウント情報\nユーザー名（ID）：${currentUsername || "未設定"}\n復旧キー：${newlyRegisteredKey}`;
                  navigator.clipboard.writeText(bundleText);
                  setCopiedBothToast(true);
                  setTimeout(() => setCopiedBothToast(false), 2000);
                }}
                className="w-full mt-0.5 py-2 px-3 text-xs font-bold rounded-lg border transition-colors flex items-center justify-center gap-1.5 shadow-2xs cursor-pointer hover:opacity-85"
                style={{
                  backgroundColor: activeTheme.bgCard,
                  borderColor: activeTheme.border,
                  color: activeTheme.textPrimary,
                }}
              >
                <CopyIcon className="w-3.5 h-3.5" />
                <span>{copiedBothToast ? "まとめてコピーしました！" : "IDと復旧キーをまとめてコピー"}</span>
              </button>
            </div>

            {/* 3大注意点 */}
            <div
              className="border rounded-xl p-3 text-left flex flex-col gap-1.5 text-xs leading-relaxed"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.border,
                color: activeTheme.textPrimary,
              }}
            >
              <span
                className="font-bold text-[11px] flex items-center gap-1"
                style={{ color: activeTheme.textPrimary }}
              >
                <span>⚠️</span> 大切なお願い（必ずお読みください）:
              </span>
              <ol className="list-decimal pl-4 space-y-1 text-[11px]">
                <li><strong>誰にも教えないでください</strong>（パスワードと同じ機密情報です）。</li>
                <li><strong>ライトNoteの中にメモしないでください</strong>（ログインできなくなると確認できなくなります）。</li>
                <li><strong>スクリーンショットを撮る</strong>か、別の安全な場所にIDと復旧キーを大切に保管してください。</li>
              </ol>
            </div>

            {/* 完了ボタン */}
            <button
              type="button"
              onClick={() => {
                setNewlyRegisteredKey(null);
                setCopiedBothToast(false);
              }}
              className="w-full py-2.5 rounded-xl text-sm font-bold active:scale-[0.99] transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer hover:opacity-85"
              style={{
                backgroundColor: activeTheme.accent,
                color: activeTheme.accentText,
              }}
            >
              IDと復旧キーをメモしたので始める
            </button>
          </div>
        </div>
      )}

      {/* ⑧ 利用規約・プライバシーポリシーモーダル */}
      {isTermsOpen && (
        <div
          className="fixed inset-0 bg-black/45 backdrop-blur-xs z-70 flex items-center justify-center p-4"
          onClick={() => setIsTermsOpen(false)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-lg w-full border shadow-2xl transition-all max-h-[88vh] flex flex-col"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between pb-3 mb-3 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <div>
                <h2 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                  <span>📜</span> 利用規約・プライバシーポリシー
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  ライトNoteをご利用いただく上でのルールと情報の取り扱い
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsTermsOpen(false)}
                className="text-xs px-2 py-1 rounded-lg hover:opacity-75 transition-opacity"
                style={{ color: activeTheme.textSecondary }}
              >
                ✕
              </button>
            </div>

            {/* 本文スクロールエリア（縦スクロールで全体を確認） */}
            <div className="flex-1 overflow-y-auto pr-1.5 space-y-4 text-xs leading-relaxed" style={{ color: activeTheme.textPrimary }}>
              {/* 利用規約ブロック */}
              <div className="space-y-3.5">
                <div className="text-sm font-bold pb-1.5 border-b flex items-center gap-1.5" style={{ borderColor: activeTheme.border }}>
                  <span>📜</span> 利用規約
                </div>

                {/* 第1条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第1条（目的・適用範囲）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    本規約は、ライトNote運営者（以下「運営者」）が提供するWebアプリ「ライトNote」（以下「本サービス」）の利用条件を定めるものです。利用者は、本規約およびプライバシーポリシーに同意のうえ本サービスを利用するものとします。
                  </p>
                </section>

                {/* 第2条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第2条（基本思想・データの不可逆性）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    本サービスは「書くこと」よりも「後から思い出すこと（再発見）」を最優先にした思考アーカイブです。過去の思考の残骸や間違いも未来のアイデアの種となるため、メモの完全削除や直接上書き編集機能は設けておらず、「追記」「本文訂正（履歴保存）」「ゴミ箱への移動」によって記録を管理する設計となっています。
                  </p>
                </section>

                {/* 第3条 */}
                <section className="space-y-1.5">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.isDark ? "#f5a398" : "#b85448" }}>
                    第3条（アカウント登録・復旧キーの管理）
                  </h3>
                  <ul className="list-disc pl-4 space-y-1.5 text-[11px] leading-relaxed">
                    <li>
                      利用者は、任意のユーザー名（ID）およびパスワードを設定してクラウド同期用アカウントを作成できます。なりすましや不正目的での登録は禁止します。
                    </li>
                    <li>
                      本サービスはメールアドレスを収集しない設計のため、パスワード再設定には登録時に発行される「復旧キー（SEED-XXXX-XXXX）」が唯一の手段となります。復旧キーは本サービス内にメモせず、スクリーンショット等で別の安全な場所に保管してください。
                    </li>
                    <li className="font-bold" style={{ color: activeTheme.isDark ? "#f5a398" : "#b85448" }}>
                      パスワードと復旧キーの両方を紛失された場合、本人確認手段がないため、運営者であってもパスワードの再設定やアカウントの復旧は一切行えません。
                    </li>
                  </ul>
                </section>

                {/* 第4条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第4条（利用料金・完全無料での運用）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    本サービスはテキスト思考に特化した軽量設計により、完全無料で提供します。無料インフラの安定運用のため、メモ1件あたりタイトル100文字・本文（および追記・訂正）各10,000文字、カテゴリ名30文字の上限を設けています。また、サービス継続の観点から、将来的に保存容量の上限設定や、一定期間利用されていないゴミ箱データの整理ルール等を導入する場合があります（重要な変更を行う場合は、アプリ内でのお知らせ等により事前に周知します）。
                  </p>
                </section>

                {/* 第5条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第5条（禁止事項）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    利用者は、本サービスの利用にあたり以下の行為をしてはなりません。
                  </p>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                    <li>法令または公序良俗に違反する行為</li>
                    <li>本サービスのサーバーやネットワークに過度な負荷をかける行為（自動ツールによる大量アクセス等）、不正アクセス、プログラムの改ざん・解析行為</li>
                    <li>他の利用者のアカウントを不正に使用する行為、または本サービスの運営を妨害する行為</li>
                  </ul>
                </section>

                {/* 第6条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第6条（退会・アカウント削除および利用停止）
                  </h3>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                    <li>
                      利用者は、設定画面内の「アカウントを削除する」機能から所定の手続きを行うことで、いつでもアカウントを削除できます。削除されたアカウントおよびクラウド上のデータは復旧できません。
                    </li>
                    <li>
                      運営者は、利用者が第5条に違反した場合、事前の通知なく当該アカウントの利用停止または削除等の措置を取ることができるものとします。
                    </li>
                  </ul>
                </section>

                {/* 第7条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第7条（サービスの変更・中断・終了）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    運営者は、メンテナンス、通信障害、利用している外部基盤（Vercel・Supabase等）の障害や仕様変更、その他運営上の理由により、事前の予告なく本サービスの内容変更、一時中断、または終了を行う場合があります。
                  </p>
                </section>

                {/* 第8条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第8条（免責事項）
                  </h3>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                    <li>
                      運営者は、本サービスに事実上または法律上の瑕疵（安全性、信頼性、正確性、特定目的への適合性等）がないことを明示的にも黙示的にも保証しません。
                    </li>
                    <li>
                      運営者の故意または重大な過失による場合を除き、本サービスの利用、停止、変更、終了、またはアカウント削除・データ消失等によって利用者に生じた損害について、運営者は責任を負いません。大切な記録は利用者ご自身でもコピー等で控えを保管することを推奨します。
                    </li>
                  </ul>
                </section>

                {/* 第9条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第9条（知的財産権）
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    本サービスのデザイン・プログラム・ロゴ等に関する権利は運営者または正当な権利者に帰属します。利用者が本サービスに記録したメモ内容の権利は、利用者本人に帰属します。
                  </p>
                </section>

                {/* 第10条 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    第10条（規約の変更・準拠法・管轄）
                  </h3>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                    <li>
                      運営者は、必要と判断した場合には本規約を変更できます。変更後の規約は本サービス上に表示された時点で効力を生じるものとします。
                    </li>
                    <li>
                      本規約の解釈にあたっては日本法を準拠法とし、本サービスに関して紛争が生じた場合には、東京地方裁判所を第一審の専属的合意管轄裁判所とします。
                    </li>
                  </ul>
                </section>
              </div>

              {/* プライバシーポリシーブロック */}
              <div
                className="space-y-3.5 mt-6 pt-5 border-t-4 border-double"
                style={{ borderColor: activeTheme.border }}
              >
                <div className="text-sm font-bold pb-1.5 border-b flex items-center gap-1.5" style={{ borderColor: activeTheme.border }}>
                  <span>🔒</span> プライバシーポリシー
                </div>

                {/* 1. 取得・保存する情報と利用目的 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    1. 取得・保存する情報と利用目的
                  </h3>
                  <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
                    <li>
                      <strong>ログインせず利用する場合：</strong>メモ・追記・テーマ設定等はすべてご利用端末のブラウザ内（localStorage）にのみ保存され、外部サーバーへ送信されません。
                    </li>
                    <li>
                      <strong>クラウド同期を利用する場合：</strong>端末間同期および本人認証のため、登録されたユーザー名（ID）、パスワード、および保存されたメモ・各種設定をクラウドデータベースに保存します。
                    </li>
                    <li>
                      <strong>個人情報の非収集：</strong>氏名、メールアドレス、電話番号、住所、位置情報などの個人情報は収集しません（お問い合わせ時にメールでご連絡いただいた情報のみ、返信・対応の目的に限って利用します）。
                    </li>
                  </ul>
                </section>

                {/* 2. データの保護と第三者提供 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    2. データの保護と第三者提供
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    保存されたメモはあなただけの完全なプライベートデータであり、公開や販売、広告トラッキングには一切利用せず、法令に基づく場合を除き第三者に提供しません。クラウド上のデータは行レベルセキュリティ（RLS）等により、他の利用者から閲覧できない形で保護されます。
                  </p>
                </section>

                {/* 3. 外部サービスの利用 */}
                <section className="space-y-1">
                  <h3 className="font-bold text-xs" style={{ color: activeTheme.accent }}>
                    3. 外部サービスの利用
                  </h3>
                  <p className="text-[11px] leading-relaxed">
                    本サービスの提供・データ保存のため、外部クラウド基盤（Vercel / Supabase）を利用しています。
                  </p>
                </section>

                {/* 制定日・お問い合わせ */}
                <section
                  className="mt-5 pt-3 border-t text-[11px] leading-relaxed space-y-0.5"
                  style={{
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  <div>制定日：2026年11月12日</div>
                  <div>運営者：ライトNote運営者</div>
                  <div>お問い合わせ：app746.tahry@gmail.com</div>
                </section>
              </div>
            </div>

            {/* フッター */}
            <div className="pt-3 mt-3 border-t shrink-0 flex justify-end" style={{ borderColor: activeTheme.border }}>
              <button
                type="button"
                onClick={() => setIsTermsOpen(false)}
                className="px-5 py-2 rounded-xl text-xs font-bold transition-all shadow-xs"
                style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
              >
                とじる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⑧-2 アカウント削除（本人確認＋最終警告）モーダル */}
      {isDeleteAccountModalOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-xs z-70 flex items-center justify-center p-4"
          onClick={handleCloseDeleteAccountModal}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full max-h-[90vh] overflow-y-auto border shadow-2xl transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-4 pb-2 border-b" style={{ borderColor: activeTheme.border }}>
              <h2
                className="text-base font-bold flex items-center gap-1.5"
                style={{ color: activeTheme.isDark ? "#f5a398" : "#b85448" }}
              >
                <span>⚠️</span>{" "}
                {deleteAccountStep === "auth" ? "アカウントの削除（本人確認）" : "アカウント削除の最終確認"}
              </h2>
              <button
                type="button"
                onClick={handleCloseDeleteAccountModal}
                disabled={isDeletingAccount}
                className="text-xs px-2 py-1 transition-opacity hover:opacity-75 disabled:opacity-40"
                style={{ color: activeTheme.textSecondary }}
              >
                ✕
              </button>
            </div>

            {deleteAccountStep === "auth" ? (
              <form onSubmit={handleVerifyDeleteAccount} className="space-y-3.5">
                <p className="text-xs leading-relaxed" style={{ color: activeTheme.textSecondary }}>
                  アカウント削除へ進むため、現在ログイン中のユーザー名（ID）とパスワードを入力して本人確認を行ってください。
                </p>

                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    ユーザー名（ID）
                  </label>
                  <input
                    type="text"
                    placeholder="現在ログイン中のユーザー名"
                    value={deleteUsernameInput}
                    onChange={(e) => setDeleteUsernameInput(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    required
                    className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none transition-colors"
                    style={{
                      backgroundColor: activeTheme.bgSub,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  />
                </div>

                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    パスワード
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showDeletePassword ? "text" : "password"}
                      placeholder="パスワードを入力"
                      maxLength={MAX_PASSWORD_LENGTH}
                      value={deletePasswordInput}
                      onChange={(e) => setDeletePasswordInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm rounded-xl border focus:outline-none transition-colors"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowDeletePassword(!showDeletePassword)}
                      className="absolute right-2.5 text-sm p-1 transition-opacity hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                      title={showDeletePassword ? "パスワードを隠す" : "パスワードを表示する"}
                      aria-label={showDeletePassword ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showDeletePassword ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {deleteAccountError && (
                  <div className="p-2 rounded-lg bg-[#fdeeed] border border-[#f5c6cb] text-xs text-[#b85448]">
                    {deleteAccountError}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleCloseDeleteAccountModal}
                    disabled={isDeletingAccount}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40"
                    style={{ color: activeTheme.textSecondary }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="submit"
                    disabled={isDeletingAccount}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-[#b85448] text-white hover:bg-[#a34438] transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                  >
                    {isDeletingAccount ? "確認中..." : "次へ進む"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div
                  className="p-3 rounded-xl border text-xs leading-relaxed space-y-1.5"
                  style={{
                    backgroundColor: activeTheme.isDark ? "rgba(184, 84, 72, 0.14)" : "#fdeeed",
                    borderColor: activeTheme.isDark ? "rgba(245, 163, 152, 0.4)" : "#f5c6cb",
                    color: activeTheme.isDark ? "#f5a398" : "#9e3a2f",
                  }}
                >
                  <p className="font-bold">
                    アカウントの削除を行った場合は、アカウントに関するすべての情報が削除されます。
                  </p>
                  <p>
                    運営者の故意または重大な過失による場合を除き、これによって損害が生じた場合、運営は責任を負いません。また、削除後のアカウントの復旧は不可能です。
                  </p>
                  <p className="font-bold pt-0.5">
                    本当にアカウントを削除しますか？
                  </p>
                </div>

                <div
                  className="p-3 rounded-xl border space-y-2"
                  style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
                >
                  <label
                    className="flex items-start gap-2 cursor-pointer select-none"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    <input
                      type="checkbox"
                      checked={deleteLocalDataToo}
                      onChange={(e) => setDeleteLocalDataToo(e.target.checked)}
                      className="w-4 h-4 mt-0.5 rounded shrink-0 cursor-pointer"
                      style={{ accentColor: activeTheme.accent }}
                    />
                    <span className="text-xs font-bold leading-snug">
                      この端末（ブラウザ）に保存されているメモ・設定もすべて消去する
                    </span>
                  </label>
                  <p className="text-[11px] leading-relaxed pl-6" style={{ color: activeTheme.textSecondary }}>
                    ※チェックを外すとローカル内にデータが残り、ローカル内でのみ使い続けることができます。また、この場合は再度アカウントを作成した際に、他端末と情報を共有できるようになります。
                  </p>
                </div>

                {deleteAccountError && (
                  <div className="p-2 rounded-lg bg-[#fdeeed] border border-[#f5c6cb] text-xs text-[#b85448]">
                    {deleteAccountError}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCloseDeleteAccountModal}
                    disabled={isDeletingAccount}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40"
                    style={{ color: activeTheme.textSecondary }}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={handleExecuteDeleteAccount}
                    disabled={isDeletingAccount}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-[#b85448] text-white hover:bg-[#a34438] transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                  >
                    {isDeletingAccount ? "削除中..." : "アカウントを完全に削除する"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⑨ インタラクティブ・ウォークスルーチュートリアル（スポットライト＆ガイドカード） */}
      {tutorialStep !== null && (
        <div className="fixed inset-0 z-50 pointer-events-none select-none">
          {/* スポットライト（SVGの美しい角丸マスクでくり抜き、四隅のカクカク角張りを完全解消） */}
          <svg className="fixed inset-0 w-full h-full pointer-events-none z-40 transition-all duration-300">
            <defs>
              <mask id="tutorial-spotlight-mask">
                {/* 全画面を不透明（白＝暗幕表示） */}
                <rect width="100%" height="100%" fill="white" />
                {/* 対象要素のみ滑らかな角丸でくり抜き（黒＝透明） */}
                {tutorialTargetRect && (
                  <rect
                    x={Math.max(0, tutorialTargetRect.left - 6)}
                    y={Math.max(0, tutorialTargetRect.top - 6)}
                    width={tutorialTargetRect.width + 12}
                    height={tutorialTargetRect.height + 12}
                    rx="16"
                    ry="16"
                    fill="black"
                  />
                )}
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="rgba(0, 0, 0, 0.72)"
              mask="url(#tutorial-spotlight-mask)"
            />
          </svg>

          {/* くり抜き枠の光彩リング（pointer-events-none で下への入力を100%通す） */}
          {tutorialTargetRect && (
            <div
              className="fixed pointer-events-none z-40 rounded-2xl ring-2 ring-white/60 shadow-2xl transition-all duration-300 ease-out"
              style={{
                top: Math.max(0, tutorialTargetRect.top - 6),
                left: Math.max(0, tutorialTargetRect.left - 6),
                width: tutorialTargetRect.width + 12,
                height: tutorialTargetRect.height + 12,
              }}
            />
          )}

          {/* ガイド案内カード（getGuideCardStyle によりPCでは横余白、スマホでは上下に自動配置して被りを完全防止） */}
          <div
            id="tutorial-guide-card"
            className="pointer-events-auto transition-all duration-300"
            style={getGuideCardStyle()}
          >
            <div
              className="w-full max-h-[38vh] sm:max-h-[42vh] overflow-y-auto rounded-2xl p-3 sm:p-5 border shadow-2xl transition-all duration-300 flex flex-col gap-1.5 sm:gap-2.5 animate-fadeIn"
              style={{
                backgroundColor: activeTheme.bgCard,
                borderColor: activeTheme.border,
                color: activeTheme.textPrimary,
              }}
            >
              {/* カードヘッダー */}
              <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: activeTheme.border }}>
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold flex items-center gap-1">
                    {tutorialStep === 1 && "🌱 はじめに"}
                    {tutorialStep === 2 && "✏️ 思考の即メモ"}
                    {tutorialStep === 3 && "🏷️ タイトルとタグ"}
                    {tutorialStep === 4 && "🔄 書く・見るの切り替え"}
                    {tutorialStep === 5 && "🔍 検索・絞り込み"}
                    {tutorialStep === 6 && "📝 メモの追記・訂正・整理"}
                    {tutorialStep === 7 && "⚙️ メニューとアカウント"}
                    {tutorialStep === 8 && "🎉 チュートリアル完了！"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full border font-mono"
                    style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border, color: activeTheme.textSecondary }}
                  >
                    {tutorialStep} / 8
                  </span>
                  <button
                    type="button"
                    onClick={handleCloseTutorial}
                    className="text-xs px-1.5 py-0.5 hover:opacity-75 transition-opacity"
                    style={{ color: activeTheme.textSecondary }}
                    title="チュートリアルを終了する"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* カード本文 */}
              <div className="text-xs leading-relaxed space-y-1.5">
                {tutorialStep === 1 && (
                  <>
                    <p className="font-bold text-sm mb-1">ライトNoteへようこそ！</p>
                    <p>ライトNoteは、思いついたアイデアや思考を<strong>忘れる前に光のように即メモする</strong>ためのメモアプリです。</p>
                    <p>基本の操作を、実際に使いながら理解しましょう！</p>
                  </>
                )}
                {tutorialStep === 2 && (
                  <>
                    <p className="font-bold text-sm mb-1">思考を逃さず即メモ</p>
                    <p>枠で光っている部分がメモ入力エリアです。開いてすぐ書けるように、起動直後は入力欄だけが表示されます。</p>
                    {content.trim().length > 0 ? (
                      <p className="text-[11px] p-2 rounded-lg border mt-1 animate-fadeIn" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                        ✨ 入力できましたね！<strong>「次へ →」</strong>を押して進みましょう。
                      </p>
                    ) : (
                      <p className="text-[11px] font-bold p-2 rounded-lg border mt-1" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                        💡 枠内の鉛筆マーク（✏️）のあたりをタップして、実際に何か文字を入力してみてください！
                      </p>
                    )}
                  </>
                )}
                {tutorialStep === 3 && (
                  <>
                    <p className="font-bold text-sm mb-1">タグとタイトル、そして保存</p>
                    <p>文字を入力すると、カテゴリタグやタイトル欄、保存ボタンが現れます。</p>
                    <p>
                      急いでいる時は、<strong>タイトルやカテゴリを付けずに保存してOK！</strong>
                    </p>
                    <p className="text-[11px] p-2 rounded-lg border mt-1" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                      💡 右下の<strong>「保存」ボタン</strong>を押してメモを保存してみましょう！（※自動で次の画面へ進みます）
                    </p>
                  </>
                )}
                {tutorialStep === 4 && (
                  <>
                    <p className="font-bold text-sm mb-1">「書く」と「見る」を切り替え</p>
                    <p>最上部中央のカプセルボタンで、メモを書く画面と、過去のメモを振り返る画面をいつでもワンタップで行き来できます。</p>
                    <p className="text-[11px] font-bold p-2 rounded-lg border mt-1" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                      💡 「次へ」を押すと、過去のメモを見る一覧画面に切り替わります！
                    </p>
                  </>
                )}
                {tutorialStep === 5 && (
                  <>
                    <p className="font-bold text-sm mb-1">探したい思考を素早く検索</p>
                    <p>一覧画面の「🔍 検索機能」から、キーワード、カテゴリタグ、お気に入り（⭐）、書いた時間帯や日付（カレンダー）で目的のメモを絞り込めます。</p>
                  </>
                )}
                {tutorialStep === 6 && (
                  <>
                    <p className="font-bold text-sm mb-1">右上の「…」メニューからいろいろできます</p>
                    <p>
                      書き足したい時は<strong>「💬 追記する」</strong>、誤字や内容を直したい時は元の文章を履歴に残したまま直せる<strong>「✏️ 本文を訂正する」</strong>を使えます。そのほか<strong>「🏷️ タイトル・カテゴリの変更」</strong>や<strong>「🗑️ ゴミ箱へ移動」</strong>もここから行えます。
                    </p>
                    <p className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                      ※「…」の中身は開いて見られますが、ここの機能は後で試してみてください！
                    </p>
                  </>
                )}
                {tutorialStep === 7 && (
                  <>
                    <p className="font-bold text-sm mb-1">メニューとアカウント</p>
                    {!isMenuOpen ? (
                      <>
                        <p>左上の「≡」メニューから、アカウント設定や各種管理・見た目設定などが開けます。</p>
                        <p className="text-[11px] p-2 rounded-lg border mt-1 animate-fadeIn" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                          💡 左上の<strong>「≡」ボタンをタップ</strong>して、メニューを開いてみましょう！
                        </p>
                      </>
                    ) : (
                      <>
                        <p>メニューが開きました！複数端末でメモを同期できるアカウント設定や、タグ管理、ゴミ箱の確認、各種設定などがここから行えます！</p>
                        <p className="text-[11px] p-2 rounded-lg border mt-1 animate-fadeIn" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                          🎉 開けましたね！右下の<strong>「次へ →」</strong>を押して最後のステップへ進みましょう。
                        </p>
                      </>
                    )}
                  </>
                )}
                {tutorialStep === 8 && (
                  <>
                    <p className="font-bold text-sm mb-1">チュートリアル完了です！</p>
                    <p>これで基本操作はバッチリです！より詳しい使い方や再度チュートリアルを行いたい場合は、右上の「？」（ガイド・ヘルプ）からいつでも確認できます。</p>
                  </>
                )}
              </div>

              {/* 注意書き */}
              {tutorialStep === 1 && (
                <div className="text-[10px] text-center" style={{ color: activeTheme.textSecondary }}>
                  ※途中で閉じても、右上の「？」（ガイド・ヘルプ）からいつでも再開できます
                </div>
              )}

              {/* ボタン操作 */}
              <div className="flex items-center justify-between gap-2 pt-2 border-t" style={{ borderColor: activeTheme.border }}>
                {tutorialStep === 1 ? (
                  <>
                    <button
                      type="button"
                      onClick={handleCloseTutorial}
                      className="px-3.5 py-1.5 text-xs rounded-xl font-medium transition-colors hover:opacity-80"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      スキップ
                    </button>
                    <button
                      type="button"
                      onClick={handleNextTutorialStep}
                      className="px-5 py-2 text-xs font-bold rounded-xl shadow-xs transition-all hover:opacity-90"
                      style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                    >
                      体験してみる →
                    </button>
                  </>
                ) : tutorialStep === 8 ? (
                  <button
                    type="button"
                    onClick={handleCloseTutorial}
                    className="w-full py-2.5 text-xs font-bold rounded-xl shadow-xs transition-all hover:opacity-90 flex items-center justify-center gap-1.5"
                    style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                  >
                    <span>✨</span> ライトNoteを始める
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handlePrevTutorialStep}
                      className="px-3.5 py-1.5 text-xs rounded-xl font-medium transition-colors hover:opacity-80 border"
                      style={{
                        backgroundColor: activeTheme.bgSub,
                        borderColor: activeTheme.border,
                        color: activeTheme.textSecondary,
                      }}
                    >
                      ← 前へ
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCloseTutorial}
                        className="px-2.5 py-1.5 text-xs rounded-xl font-medium transition-colors hover:opacity-80"
                        style={{ color: activeTheme.textSecondary }}
                      >
                        終了
                      </button>
                      <button
                        type="button"
                        onClick={handleNextTutorialStep}
                        className="px-4 py-1.5 text-xs font-bold rounded-xl shadow-xs transition-all hover:opacity-90"
                        style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                      >
                        次へ →
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
