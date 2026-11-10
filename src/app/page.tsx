"use client";

import { useState, useEffect, useRef, useMemo } from "react";
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
}

// Supabase DB用レコード定義
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
}

// DB行からNoteオブジェクトへのマッピング
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
  return row;
};

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

// Supabase DB用ユーザー設定・カテゴリ同期レコード定義
interface DbUserSettingsRow {
  user_id: string;
  categories: string[] | null;
  time_slots: Record<TimeSlotKey, TimeSlotConfig> | null;
  font_size: FontSize | null;
  button_size: ButtonSize | null;
  enable_toast: boolean | null;
  confirm_discard: boolean | null;
  recovery_key?: string | null;
  theme_hue?: ColorHue | null;
  theme_brightness?: ThemeBrightness | null;
  updated_at?: string;
}

// ガイド・ヘルプの全項目データ
const HELP_ITEMS = [
  {
    id: "about",
    title: "SeedNoteとは",
    content: (
      <div className="space-y-1.5">
        <p>自分のアイデアや思いついたことを素早く記録し、あとから簡単に探し出せる自分専用のアプリです。</p>
        <p>日記、仕事や勉強のメモ、読書記録、ふと思いついたアイデアなど、ジャンルを問わず自由に記録できます。</p>
        <p>SNSのように気軽に投稿できますが、書いた内容はすべて自分だけのプライベートな記録になります。</p>
      </div>
    ),
  },
  {
    id: "concept",
    title: "SeedNoteの考え方",
    content: (
      <div className="space-y-1.5">
        <p>SeedNoteは、<strong>「書くこと」よりも「思い出すこと」</strong>を一番大切にしています。</p>
        <p>アイデアは、書いた直後よりも数か月後や数年後に思いがけない価値を持つことがあります。</p>
        <p>そのため、「まずはパッと記録する」「整理は後からでOK」「過去の記録をなるべく残す」という考え方で作られています。</p>
      </div>
    ),
  },
  {
    id: "start",
    title: "はじめかた",
    content: (
      <div className="space-y-2">
        <ol className="list-decimal pl-5 space-y-1">
          <li>思いついたことをそのまま書く</li>
          <li>「保存」を押す</li>
          <li>必要であれば、後からカテゴリを設定する</li>
        </ol>
        <p className="text-xs text-[#786f66] pt-1">
          ※最初は細かい整理を気にせず、思いついたことをどんどん記録してみてください。
        </p>
      </div>
    ),
  },
  {
    id: "save",
    title: "メモの保存（保存通知について）",
    content: (
      <div className="space-y-2">
        <p>
          書いた内容は「保存」ボタンを押すだけで記録されます。キーボードの{" "}
          <code className="bg-[#e8e0d3] px-1 py-0.5 rounded text-xs">Ctrl + Enter</code>
          （Macは <code className="bg-[#e8e0d3] px-1 py-0.5 rounded text-xs">Cmd + Enter</code>）
          でも素早く保存できます。
        </p>
        <div className="pt-1 border-t border-[#e5ded2]">
          <strong className="block mb-1 text-[#3d3731]">保存通知について：</strong>
          <p>
            メモを保存した時に、画面の上に「保存しました」という小さな通知を表示できます。「ちゃんと保存されたかな？」と安心したい時におすすめです。通知が不要な場合は、メニューの「設定」からOFFにすることもできます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "category",
    title: "カテゴリ（”未分類”について）",
    content: (
      <div className="space-y-2.5">
        <div>
          <strong className="block mb-0.5 text-[#3d3731]">カテゴリの作成：</strong>
          <p>「日記」「仕事」「勉強」など、自分の好きなカテゴリを自由に作れます。一度使ったカテゴリは候補として表示されるので、次からはワンタップで選べます。</p>
        </div>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">”未分類”での保存：</strong>
          <p>
            カテゴリで迷ったときは、何も選ばず<strong>「”未分類”」のまま保存して大丈夫</strong>です。「アイデアが浮かんだ瞬間にすぐ書くこと」を一番優先してほしいので、カテゴリは後からいつでも設定・変更できます。
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
        <p className="text-[11px] text-[#786f66] pt-1">
          ※ゴミ箱やカテゴリ管理、文字サイズなどの設定は、左上の「≡」メニューから開けます。
        </p>
      </div>
    ),
  },
  {
    id: "search",
    title: "検索・絞り込みとお気に入り（☆/★）",
    content: (
      <div className="space-y-2">
        <p>メモ一覧の「🔍 検索機能」ボタンから、見返したいメモを素早く探せます。</p>
        <ul className="list-disc pl-5 space-y-1.5 text-xs">
          <li><strong>🔤 キーワードで探す：</strong> タイトル、本文、追記に含まれる言葉で一発検索できます。</li>
          <li><strong>⭐ お気に入りのみ表示：</strong> メモカード右上にある星マーク（☆/★）で登録した大切なお気に入りを絞り込みます。</li>
          <li><strong>🏷️ タグからさがす：</strong> 指定したカテゴリや「”未分類”」に絞って探せます（複数選んでのAND検索に対応）。</li>
          <li><strong>⏰ 時間帯からさがす：</strong> 朝、昼、夕方、夜、深夜など、書いた時間帯で絞り込めます（複数選択可）。</li>
          <li><strong>🗑️ ゴミ箱の検索：</strong> 「ゴミ箱のメモも含めて探す」を使えば、ゴミ箱内のメモも一緒に探してその場で元に戻せます。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "reply",
    title: "メモへの追記",
    content: (
      <div className="space-y-1.5 text-xs">
        <p>
          メモカード右上の「…」メニューから「💬 追記する」を選ぶと、過去のメモの下にタイムスタンプ付きで思考の続きを書き足せます。
        </p>
        <p>
          追記は普段折りたたまれており、タップして開いたり閉じたりできます。
        </p>
      </div>
    ),
  },
  {
    id: "edit_metadata",
    title: "タイトル・カテゴリの変更",
    content: (
      <div className="space-y-2 text-xs">
        <p>
          メモカード右上の「…」メニューから「🏷️ タイトル・カテゴリの変更」を選ぶと、見出しやタグを後から整理できます。
        </p>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">本文の編集について：</strong>
          <p>
            ライトNoteでは、過去の思考をありのまま残すため、<strong>本文の編集や削除はできない</strong>仕組みになっています（続きを書き足したい時は「追記」をご利用ください）。
          </p>
        </div>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">変更途中で閉じる場合：</strong>
          <p>
            タイトルやカテゴリの変更中に保存せずキャンセルしようとした場合、変更があれば「破棄しますか？」と確認画面が出ます（設定からON/OFF可能）。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "trash",
    title: "ゴミ箱",
    content: (
      <div className="space-y-2">
        <div>
          <strong className="block mb-0.5 text-[#3d3731]">ゴミ箱への移動手順：</strong>
          <p>
            メモカード右上の「…」ボタンを押すと、「ゴミ箱へ移動」が表示されます。誤タップを防ぐため、2段階で移動する仕組みになっています。
          </p>
        </div>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">データの保持と復元：</strong>
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
    id: "timezone",
    title: "時間帯の設定",
    content: (
      <div className="space-y-1.5">
        <p>「深夜」や「夕方」と感じる時間は人によって違います。</p>
        <p>設定画面から「朝・昼・夕方・夜・深夜」の区切りを自分の生活リズムに合わせて自由に変更できます。</p>
        <p>設定した時間帯は、検索機能にもそのまま反映されます。</p>
      </div>
    ),
  },
  {
    id: "faq",
    title: "よくある質問（FAQ）",
    content: (
      <div className="space-y-3">
        <div className="p-2.5 bg-[#eae4d9] rounded-xl">
          <p className="font-bold text-[#3d3731] text-xs">Q. カテゴリが決まりません</p>
          <p className="mt-1 text-xs text-[#5c5348]">A. 「”未分類”」のまま保存してください。後からいつでも変更できます。</p>
        </div>
        <div className="p-2.5 bg-[#eae4d9] rounded-xl">
          <p className="font-bold text-[#3d3731] text-xs">Q. ゴミ箱に入れたメモは消えてしまいますか？</p>
          <p className="mt-1 text-xs text-[#5c5348]">A. 勝手に消えることはありません。安全に保管されています（※容量が限界になった時だけ、ゴミ箱内の古いものから整理の対象になります）。</p>
        </div>
        <div className="p-2.5 bg-[#eae4d9] rounded-xl">
          <p className="font-bold text-[#3d3731] text-xs">Q. 容量がいっぱいになったらどうなりますか？</p>
          <p className="mt-1 text-xs text-[#5c5348]">A. まずゴミ箱の中の古いメモから整理されます。ゴミ箱が空の場合は整理の提案を表示します。普段のメモが勝手に消えることはありません。</p>
        </div>
        <div className="p-2.5 bg-[#eae4d9] rounded-xl">
          <p className="font-bold text-[#3d3731] text-xs">Q. なぜアプリを開いた瞬間に入力画面が出るのですか？</p>
          <p className="mt-1 text-xs text-[#5c5348]">A. アイデアを忘れてしまわないよう、アプリを開いてから書き留めるまでの操作を最小限にするためです。</p>
        </div>
      </div>
    ),
  },
];

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [activeTab, setActiveTab] = useState<TabType>("home");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [openHelpSection, setOpenHelpSection] = useState<string | null>(null);
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
  const [categoriesList, setCategoriesList] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [isAddingCategoryInline, setIsAddingCategoryInline] = useState(false);
  const [inlineNewCategoryName, setInlineNewCategoryName] = useState("");
  const [newCategoryInput, setNewCategoryInput] = useState("");
  const [categoryToDelete, setCategoryToDelete] = useState<string | null>(null);

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

  // 検索・絞り込みパネルとお気に入りのState
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [filterOnlyFavorite, setFilterOnlyFavorite] = useState(false);
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
  const [copiedKeyToast, setCopiedKeyToast] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccessMsg, setAuthSuccessMsg] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const [isLoaded, setIsLoaded] = useState(false);

  // 初回読み込み時にブラウザの保存領域 (localStorage) からデータを復元
  useEffect(() => {
    try {
      const savedNotes = localStorage.getItem("seednote_items");
      if (savedNotes) {
        setNotes(JSON.parse(savedNotes));
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
      const savedCategories = localStorage.getItem("seednote_categories");
      if (savedCategories) {
        setCategoriesList(JSON.parse(savedCategories));
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
    } catch (e) {
      console.error("データの読み込みに失敗しました", e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // カテゴリの並び順変更
  const handleCategorySortOrderChange = (order: CategorySortOrder) => {
    setCategorySortOrder(order);
    localStorage.setItem("seednote_category_sort_order", order);
  };

  // カテゴリ一覧を指定された並び順でソート（よく使う順 / 五十音順 / 登録順）
  const sortedCategories = useMemo(() => {
    const list = [...categoriesList];
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
        const countA = counts.get(a) || 0;
        const countB = counts.get(b) || 0;
        if (countB !== countA) return countB - countA;
        return a.localeCompare(b, "ja");
      });
    } else if (categorySortOrder === "alphabetical") {
      return list.sort((a, b) => a.localeCompare(b, "ja"));
    } else {
      return list;
    }
  }, [categoriesList, notes, categorySortOrder]);

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
  ]);

  // 設定のクラウド保存用デバウンスタイマー
  const cloudSettingsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // ユーザー設定・カテゴリの変更をクラウドへ保存（デバウンス対応）
  const saveCloudSettings = (
    partial: Partial<{
      categories: string[];
      time_slots: Record<TimeSlotKey, TimeSlotConfig>;
      font_size: FontSize;
      button_size: ButtonSize;
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
        await supabase.from("user_settings").upsert({
          user_id: currentUser.id,
          categories: partial.categories ?? cur.categoriesList,
          time_slots: partial.time_slots ?? cur.timeSlots,
          font_size: partial.font_size ?? cur.fontSize,
          button_size: partial.button_size ?? cur.buttonSize,
          enable_toast: partial.enable_toast ?? cur.enableToast,
          confirm_discard: partial.confirm_discard ?? cur.confirmDiscardOnEdit,
          theme_hue: partial.theme_hue ?? cur.selectedHue,
          theme_brightness: partial.theme_brightness ?? cur.themeBrightness,
          updated_at: new Date().toISOString(),
        });
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
    setIsSyncing(true);
    try {
      const { data, error } = await supabase
        .from("notes")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("クラウドメモの取得に失敗しました", error);
        return;
      }

      if (data) {
        const cloudNotes: Note[] = (data as DbNoteRow[]).map(mapDbRowToNote);
        const baseLocalNotes = currentLocalNotes ?? notes;

        // クラウドノート側で、もしローカルに訂正履歴があってクラウド側が空または古い場合はローカル履歴を保護
        const protectedCloudNotes = cloudNotes.map((cn) => {
          const loc = baseLocalNotes.find((l) => l.id === cn.id);
          if (loc?.editHistory && loc.editHistory.length > 0) {
            const cloudCount = cn.editHistory?.length || 0;
            if (cloudCount < loc.editHistory.length) {
              return { ...cn, editHistory: loc.editHistory };
            }
          }
          return cn;
        });

        // ローカルの履歴がクラウドに未反映だった場合はバックグラウンドでクラウド側も更新（自己修復）
        protectedCloudNotes.forEach((cn) => {
          const loc = baseLocalNotes.find((l) => l.id === cn.id);
          if (loc?.editHistory && loc.editHistory.length > 0) {
            const rawCloudCount = (cloudNotes.find((c) => c.id === cn.id)?.editHistory || []).length;
            if (rawCloudCount < loc.editHistory.length) {
              supabase
                .from("notes")
                .update({ edit_history: loc.editHistory })
                .eq("id", cn.id)
                .then();
            }
          }
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

        // クラウドのメモで更新
        setNotes(finalNotes);
        localStorage.setItem("seednote_items", JSON.stringify(finalNotes));

        // メモに付与されている全カテゴリタグを抽出して設定同期に連携
        const noteCats = Array.from(
          new Set(finalNotes.flatMap((n) => n.categories || []))
        );
        fetchUserSettings(userId, noteCats);
      }
    } catch (e) {
      console.error("同期処理中にエラーが発生しました", e);
    } finally {
      setIsSyncing(false);
    }
  };

  // クラウド（Supabase）からユーザー設定・カテゴリを取得＆ローカルと同期
  const fetchUserSettings = async (userId: string, extraCategories?: string[]) => {
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
      let localCats: string[] = [];
      try {
        const savedCats = localStorage.getItem("seednote_categories");
        if (savedCats) localCats = JSON.parse(savedCats);
      } catch {
        localCats = latestSettingsRef.current.categoriesList;
      }

      if (data) {
        const row = data as DbUserSettingsRow;
        const cloudCats: string[] = Array.isArray(row.categories) ? row.categories : [];

        // クラウドカテゴリ + ローカルカテゴリ + メモに付与されているカテゴリを重複なく統合
        const mergedCats = Array.from(
          new Set([...cloudCats, ...localCats, ...(extraCategories || [])])
        );
        setCategoriesList(mergedCats);
        localStorage.setItem("seednote_categories", JSON.stringify(mergedCats));

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

        // もしローカルやメモから新しいカテゴリが見つかった場合、クラウド側も最新化
        if (mergedCats.length > cloudCats.length) {
          const cur = latestSettingsRef.current;
          await supabase.from("user_settings").upsert({
            user_id: userId,
            categories: mergedCats,
            time_slots: row.time_slots || cur.timeSlots,
            font_size: row.font_size || cur.fontSize,
            button_size: row.button_size || cur.buttonSize,
            enable_toast: row.enable_toast ?? cur.enableToast,
            confirm_discard: row.confirm_discard ?? cur.confirmDiscardOnEdit,
            theme_hue: row.theme_hue || cur.selectedHue,
            theme_brightness: row.theme_brightness || cur.themeBrightness,
            updated_at: new Date().toISOString(),
          });
        }
      } else {
        // クラウドにまだ設定がない場合：現在のローカル設定をクラウドに初回保存
        const cur = latestSettingsRef.current;
        const initialCats = Array.from(new Set([...localCats, ...(extraCategories || [])]));
        const generated = generateRecoveryKey();
        setRecoveryKey(generated);
        localStorage.setItem("seednote_recovery_key", generated);
        await supabase.from("user_settings").upsert({
          user_id: userId,
          categories: initialCats,
          time_slots: cur.timeSlots,
          font_size: cur.fontSize,
          button_size: cur.buttonSize,
          enable_toast: cur.enableToast,
          confirm_discard: cur.confirmDiscardOnEdit,
          recovery_key: generated,
          theme_hue: cur.selectedHue,
          theme_brightness: cur.themeBrightness,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("設定同期中にエラーが発生しました", e);
    }
  };

  // 初回ロード時にSupabaseセッションを復元＆状態変化を監視
  useEffect(() => {
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

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // ユーザー名から内部メールアドレスを生成
  const getInternalEmail = (username: string) => {
    return `${username.trim().toLowerCase()}@seednote.local`;
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
    if (!password) {
      setAuthError("パスワードを入力してください");
      return;
    }
    if (password.length < 6) {
      setAuthError("パスワードは6文字以上で設定してください");
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
    }

    setIsAuthLoading(true);
    const internalEmail = getInternalEmail(username);

    try {
      if (authMode === "login") {
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
          }, 800);
        }
      } else {
        // 新規登録
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
          setRecoveryKey(generatedKey);
          localStorage.setItem("seednote_recovery_key", generatedKey);

          // user_settingsに復旧キーを保存
          const cur = latestSettingsRef.current;
          await supabase.from("user_settings").upsert({
            user_id: data.user.id,
            recovery_key: generatedKey,
            categories: cur.categoriesList,
            time_slots: cur.timeSlots,
            font_size: cur.fontSize,
            button_size: cur.buttonSize,
            enable_toast: cur.enableToast,
            confirm_discard: cur.confirmDiscardOnEdit,
            updated_at: new Date().toISOString(),
          });

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
          setNewlyRegisteredKey(generatedKey);
        }
      }
    } catch {
      setAuthError("通信エラーが発生しました。接続を確認してください。");
    } finally {
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
    if (!recoveryKeyInput) {
      setAuthError("復旧キーを入力してください");
      return;
    }
    if (!password) {
      setAuthError("新しいパスワードを入力してください");
      return;
    }
    if (password.length < 6) {
      setAuthError("パスワードは6文字以上で設定してください");
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
  };

  // カテゴリの選択・解除切り替え
  const handleToggleCategory = (catName: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catName)
        ? prev.filter((c) => c !== catName)
        : [...prev, catName]
    );
  };

  // 新規カテゴリの追加処理
  const handleAddCategory = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

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
      return;
    }

    if (categoriesList.includes(trimmed)) return;

    const updated = [...categoriesList, trimmed];
    setCategoriesList(updated);
    try {
      localStorage.setItem("seednote_categories", JSON.stringify(updated));
    } catch (e) {
      console.error("カテゴリの保存に失敗しました", e);
    }
    saveCloudSettings({ categories: updated }, true);
  };

  // メモ入力中のインライン新規カテゴリ追加
  const handleSaveInlineCategory = () => {
    const trimmed = inlineNewCategoryName.trim();
    if (trimmed) {
      handleAddCategory(trimmed);
      if (!selectedCategories.includes(trimmed)) {
        setSelectedCategories((prev) => [...prev, trimmed]);
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

    // カテゴリリストから除外
    const updatedCategories = categoriesList.filter((c) => c !== categoryToDelete);
    setCategoriesList(updatedCategories);
    localStorage.setItem("seednote_categories", JSON.stringify(updatedCategories));
    saveCloudSettings({ categories: updatedCategories }, true);

    // 選択中カテゴリからも除外
    setSelectedCategories((prev) => prev.filter((c) => c !== categoryToDelete));

    // 既存メモから該当カテゴリのみを除外
    const notesToUpdateInCloud: Note[] = [];
    const updatedNotes = notes.map((note) => {
      if (!note.categories) return note;
      if (note.categories.includes(categoryToDelete)) {
        const filtered = note.categories.filter((c) => c !== categoryToDelete);
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
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

    if (currentUser && notesToUpdateInCloud.length > 0) {
      notesToUpdateInCloud.forEach((n) => {
        supabase.from("notes").update({ categories: n.categories || [] }).eq("id", n.id).then();
      });
    }

    // モーダルを閉じる
    setCategoryToDelete(null);
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
      handleAddCategory(trimmed);
      if (!editCategories.includes(trimmed)) {
        setEditCategories((prev) => [...prev, trimmed]);
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
          title: editTitleInput.trim() || undefined,
          categories: editCategories.length > 0 ? editCategories : undefined,
        };
      }
      return n;
    });

    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

    // Supabaseに反映
    if (currentUser) {
      supabase
        .from("notes")
        .update({
          title: editTitleInput.trim() || null,
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
    if (!content.trim()) return;

    const newNote: Note = {
      id: crypto.randomUUID(),
      title: title.trim() || undefined,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      isTrash: false,
      categories: selectedCategories.length > 0 ? selectedCategories : undefined,
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
  };

  // ゴミ箱へ移動する処理（※データは消さず、isTrashをtrueにするだけ）
  const handleMoveToTrash = (id: string) => {
    const updatedNotes = notes.map((note) =>
      note.id === id ? { ...note, isTrash: true } : note
    );
    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

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
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

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
    if (!replyContent.trim()) return;
    const newReply: NoteReply = {
      id: crypto.randomUUID(),
      content: replyContent.trim(),
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
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

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
    try {
      const textToCopy = note.title ? `【${note.title}】\n${note.content}` : note.content;
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
    const trimmed = editContentInput.trim();
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
    localStorage.setItem("seednote_items", JSON.stringify(newNotes));
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

  // 通常一覧の対象メモ（ゴミ箱も含めるフラグがONなら全体、OFFなら通常メモのみ）
  const baseNotesForList = includeTrashInSearch ? notes : activeNotes;

  // 検索・絞り込み適用後のメモ一覧（複数AND検索＆キーワード検索＆日付検索対応）
  const displayedNotes = baseNotesForList.filter((note) => {
    if (filterOnlyFavorite && !note.isFavorite) return false;
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
          type="button"
          onClick={() => setIsMenuOpen(true)}
          className={`${
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
        </button>

        {/* 中央：書く / 見る クイックアクセス切り替え（カプセル型） */}
        <div
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
              <h2 className="font-bold text-base flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                <span>💡</span> ライトNote
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
            SeedNote v0.2
          </div>
        </div>
      </aside>

      {/* メイン画面コンテンツ（タブによって切り替え） */}
      <main className="max-w-xl w-full mx-auto flex-1 flex flex-col justify-center py-3 sm:py-5 min-h-0">
        {/* ① ホーム（メモ入力：ノイズゼロのメイン空間） */}
        {activeTab === "home" && (
          <div
            className="relative rounded-2xl p-6 sm:p-8 shadow-sm border transition-all"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
          >
            {/* 本文に文字が入った時だけ現れるタイトル欄 */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-out ${
                hasContent ? "max-h-16 opacity-100 mb-3" : "max-h-0 opacity-0 mb-0 pointer-events-none"
              }`}
            >
              <input
                type="text"
                placeholder="タイトル（省略可）"
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
            </div>

            {/* 本文入力欄（文字はゼロ、薄い鉛筆マークのみ） */}
            <div className="relative min-h-[160px]">
              {!content && (
                <div
                  className="absolute top-2 left-2 pointer-events-none select-none text-2xl sm:text-3xl transition-opacity opacity-40"
                  style={{ color: activeTheme.textSecondary }}
                >
                  ✏️
                </div>
              )}
              <textarea
                rows={6}
                placeholder=""
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                className={`w-full ${
                  fontSize === "large" ? "text-lg sm:text-xl" : "text-base"
                } bg-transparent border-0 focus:outline-none resize-none leading-relaxed relative z-10`}
                style={{
                  color: activeTheme.textPrimary,
                  fontFamily: getNoteFontFamilyStyle(noteFont),
                }}
              />
            </div>

            {/* 本文に文字が入った時だけ現れる下部エリア（左：カテゴリ選択、右：保存ボタン） */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-out border-t pt-3 mt-1 ${
                hasContent ? "max-h-60 opacity-100" : "max-h-0 opacity-0 pointer-events-none pt-0 mt-0 border-t-0"
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
                    const isSelected = selectedCategories.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => handleToggleCategory(cat)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                          isSelected ? "shadow-xs font-bold" : "border"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgSub,
                          borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {cat}
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
                    className={`${
                      buttonSize === "large" ? "px-7 py-2.5 text-base" : "px-6 py-2 text-sm"
                    } rounded-xl font-bold transition-all shadow-sm`}
                    style={{ backgroundColor: activeTheme.accent, color: activeTheme.accentText }}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ② メモを見る（通常一覧：Twitter風のすっきり二層表示） */}
        {activeTab === "list" && (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <div className="flex items-center justify-between mb-3 pb-2 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <h2
                className={`${
                  fontSize === "large" ? "text-xl" : "text-lg"
                } font-bold`}
                style={{ color: activeTheme.textPrimary }}
              >
                メモ一覧 ({activeNotes.length}件)
              </h2>
            </div>

            {/* スクロール領域（検索バーとメモが一緒に流れるため、下スクロールでメモが画面いっぱいに広がる） */}
            <div className="flex-1 overflow-y-auto pr-1 pb-16 flex flex-col">
              {/* 検索・絞り込み機能エリア（スケッチの実装） */}
              {!isSearchPanelOpen ? (
                <div className="mb-3 flex items-center justify-between shrink-0">
                  <button
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
                            const isSelected = filterCategories.includes(cat);
                            return (
                              <button
                                key={cat}
                                type="button"
                                onClick={() =>
                                  setFilterCategories((prev) => {
                                    const withoutUncategorized = prev.filter((c) => c !== "uncategorized");
                                    return isSelected
                                      ? withoutUncategorized.filter((c) => c !== cat)
                                      : [...withoutUncategorized, cat];
                                  })
                                }
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                                  isSelected
                                    ? "bg-[#3d3731] text-white shadow-xs font-bold"
                                    : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                                }`}
                              >
                                {cat}
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
                                const yest = new Date(Date.now() - 86400000);
                                setCalendarYear(yest.getFullYear());
                                setCalendarMonth(yest.getMonth() + 1);
                                const yesterday = yest.toLocaleDateString("sv-SE");
                                setFilterDate(filterDate === yesterday ? "" : yesterday);
                              }}
                              className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                                filterDate === new Date(Date.now() - 86400000).toLocaleDateString("sv-SE")
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
                  {(filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 || Boolean(filterDate)) && (
                    <div className="text-[11px] text-[#8a7f72] pt-1 border-t border-[#f4f0e8] flex items-center justify-between">
                      <span>該当するメモ: {displayedNotes.length}件</span>
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
                        className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium"
                      >
                        条件をリセット
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* メモ一覧カードリスト */}
              <div className="flex flex-col gap-3">
              {!isLoaded ? (
                <div className="text-center py-8 text-sm text-[#b0a598]">
                  読み込み中...
                </div>
              ) : activeNotes.length === 0 ? (
                <div className="text-center py-10 text-sm text-[#8a7f72]">
                  まだメモがありません。ホームから思いつきを書いてみましょう。
                </div>
              ) : displayedNotes.length === 0 ? (
                <div className="text-center py-10 text-xs text-[#8a7f72] bg-white/50 rounded-xl border border-dashed border-[#ded6c9] p-4">
                  条件に一致するメモが見つかりませんでした。<br />
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
                    className="mt-2 text-xs text-[#3d3731] font-bold underline hover:text-black"
                  >
                    条件をリセットして全件表示
                  </button>
                </div>
              ) : (
                displayedNotes.map((note) => {
                  const isMenuThisNoteOpen = activeMenuNoteId === note.id;

                  return (
                    <article
                      key={note.id}
                      className={`p-4 rounded-xl shadow-2xs relative transition-colors border ${
                        note.isTrash ? "border-dashed opacity-90" : ""
                      }`}
                      style={{
                        backgroundColor: note.isTrash ? activeTheme.bgSub : activeTheme.bgCard,
                        borderColor: activeTheme.border,
                        color: activeTheme.textPrimary,
                      }}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap pr-2">
                          <h3
                            className={`font-bold ${
                              fontSize === "large" ? "text-base" : "text-sm"
                            }`}
                            style={{ color: activeTheme.textPrimary }}
                          >
                            {note.title || (
                              <span className="font-normal italic" style={{ color: activeTheme.textSecondary }}>
                                （無題）
                              </span>
                            )}
                          </h3>
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
                            onClick={() => handleCopyNote(note)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg text-xs leading-none transition-colors hover:opacity-80"
                            style={{ color: activeTheme.textSecondary }}
                            aria-label="メモをクリップボードにコピー"
                            title="メモをコピー"
                          >
                            <CopyIcon className="w-3.5 h-3.5" />
                          </button>

                          {/* お気に入りボタン */}
                          <button
                            type="button"
                            onClick={() => handleToggleFavorite(note.id)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none transition-colors hover:opacity-80"
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
                                  handleCopyNote(note);
                                  setActiveMenuNoteId(null);
                                }}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors hover:opacity-80`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <CopyIcon className="w-3.5 h-3.5 shrink-0" /> 本文をコピー
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenContentEditModal(note)}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors hover:opacity-80`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>✏️</span> 本文を訂正する
                              </button>
                              <button
                                type="button"
                                onClick={() => handleOpenEditModal(note)}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors hover:opacity-80`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>🏷️</span> タイトル・カテゴリの変更
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setReplyingNoteId(note.id);
                                  setReplyContent("");
                                  setActiveMenuNoteId(null);
                                  setExpandedReplyNoteIds((prev) =>
                                    prev.includes(note.id) ? prev : [...prev, note.id]
                                  );
                                }}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } rounded-lg flex items-center gap-1.5 font-medium transition-colors hover:opacity-80`}
                                style={{ color: activeTheme.textPrimary }}
                              >
                                <span>💬</span> 追記する
                              </button>
                              <div className="my-0.5 border-t" style={{ borderColor: activeTheme.border }} />
                              <button
                                type="button"
                                onClick={() => handleMoveToTrash(note.id)}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } text-[#b85448] hover:bg-[#fdf2f0] rounded-lg flex items-center gap-1.5 font-medium transition-colors`}
                              >
                                <span>🗑️</span> ゴミ箱へ移動
                              </button>
                            </div>
                          )}
                        </div>
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
                              🏷️ {cat}
                            </span>
                          ))}
                        </div>
                      )}

                      <p
                        className={`${
                          fontSize === "large" ? "text-base" : "text-sm"
                        } whitespace-pre-wrap leading-relaxed`}
                        style={{
                          color: activeTheme.textPrimary,
                          fontFamily: getNoteFontFamilyStyle(noteFont),
                        }}
                      >
                        {note.content}
                      </p>

                      {/* 訂正履歴表示（過去の文章をいつでも確認・振り返り可能） */}
                      {note.editHistory && note.editHistory.length > 0 && (
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
                                    className="line-through opacity-80 whitespace-pre-wrap leading-relaxed"
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
                      {note.replies && note.replies.length > 0 && (
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
                                    } whitespace-pre-wrap leading-relaxed`}
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
                          const isSelected = trashFilterCategories.includes(cat);
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() =>
                                setTrashFilterCategories((prev) => {
                                  const withoutUncategorized = prev.filter((c) => c !== "uncategorized");
                                  return isSelected
                                    ? withoutUncategorized.filter((c) => c !== cat)
                                    : [...withoutUncategorized, cat];
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
                              {cat}
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
              <div className="flex flex-col gap-3">
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
                displayedTrashNotes.map((note) => (
                  <article
                    key={note.id}
                    className="p-4 rounded-xl border opacity-90 transition-colors"
                    style={{
                      backgroundColor: activeTheme.bgCard,
                      borderColor: activeTheme.border,
                      color: activeTheme.textPrimary,
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <h3
                        className={`font-bold ${
                          fontSize === "large" ? "text-base" : "text-sm"
                        }`}
                        style={{ color: activeTheme.textPrimary }}
                      >
                        {note.title || <span className="opacity-50 font-normal italic">（無題）</span>}
                      </h3>
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
                            🏷️ {cat}
                          </span>
                        ))}
                      </div>
                    )}

                    <p
                      className={`${
                        fontSize === "large" ? "text-base" : "text-sm"
                      } whitespace-pre-wrap leading-relaxed mb-2`}
                      style={{
                        color: activeTheme.textPrimary,
                        fontFamily: getNoteFontFamilyStyle(noteFont),
                      }}
                    >
                      {note.content}
                    </p>

                    {/* 訂正履歴表示（過去の文章をいつでも確認・振り返り可能） */}
                    {note.editHistory && note.editHistory.length > 0 && (
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
                                  className="line-through opacity-80 whitespace-pre-wrap leading-relaxed"
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
                    {note.replies && note.replies.length > 0 && (
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
                                  className="whitespace-pre-wrap leading-relaxed"
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
                ))
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
                  カテゴリ管理 ({categoriesList.length}件)
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
                新しいカテゴリを追加
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="カテゴリ名を入力..."
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
                登録済みカテゴリ ({categoriesList.length}件)
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
              {categoriesList.length === 0 ? (
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
                      (n) => !n.isTrash && n.categories && n.categories.includes(cat)
                    ).length;

                    return (
                      <div
                        key={cat}
                        className="flex items-center justify-between p-3 rounded-xl border transition-colors"
                        style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold" style={{ color: activeTheme.textPrimary }}>
                            🏷️ {cat}
                          </span>
                          <span className="text-[11px] font-mono" style={{ color: activeTheme.textSecondary }}>
                            ({count}件のメモ)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCategoryToDelete(cat)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:text-[#b85448] transition-colors text-xs font-bold hover:opacity-80"
                          style={{ color: activeTheme.textSecondary }}
                          title="カテゴリを消去"
                        >
                          ✕
                        </button>
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

              {/* アカウント・クラウド同期・復旧キー */}
              <div
                className="p-3.5 rounded-xl border flex flex-col gap-2.5 transition-colors"
                style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                    <span>🔐</span> クラウド同期・アカウント
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
                        <span>⚠️ <strong>SeedNote内にはメモせず</strong>、スクショや別メモ等に保存してください</span>
                      </div>
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
        SeedNote
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
                  <span>🌱</span> SeedNote ガイド・ヘルプ
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

            {/* アコーディオンリスト（全11項目：高さが縮んでも潰れずスクロールする） */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1.5 flex flex-col gap-2">
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
            </div>
          </div>
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
              「{categoryToDelete}」
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
                    const isSelected = editCategories.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => handleToggleEditCategory(cat)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                          isSelected ? "shadow-xs font-bold" : "hover:opacity-85"
                        }`}
                        style={{
                          backgroundColor: isSelected ? activeTheme.accent : activeTheme.bgCard,
                          borderColor: isSelected ? activeTheme.accent : activeTheme.border,
                          color: isSelected ? activeTheme.accentText : activeTheme.textSecondary,
                        }}
                      >
                        {cat}
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
          onClick={() => {
            setIsAuthModalOpen(false);
            setAuthError(null);
            setAuthSuccessMsg(null);
            setAuthPasswordConfirmInput("");
            setResetRecoveryKeyInput("");
            setShowPassword(false);
            setShowPasswordConfirm(false);
            setAuthMode("login");
          }}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full border shadow-2xl transition-all"
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
                onClick={() => {
                  setIsAuthModalOpen(false);
                  setAuthError(null);
                  setAuthSuccessMsg(null);
                  setAuthPasswordConfirmInput("");
                  setResetRecoveryKeyInput("");
                  setShowPassword(false);
                  setShowPasswordConfirm(false);
                  setAuthMode("login");
                }}
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
                  onClick={() => {
                    setAuthMode("login");
                    setAuthError(null);
                    setAuthSuccessMsg(null);
                    setAuthPasswordConfirmInput("");
                    setShowPassword(false);
                    setShowPasswordConfirm(false);
                  }}
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
                  onClick={() => {
                    setAuthMode("signup");
                    setAuthError(null);
                    setAuthSuccessMsg(null);
                    setAuthPasswordConfirmInput("");
                    setShowPassword(false);
                    setShowPasswordConfirm(false);
                  }}
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
                  onClick={() => {
                    setAuthMode("login");
                    setAuthError(null);
                    setAuthSuccessMsg(null);
                    setResetRecoveryKeyInput("");
                    setAuthPasswordInput("");
                    setAuthPasswordConfirmInput("");
                  }}
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
                  className="text-xs leading-relaxed p-2.5 rounded-xl border"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  登録時に保存した【復旧キー】を入力して、新しいパスワードを設定します。
                </p>

                {/* ユーザー名入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    ユーザー名（ID）
                  </label>
                  <input
                    type="text"
                    placeholder="登録時のユーザー名"
                    value={authUsernameInput}
                    onChange={(e) => setAuthUsernameInput(e.target.value)}
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
                    新しいパスワード（6文字以上）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="新しいパスワードを入力"
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
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    ユーザー名（ID）
                  </label>
                  <input
                    type="text"
                    placeholder="例: nickname"
                    value={authUsernameInput}
                    onChange={(e) => setAuthUsernameInput(e.target.value)}
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
                  {authMode === "signup" && (
                    <span
                      className="text-[10px] block mt-1"
                      style={{ color: activeTheme.textSecondary }}
                    >
                      ※半角英数字（a-z, 0-9）のみ使用できます
                    </span>
                  )}
                  {authMode === "signup" && authUsernameInput && !/^[a-zA-Z0-9_-]+$/.test(authUsernameInput) && (
                    <span className="text-[10px] text-[#b85448] font-bold block mt-0.5">
                      ⚠️ ユーザー名は半角英数字（a-z, 0-9）とハイフン・アンダースコアのみ使用できます
                    </span>
                  )}
                </div>

                {/* パスワード入力 */}
                <div>
                  <label
                    className="block text-xs font-bold mb-1"
                    style={{ color: activeTheme.textPrimary }}
                  >
                    パスワード（6文字以上）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="パスワードを入力"
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

                {/* プライバシー安心注釈 */}
                <div
                  className="p-2.5 rounded-lg border text-[11px] leading-relaxed"
                  style={{
                    backgroundColor: activeTheme.bgSub,
                    borderColor: activeTheme.border,
                    color: activeTheme.textSecondary,
                  }}
                >
                  🛡️ <strong>メールアドレスは不要です</strong>。個人情報は一切収集せず、IDとパスワードのみで安全に端末間同期を行います。
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
                      onClick={() => {
                        setAuthMode("reset");
                        setAuthError(null);
                        setAuthSuccessMsg(null);
                        setResetRecoveryKeyInput("");
                        setAuthPasswordInput("");
                        setAuthPasswordConfirmInput("");
                        setShowPassword(false);
                        setShowPasswordConfirm(false);
                      }}
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
            className="rounded-2xl p-6 sm:p-7 max-w-sm w-full border shadow-2xl transition-all flex flex-col gap-4 text-center"
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
                万が一パスワードを忘れたときの【復旧キー】です
              </span>
            </div>

            {/* 復旧キー枠 */}
            <div
              className="p-3.5 rounded-xl border-2 shadow-xs flex flex-col items-center gap-2"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.accent,
              }}
            >
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
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(newlyRegisteredKey);
                  setCopiedKeyToast(true);
                  setTimeout(() => setCopiedKeyToast(false), 2000);
                }}
                className="px-3.5 py-1 text-xs font-bold rounded-lg border transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer hover:opacity-85"
                style={{
                  backgroundColor: activeTheme.bgCard,
                  borderColor: activeTheme.border,
                  color: activeTheme.textPrimary,
                }}
              >
                <span>📋</span> {copiedKeyToast ? "コピーしました！" : "キーをコピー"}
              </button>
            </div>

            {/* 3大注意点 */}
            <div
              className="border rounded-xl p-3 text-left flex flex-col gap-1.5 text-xs leading-relaxed"
              style={{
                backgroundColor: activeTheme.bgSub,
                borderColor: activeTheme.border,
                color: activeTheme.textSecondary,
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
                <li><strong>ライトNoteの中にメモしないでください</strong>（ログインできないと見られなくなります）。</li>
                <li><strong>スクリーンショットを撮る</strong>か、別の安全な場所に大切に保管してください。</li>
              </ol>
            </div>

            {/* 完了ボタン */}
            <button
              type="button"
              onClick={() => {
                setNewlyRegisteredKey(null);
                setCopiedKeyToast(false);
              }}
              className="w-full py-2.5 rounded-xl text-sm font-bold active:scale-[0.99] transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer hover:opacity-85"
              style={{
                backgroundColor: activeTheme.accent,
                color: activeTheme.accentText,
              }}
            >
              <span>📸</span> スクショを保存したので始める
            </button>
          </div>
        </div>
      )}

      {/* ⑧ 利用規約・プライバシーポリシーモーダル */}
      {isTermsOpen && (
        <div
          className="fixed inset-0 bg-black/45 backdrop-blur-xs z-60 flex items-center justify-center p-4"
          onClick={() => setIsTermsOpen(false)}
        >
          <div
            className="rounded-2xl p-6 sm:p-7 max-w-md w-full border shadow-2xl transition-all max-h-[88vh] flex flex-col"
            style={{ backgroundColor: activeTheme.bgCard, borderColor: activeTheme.border }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between pb-3 mb-3 border-b shrink-0" style={{ borderColor: activeTheme.border }}>
              <div>
                <h2 className="text-base font-bold flex items-center gap-1.5" style={{ color: activeTheme.textPrimary }}>
                  <span>📜</span> 利用規約・プライバシー
                </h2>
                <span className="text-[11px]" style={{ color: activeTheme.textSecondary }}>
                  ライトNoteをご利用いただく上での重要事項
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

            {/* 本文スクロールエリア */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-4 text-xs leading-relaxed" style={{ color: activeTheme.textPrimary }}>
              {/* 1. 基本思想と不可逆性 */}
              <section className="space-y-1">
                <h3 className="font-bold text-xs flex items-center gap-1" style={{ color: activeTheme.accent }}>
                  <span>🌱</span> 1. 基本思想と不可逆性（編集・削除について）
                </h3>
                <p className="text-[11px] leading-relaxed">
                  ライトNoteは「書くこと」よりも「後から思い出すこと（再発見）」を最優先にした、自分専用の思考アーカイブです。
                </p>
                <p className="text-[11px] leading-relaxed">
                  過去の思考の残骸や間違いも未来のアイデアの種となるため、<strong>メモの完全削除や本文の直接上書き編集はできない設計</strong>になっています。
                  書き足したい時は「追記」、誤字脱字を直したい時は過去の記録も残る「本文訂正（履歴付き）」をご利用ください。
                </p>
              </section>

              {/* 2. プライバシーとデータの保護 */}
              <section className="space-y-1">
                <h3 className="font-bold text-xs flex items-center gap-1" style={{ color: activeTheme.accent }}>
                  <span>🔒</span> 2. プライバシーとデータ保護
                </h3>
                <p className="text-[11px] leading-relaxed">
                  ライトNoteに記録されたすべてのメモ・追記・設定は、<strong>あなただけの完全なプライベートデータ</strong>です。
                  SNSのように他人に公開されることは一切ありません。
                </p>
                <p className="text-[11px] leading-relaxed">
                  クラウド同期をご利用の場合も、データベースの行レベルセキュリティ（RLS）によって厳格に保護され、他の利用者があなたのメモを閲覧することはできません。
                </p>
              </section>

              {/* 3. 復旧キーに関する最重要事項 */}
              <section className="space-y-1.5 p-3 rounded-xl border" style={{ backgroundColor: activeTheme.bgSub, borderColor: activeTheme.border }}>
                <h3 className="font-bold text-xs text-[#b85448] flex items-center gap-1">
                  <span>⚠️</span> 3. 【最重要】パスワード復旧キーの管理について
                </h3>
                <p className="text-[11px] font-bold leading-relaxed text-[#b85448]">
                  ライトNoteはメールアドレスを収集しない安心設計のため、パスワード再設定にはアカウント作成時に発行される「復旧キー（SEED-XXXX-XXXX）」が唯一の手段となります。
                </p>
                <ul className="list-disc pl-4 space-y-1 text-[11px]">
                  <li>
                    <strong>復旧キーは絶対にライトNote内にメモしないでください。</strong>（ログインできなくなった際に見られなくなります）
                  </li>
                  <li>
                    必ず<strong>スクリーンショットを撮影して保存する</strong>か、別の安全なメモ帳などに保管してください。
                  </li>
                  <li>
                    <strong>復旧キーとパスワードの両方を紛失された場合、セキュリティの観点から開発者・管理者であってもパスワードの再設定やアカウントの復旧は一切行えません。</strong>あらかじめご了承ください。
                  </li>
                </ul>
              </section>

              {/* 4. 完全無料の永続提供 */}
              <section className="space-y-1">
                <h3 className="font-bold text-xs flex items-center gap-1" style={{ color: activeTheme.accent }}>
                  <span>🎁</span> 4. 完全無料での運用
                </h3>
                <p className="text-[11px] leading-relaxed">
                  本アプリは画像添付などの大容量データをあえて扱わず、テキスト思考に特化した超軽量設計を採用しています。
                  そのため、将来にわたって有料化することなく、完全無料の範囲で安心して永続的にご利用いただけます。
                </p>
              </section>
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
    </div>
  );
}
