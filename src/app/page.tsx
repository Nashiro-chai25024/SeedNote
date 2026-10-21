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
});

// NoteオブジェクトからDB行へのマッピング
const mapNoteToDbRow = (note: Note, userId: string): DbNoteRow => ({
  id: note.id,
  user_id: userId,
  title: note.title || null,
  content: note.content,
  created_at: note.createdAt,
  is_trash: Boolean(note.isTrash),
  is_favorite: Boolean(note.isFavorite),
  categories: note.categories || [],
  replies: note.replies || [],
});

type TabType = "home" | "list" | "categories" | "trash" | "settings";
type FontSize = "normal" | "large";
type ButtonSize = "normal" | "large";
type CategorySortOrder = "usage" | "alphabetical" | "created";

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
            SeedNoteでは、過去の思考をありのまま残すため、<strong>本文の編集や削除はできない</strong>仕組みになっています（続きを書き足したい時は「追記」をご利用ください）。
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
  const [enableToast, setEnableToast] = useState(true);
  const [fontSize, setFontSize] = useState<FontSize>("normal");
  const [buttonSize, setButtonSize] = useState<ButtonSize>("normal");

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

  // 検索・絞り込みパネルとお気に入りのState
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [filterOnlyFavorite, setFilterOnlyFavorite] = useState(false);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [includeTrashInSearch, setIncludeTrashInSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTimeSlots, setFilterTimeSlots] = useState<TimeSlotKey[]>([]);
  const [categorySortOrder, setCategorySortOrder] = useState<CategorySortOrder>("usage");

  // 検索パネル内の折りたたみアコーディオンState
  const [isSearchCategoryOpen, setIsSearchCategoryOpen] = useState(true);
  const [isSearchTimeSlotOpen, setIsSearchTimeSlotOpen] = useState(false);

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

  // 設定の最新値を保持するRef（非同期・クロージャの古い値を参照しないため）
  const latestSettingsRef = useRef({
    categoriesList,
    timeSlots,
    fontSize,
    buttonSize,
    enableToast,
    confirmDiscardOnEdit,
  });

  useEffect(() => {
    latestSettingsRef.current = {
      categoriesList,
      timeSlots,
      fontSize,
      buttonSize,
      enableToast,
      confirmDiscardOnEdit,
    };
  }, [categoriesList, timeSlots, fontSize, buttonSize, enableToast, confirmDiscardOnEdit]);

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

        // ローカルにしか存在しないメモがあれば、クラウドにアップロード（引き継ぎ）
        const localOnlyNotes = baseLocalNotes.filter(
          (loc) => !cloudNotes.some((c) => c.id === loc.id)
        );

        let finalNotes = cloudNotes;

        if (localOnlyNotes.length > 0) {
          const rowsToInsert = localOnlyNotes.map((n) => mapNoteToDbRow(n, userId));
          const { error: insertErr } = await supabase.from("notes").insert(rowsToInsert);
          if (!insertErr) {
            finalNotes = [...cloudNotes, ...localOnlyNotes].sort(
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
      return { backgroundColor: "#e8e1d5" };
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

  const hasContent = content.trim().length > 0;
  const activeNotes = notes.filter((n) => !n.isTrash);
  const trashNotes = notes.filter((n) => n.isTrash);

  // 通常一覧の対象メモ（ゴミ箱も含めるフラグがONなら全体、OFFなら通常メモのみ）
  const baseNotesForList = includeTrashInSearch ? notes : activeNotes;

  // 検索・絞り込み適用後のメモ一覧（複数AND検索＆キーワード検索対応）
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
    <div className="min-h-screen bg-[#e8e2d5] text-[#2d2926] font-sans flex flex-col justify-between p-4 sm:p-8 relative overflow-x-hidden">
      {/* メニューが開いている時に画面のどこを触っても確実に閉じる透明な膜 */}
      {activeMenuNoteId && (
        <div
          className="fixed inset-0 z-20 cursor-default"
          onClick={() => setActiveMenuNoteId(null)}
        />
      )}

      {/* 保存通知トースト（画面下部の中央に表示し、ヘッダーのボタンと重ならないようにする） */}
      <div
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 pointer-events-none ${
          showToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
        }`}
      >
        <div className="bg-[#3d3731] text-[#faf8f5] px-4 py-2 rounded-full text-xs font-medium shadow-lg flex items-center gap-1.5">
          <span>🌱</span> 保存しました
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
          } flex items-center justify-center rounded-xl text-[#6b6257] hover:bg-[#ded6c9] active:bg-[#d5ccbe] transition-all`}
          aria-label="メニューを開く"
        >
          <span className="leading-none">≡</span>
        </button>

        {/* 中央：書く / 見る クイックアクセス切り替え（カプセル型） */}
        <div className="flex items-center bg-[#ded5c8]/80 p-0.5 rounded-xl border border-[#d5cdc0]">
          <button
            type="button"
            onClick={() => setActiveTab("home")}
            className={`flex items-center gap-1 ${
              buttonSize === "large" ? "px-3.5 py-1.5 text-xs" : "px-3 py-1 text-xs"
            } rounded-lg font-bold transition-all ${
              activeTab === "home"
                ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                : "text-[#6b6257] hover:text-[#3d3731]"
            }`}
            aria-label="メモを書く画面へ"
          >
            <span>✏️</span> 書く
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("list")}
            className={`flex items-center gap-1 ${
              buttonSize === "large" ? "px-3.5 py-1.5 text-xs" : "px-3 py-1 text-xs"
            } rounded-lg font-bold transition-all ${
              activeTab === "list"
                ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                : "text-[#6b6257] hover:text-[#3d3731]"
            }`}
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
          } flex items-center justify-center rounded-full font-bold border border-[#b8aea2] text-[#6b6257] hover:bg-[#ded6c9] transition-all`}
          aria-label="ガイド・ヘルプを開く"
        >
          ?
        </button>
      </header>

      {/* スライドメニュー（ドロワー） & 背景の暗幕 */}
      {isMenuOpen && (
        <div
          className="fixed inset-0 bg-black/35 backdrop-blur-[1px] z-40 transition-opacity"
          onClick={() => setIsMenuOpen(false)}
        />
      )}
      <aside
        className={`fixed top-0 left-0 bottom-0 w-64 bg-[#f4f0e8] z-50 shadow-xl border-r border-[#ded6c9] flex flex-col justify-between p-6 transition-transform duration-300 ease-out ${
          isMenuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div>
          <div className="flex items-center justify-between mb-6 pb-3 border-b border-[#ded6c9]">
            <div>
              <h2 className="font-bold text-base text-[#3d3731] flex items-center gap-1.5">
                <span>🌱</span> SeedNote
              </h2>
              <span className="text-[11px] text-[#8a7f72]">メニュー</span>
            </div>
            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              className={`${
                buttonSize === "large" ? "p-2 text-sm" : "px-2 py-1 text-xs"
              } text-[#8a7f72] hover:text-[#3d3731]`}
            >
              ✕
            </button>
          </div>

          {/* クラウド同期・アカウント状態 */}
          <div className="mb-5 p-3 rounded-xl bg-white/70 border border-[#ded6c9] shadow-2xs">
            {currentUser ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-[#529961] shrink-0" />
                    <span className="text-xs font-bold text-[#3d3731] truncate">
                      {currentUsername || "ログイン中"}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#529961] bg-[#eef6f0] px-1.5 py-0.5 rounded font-medium shrink-0">
                    同期中
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pt-1 border-t border-[#ede7dd]">
                  <button
                    type="button"
                    onClick={() => {
                      if (currentUser) fetchCloudNotes(currentUser.id);
                    }}
                    disabled={isSyncing}
                    className="flex-1 py-1 px-2 rounded-lg bg-[#f4f0e8] hover:bg-[#eae3d7] text-[11px] font-medium text-[#5c5348] transition-colors flex items-center justify-center gap-1"
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
                  <span className="text-xs font-bold text-[#3d3731] flex items-center gap-1.5">
                    <span>🔐</span> クラウド同期
                  </span>
                  <span className="text-[10px] text-[#8a7f72] group-hover:text-[#3d3731]">
                    ログイン ›
                  </span>
                </div>
                <p className="text-[11px] text-[#8a7f72] mt-0.5 leading-snug">
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
              } rounded-xl font-medium transition-colors text-left ${
                activeTab === "home"
                  ? "bg-[#e8e0d3] text-[#2d2926]"
                  : "text-[#5c5348] hover:bg-[#eae3d7]"
              }`}
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
              } rounded-xl font-medium transition-colors text-left ${
                activeTab === "list"
                  ? "bg-[#e8e0d3] text-[#2d2926]"
                  : "text-[#5c5348] hover:bg-[#eae3d7]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span>📋</span> メモを見る
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[#ded6c9] text-[#5c5348]">
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
              } rounded-xl font-medium transition-colors text-left ${
                activeTab === "categories"
                  ? "bg-[#e8e0d3] text-[#2d2926]"
                  : "text-[#5c5348] hover:bg-[#eae3d7]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span>🏷️</span> カテゴリ管理
              </div>
              {categoriesList.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-[#ded6c9] text-[#5c5348]">
                  {categoriesList.length}
                </span>
              )}
            </button>

            <div className="my-2 border-t border-[#ded6c9]" />

            <button
              type="button"
              onClick={() => {
                setActiveTab("trash");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left ${
                activeTab === "trash"
                  ? "bg-[#e8e0d3] text-[#2d2926]"
                  : "text-[#5c5348] hover:bg-[#eae3d7]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span>🗑️</span> ゴミ箱
              </div>
              {trashNotes.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-[#ded6c9] text-[#5c5348]">
                  {trashNotes.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab("settings");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center gap-3 ${
                buttonSize === "large" ? "px-4 py-3 text-base" : "px-3.5 py-2.5 text-sm"
              } rounded-xl font-medium transition-colors text-left ${
                activeTab === "settings"
                  ? "bg-[#e8e0d3] text-[#2d2926]"
                  : "text-[#5c5348] hover:bg-[#eae3d7]"
              }`}
            >
              <span>⚙️</span> 設定
            </button>
          </nav>
        </div>

        <div className="text-[11px] text-[#9c9184] text-center pt-4 border-t border-[#ded6c9]">
          SeedNote v0.2
        </div>
      </aside>

      {/* メイン画面コンテンツ（タブによって切り替え） */}
      <main className="max-w-xl w-full mx-auto flex-1 flex flex-col justify-center py-3 sm:py-5 min-h-0">
        {/* ① ホーム（メモ入力：ノイズゼロのメイン空間） */}
        {activeTab === "home" && (
          <div className="relative bg-[#f2efe9] rounded-2xl p-6 sm:p-8 shadow-sm border border-[#d5cdc0] transition-all">
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
                } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]`}
              />
            </div>

            {/* 本文入力欄（文字はゼロ、薄い鉛筆マークのみ） */}
            <div className="relative min-h-[160px]">
              {!content && (
                <div className="absolute top-2 left-2 pointer-events-none text-[#9e9386] opacity-35 select-none text-2xl sm:text-3xl transition-opacity">
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
                } bg-transparent border-0 focus:outline-none resize-none text-[#2d2926] leading-relaxed relative z-10`}
              />
            </div>

            {/* 本文に文字が入った時だけ現れる下部エリア（左：カテゴリ選択、右：保存ボタン） */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-out border-t border-[#ded5c8]/50 pt-3 mt-1 ${
                hasContent ? "max-h-60 opacity-100" : "max-h-0 opacity-0 pointer-events-none pt-0 mt-0 border-t-0"
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                {/* カテゴリ選択エリア */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs flex-1">
                  <span className="text-[#8a7f72] flex items-center gap-1 text-[11px] font-medium mr-0.5 select-none">
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
                          isSelected
                            ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                            : "bg-[#e8e0d3] text-[#5c5348] hover:bg-[#ded6c9]"
                        }`}
                      >
                        {cat}
                      </button>
                    );
                  })}

                  {/* インライン新規追加フォーム or 「＋ 新規」ボタン */}
                  {isAddingCategoryInline ? (
                    <div className="flex items-center gap-1 bg-white p-0.5 rounded-lg border border-[#ded5c8]">
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
                        className="px-2 py-0.5 text-xs text-[#2d2926] bg-transparent focus:outline-none w-28"
                      />
                      <button
                        type="button"
                        onClick={handleSaveInlineCategory}
                        className="px-2 py-0.5 rounded-md bg-[#3d3731] text-[#faf8f5] text-[11px] font-medium hover:bg-[#292420]"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddingCategoryInline(false);
                          setInlineNewCategoryName("");
                        }}
                        className="px-1 text-[11px] text-[#8a7f72] hover:text-[#3d3731]"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAddingCategoryInline(true)}
                      className="px-2.5 py-1 rounded-lg border border-dashed border-[#b8aea2] text-[#7d7367] hover:border-[#3d3731] hover:text-[#3d3731] transition-colors text-xs font-medium"
                    >
                      ＋ 新規
                    </button>
                  )}

                  {selectedCategories.length === 0 && !isAddingCategoryInline && (
                    <span className="text-[11px] text-[#a09485] select-none">
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
                    } rounded-xl font-medium bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] transition-all shadow-sm`}
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
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0] shrink-0">
              <h2
                className={`${
                  fontSize === "large" ? "text-xl" : "text-lg"
                } font-bold text-[#3d3731]`}
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
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                      filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0
                        ? "bg-[#d49e35] text-white shadow-xs hover:bg-[#c28e2d]"
                        : "bg-white border border-[#ded5c8] text-[#5c5348] hover:bg-[#faf8f5] shadow-2xs"
                    }`}
                  >
                    <span>🔍</span>
                    {filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0 ? (
                      <span>絞り込み中 ({displayedNotes.length}件)</span>
                    ) : (
                      <span>検索機能</span>
                    )}
                  </button>
                  {(filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilterOnlyFavorite(false);
                        setFilterCategories([]);
                        setIncludeTrashInSearch(false);
                        setSearchQuery("");
                        setFilterTimeSlots([]);
                      }}
                      className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium"
                    >
                      絞り込みを解除
                    </button>
                  )}
                </div>
              ) : (
                <div className="mb-3 p-3.5 bg-white rounded-xl border border-[#ded5c8] shadow-xs flex flex-col gap-3 transition-all shrink-0">
                  {/* パネル上部: タイトル & とじるボタン */}
                  <div className="flex items-center justify-between pb-2 border-b border-[#f0eae1]">
                    <span className="text-xs font-bold text-[#3d3731] flex items-center gap-1.5">
                      <span>🔍</span> 検索機能
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsSearchPanelOpen(false)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg border border-[#c4b9aa] text-xs text-[#5c5348] hover:text-[#3d3731] hover:border-[#8a7f72] transition-colors"
                    >
                      <span>✕</span> とじる
                    </button>
                  </div>

                  {/* ① キーワード検索入力欄 */}
                  <div>
                    <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
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
                        } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]`}
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2 text-xs text-[#9c9184] hover:text-[#3d3731] p-1 font-bold"
                          title="入力をクリア"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ② 絞り込みオプション（お気に入り & ゴミ箱） */}
                  <div>
                    <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
                      📌 絞り込みオプション
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setFilterOnlyFavorite(!filterOnlyFavorite)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                          filterOnlyFavorite
                            ? "bg-[#d49e35] text-white shadow-xs font-bold"
                            : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                        }`}
                      >
                        <span>{filterOnlyFavorite ? "★" : "☆"}</span>
                        {filterOnlyFavorite ? "お気に入りのみ表示中" : "お気に入りのみ"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setIncludeTrashInSearch(!includeTrashInSearch)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                          includeTrashInSearch
                            ? "bg-[#3d3731] text-white shadow-xs font-bold"
                            : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                        }`}
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



                  {/* ヒット件数 */}
                  {(filterOnlyFavorite || filterCategories.length > 0 || includeTrashInSearch || searchQuery.trim().length > 0 || filterTimeSlots.length > 0) && (
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
                      className={`p-4 rounded-xl shadow-2xs relative ${
                        note.isTrash
                          ? "bg-[#f5f1eb] border border-dashed border-[#c7bcac] opacity-90"
                          : "bg-white border border-[#e5ded2]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap pr-2">
                          <h3
                            className={`font-bold text-[#3d3731] ${
                              fontSize === "large" ? "text-base" : "text-sm"
                            }`}
                          >
                            {note.title || <span className="text-[#b0a598] font-normal italic">（無題）</span>}
                          </h3>
                          {note.isTrash && (
                            <span className="text-[10px] bg-[#eedcd8] text-[#a6483b] px-1.5 py-0.5 rounded font-medium border border-[#e0c0b8] shrink-0">
                              🗑️ ゴミ箱内
                            </span>
                          )}
                        </div>

                        {/* 右上：お気に入りボタン ＆ 控えめな「…」メニューまたは「元に戻す」ボタン */}
                        <div className="relative shrink-0 flex items-center gap-1.5">
                          {/* お気に入りボタン */}
                          <button
                            type="button"
                            onClick={() => handleToggleFavorite(note.id)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none transition-colors hover:bg-[#f4f0e8]"
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
                              } text-[#8a7f72] font-mono`}
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
                                } text-[#6b6257] hover:text-[#2d2926] bg-[#eae3d7] hover:bg-[#ded5c8] rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0`}
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
                                } flex items-center justify-center rounded-lg text-[#9c9184] hover:text-[#3d3731] hover:bg-[#f4f0e8] leading-none font-bold transition-colors`}
                                aria-label="操作メニュー"
                              >
                                …
                              </button>
                            )}
                          </div>

                          {/* タップした時だけ開くポップアップメニュー */}
                          {isMenuThisNoteOpen && (
                            <div className="absolute right-0 top-7 w-48 bg-white rounded-xl shadow-lg border border-[#e5ded2] p-1 z-30 transition-all flex flex-col gap-0.5">
                              <button
                                type="button"
                                onClick={() => handleOpenEditModal(note)}
                                className={`w-full text-left ${
                                  buttonSize === "large"
                                    ? "px-3 py-2 text-sm"
                                    : "px-2.5 py-1.5 text-xs"
                                } text-[#3d3731] hover:bg-[#f4f0e8] rounded-lg flex items-center gap-1.5 font-medium transition-colors`}
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
                                } text-[#3d3731] hover:bg-[#f4f0e8] rounded-lg flex items-center gap-1.5 font-medium transition-colors`}
                              >
                                <span>💬</span> 追記する
                              </button>
                              <div className="my-0.5 border-t border-[#f0eae1]" />
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
                              className="text-[10px] bg-[#eae3d7] text-[#6b6257] px-2 py-0.5 rounded-md font-medium border border-[#ded6c9]"
                            >
                              🏷️ {cat}
                            </span>
                          ))}
                        </div>
                      )}

                      <p
                        className={`${
                          fontSize === "large" ? "text-base" : "text-sm"
                        } text-[#453f38] whitespace-pre-wrap leading-relaxed`}
                      >
                        {note.content}
                      </p>

                      {/* 追記スレッド表示（デフォルトは折りたたみ） */}
                      {note.replies && note.replies.length > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-[#ede7de] flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleReplies(note.id)}
                            className="text-[11px] font-bold text-[#7d7367] hover:text-[#3d3731] flex items-center justify-between w-full text-left py-1 px-1.5 rounded-lg hover:bg-[#f4f0e8] transition-colors group cursor-pointer"
                          >
                            <span className="flex items-center gap-1.5">
                              <span>💬</span> 追記 ({note.replies.length}件)
                            </span>
                            <span className="text-[10px] text-[#9c9184] group-hover:text-[#3d3731] flex items-center gap-1 font-normal font-mono">
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
                            <div className="flex flex-col gap-2 pl-2.5 border-l-2 border-[#d5cdc0]">
                              {note.replies.map((reply) => (
                                <div
                                  key={reply.id}
                                  className="p-2.5 rounded-xl bg-[#faf8f5] border border-[#e8e2d5] shadow-3xs"
                                >
                                  <div className="flex justify-end mb-1">
                                    <time className="text-[10px] text-[#8a7f72] font-mono">
                                      {formatDate(reply.createdAt)}
                                    </time>
                                  </div>
                                  <p
                                    className={`${
                                      fontSize === "large" ? "text-sm" : "text-xs"
                                    } text-[#453f38] whitespace-pre-wrap leading-relaxed`}
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
                        <div className="mt-3 pt-2.5 border-t border-[#ede7de] flex flex-col gap-2">
                          <span className="text-[11px] font-bold text-[#3d3731] flex items-center gap-1">
                            <span>💬</span> このメモに追記する
                          </span>
                          <textarea
                            rows={3}
                            placeholder="追記を入力..."
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            className={`w-full ${
                              fontSize === "large" ? "text-sm p-3" : "text-xs p-2.5"
                            } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598] resize-none`}
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
                              } rounded-lg text-[#7d7367] hover:text-[#3d3731] hover:bg-[#eae3d7] font-medium transition-colors`}
                            >
                              キャンセル
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddReply(note.id)}
                              disabled={!replyContent.trim()}
                              className={`${
                                buttonSize === "large" ? "px-4 py-1.5 text-xs" : "px-3.5 py-1 text-[11px]"
                              } rounded-lg bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] disabled:opacity-40 font-medium transition-all shadow-2xs`}
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
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0] shrink-0">
              <div>
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold text-[#3d3731]`}
                >
                  ゴミ箱 ({trashNotes.length}件)
                </h2>
                <span className="text-[11px] text-[#8a7f72]">
                  ※データは安全に保持されています
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } text-[#7d7367] hover:text-[#3d3731] font-medium transition-colors`}
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
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                        trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0
                          ? "bg-[#d49e35] text-white shadow-xs hover:bg-[#c28e2d]"
                          : "bg-white border border-[#ded5c8] text-[#5c5348] hover:bg-[#faf8f5] shadow-2xs"
                      }`}
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
                        className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium"
                      >
                        絞り込みを解除
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="mb-3 p-3.5 bg-white rounded-xl border border-[#ded5c8] shadow-xs flex flex-col gap-3 transition-all shrink-0">
                  {/* パネル上部: タイトル & とじるボタン */}
                  <div className="flex items-center justify-between pb-2 border-b border-[#f0eae1]">
                    <span className="text-xs font-bold text-[#3d3731] flex items-center gap-1.5">
                      <span>🔍</span> ゴミ箱内の検索機能
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsTrashSearchPanelOpen(false)}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg border border-[#c4b9aa] text-xs text-[#5c5348] hover:text-[#3d3731] hover:border-[#8a7f72] transition-colors"
                    >
                      <span>✕</span> とじる
                    </button>
                  </div>

                  {/* ① キーワード検索入力欄 */}
                  <div>
                    <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
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
                        } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]`}
                      />
                      {trashSearchQuery && (
                        <button
                          type="button"
                          onClick={() => setTrashSearchQuery("")}
                          className="absolute right-2 text-xs text-[#9c9184] hover:text-[#3d3731] p-1 font-bold"
                          title="入力をクリア"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ② お気に入り表示 */}
                  <div>
                    <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
                      ⭐ お気に入り
                    </span>
                    <button
                      type="button"
                      onClick={() => setTrashFilterOnlyFavorite(!trashFilterOnlyFavorite)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                        trashFilterOnlyFavorite
                          ? "bg-[#d49e35] text-white shadow-xs font-bold"
                          : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                      }`}
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
                      <span className="text-[11px] font-bold text-[#8a7f72] flex items-center gap-1 group-hover:text-[#3d3731] transition-colors">
                        <span>{isTrashSearchCategoryOpen ? "▼" : "▶"}</span> 🏷️ カテゴリからさがす
                      </span>
                      {trashFilterCategories.includes("uncategorized") ? (
                        <span className="text-[10px] text-[#8a7f72] bg-[#f4f0e8] px-2 py-0.5 rounded-md">
                          ”未分類” のメモを表示中
                        </span>
                      ) : trashFilterCategories.length > 1 ? (
                        <span className="text-[10px] text-[#8a7f72] bg-[#f4f0e8] px-2 py-0.5 rounded-md">
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
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                            trashFilterCategories.length === 0
                              ? "bg-[#3d3731] text-white shadow-xs font-bold"
                              : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                          }`}
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
                    )}
                  </div>

                  {/* ヒット件数 */}
                  {(trashFilterOnlyFavorite || trashFilterCategories.length > 0 || trashSearchQuery.trim().length > 0) && (
                    <div className="text-[11px] text-[#8a7f72] pt-1 border-t border-[#f4f0e8] flex items-center justify-between">
                      <span>該当するメモ: {displayedTrashNotes.length}件</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTrashFilterOnlyFavorite(false);
                          setTrashFilterCategories([]);
                          setTrashSearchQuery("");
                        }}
                        className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline"
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
                <div className="text-center py-10 text-sm text-[#8a7f72]">
                  ゴミ箱は空です。
                </div>
              ) : displayedTrashNotes.length === 0 ? (
                <div className="text-center py-10 text-xs text-[#8a7f72] bg-white/50 rounded-xl border border-dashed border-[#ded6c9] p-4">
                  条件に一致するメモが見つかりませんでした。<br />
                  <button
                    type="button"
                    onClick={() => {
                      setTrashFilterOnlyFavorite(false);
                      setTrashFilterCategories([]);
                      setTrashSearchQuery("");
                    }}
                    className="mt-2 text-xs text-[#3d3731] font-bold underline hover:text-black"
                  >
                    条件をリセットして全件表示
                  </button>
                </div>
              ) : (
                displayedTrashNotes.map((note) => (
                  <article
                    key={note.id}
                    className="p-4 rounded-xl bg-white/70 border border-[#e5ded2] opacity-80"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <h3
                        className={`font-bold text-[#3d3731] ${
                          fontSize === "large" ? "text-base" : "text-sm"
                        }`}
                      >
                        {note.title || <span className="text-[#b0a598] font-normal italic">（無題）</span>}
                      </h3>
                      <time
                        className={`${
                          fontSize === "large" ? "text-xs" : "text-[11px]"
                        } text-[#8a7f72] shrink-0 font-mono`}
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
                            className="text-[10px] bg-[#eae3d7] text-[#6b6257] px-2 py-0.5 rounded-md font-medium border border-[#ded6c9]"
                          >
                            🏷️ {cat}
                          </span>
                        ))}
                      </div>
                    )}

                    <p
                      className={`${
                        fontSize === "large" ? "text-base" : "text-sm"
                      } text-[#5c5348] whitespace-pre-wrap leading-relaxed mb-2`}
                    >
                      {note.content}
                    </p>

                    {/* 追記スレッド表示（デフォルトは折りたたみ） */}
                    {note.replies && note.replies.length > 0 && (
                      <div className="mt-2 mb-3 pt-2 border-t border-[#ede7de] flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleReplies(note.id)}
                          className="text-[11px] font-bold text-[#7d7367] hover:text-[#3d3731] flex items-center justify-between w-full text-left py-1 px-1.5 rounded-lg hover:bg-[#f4f0e8] transition-colors group cursor-pointer"
                        >
                          <span className="flex items-center gap-1.5">
                            <span>💬</span> 追記 ({note.replies.length}件)
                          </span>
                          <span className="text-[10px] text-[#9c9184] group-hover:text-[#3d3731] flex items-center gap-1 font-normal font-mono">
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
                          <div className="flex flex-col gap-1.5 pl-2.5 border-l-2 border-[#d5cdc0]">
                            {note.replies.map((reply) => (
                              <div
                                key={reply.id}
                                className="p-2 rounded-lg bg-[#faf8f5]/80 border border-[#e8e2d5] text-xs"
                              >
                                <div className="flex justify-end mb-0.5">
                                  <time className="text-[10px] text-[#8a7f72] font-mono">
                                    {formatDate(reply.createdAt)}
                                  </time>
                                </div>
                                <p className="text-[#5c5348] whitespace-pre-wrap leading-relaxed">
                                  {reply.content}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex justify-end pt-2 border-t border-[#f4f0e8]">
                      <button
                        type="button"
                        onClick={() => handleRestoreFromTrash(note.id)}
                        className={`${
                          buttonSize === "large"
                            ? "text-sm px-4 py-2"
                            : "text-xs px-3 py-1"
                        } text-[#6b6257] hover:text-[#2d2926] bg-[#eae3d7] rounded-lg transition-colors flex items-center gap-1 font-medium`}
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
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0] shrink-0">
              <div>
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold text-[#3d3731]`}
                >
                  カテゴリ管理 ({categoriesList.length}件)
                </h2>
                <span className="text-[11px] text-[#8a7f72]">
                  メモを分類するカテゴリの作成・並び順設定ができます
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } text-[#7d7367] hover:text-[#3d3731] font-medium transition-colors`}
              >
                ← ホームへ
              </button>
            </div>

            {/* 新規カテゴリ作成フォーム */}
            <div className="mb-4 p-3.5 bg-white rounded-xl border border-[#e5ded2] shrink-0">
              <span className="block text-xs font-bold text-[#3d3731] mb-2">
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
                  } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]`}
                />
                <button
                  type="button"
                  onClick={handleCreateCategoryFromManagement}
                  className={`${
                    buttonSize === "large" ? "px-5 py-2 text-sm" : "px-4 py-1.5 text-xs"
                  } rounded-xl font-medium bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] transition-all shadow-xs shrink-0`}
                >
                  追加
                </button>
              </div>
            </div>

            {/* エリアの仕切り線 */}
            <div className="border-b border-[#ded5c8] mb-3 shrink-0" />

            {/* 登録済みカテゴリ一覧ヘッダー & 並び順切り替え */}
            <div className="flex items-center justify-between mb-2 shrink-0 flex-wrap gap-2">
              <span className="text-xs font-bold text-[#3d3731]">
                登録済みカテゴリ ({categoriesList.length}件)
              </span>
              <div className="flex items-center gap-1 bg-[#ede6da] p-0.5 rounded-lg border border-[#ded5c8]">
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("usage")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "usage"
                      ? "bg-[#3d3731] text-white shadow-2xs font-bold"
                      : "text-[#6b6257] hover:text-[#2d2926]"
                  }`}
                  title="メモ件数が多い順に並べる"
                >
                  🔥 よく使う順
                </button>
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("alphabetical")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "alphabetical"
                      ? "bg-[#3d3731] text-white shadow-2xs font-bold"
                      : "text-[#6b6257] hover:text-[#2d2926]"
                  }`}
                  title="あいうえお順に並べる"
                >
                  🔤 五十音順
                </button>
                <button
                  type="button"
                  onClick={() => handleCategorySortOrderChange("created")}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                    categorySortOrder === "created"
                      ? "bg-[#3d3731] text-white shadow-2xs font-bold"
                      : "text-[#6b6257] hover:text-[#2d2926]"
                  }`}
                  title="作成した順に並べる"
                >
                  🕒 登録順
                </button>
              </div>
            </div>

            {/* 登録済みカテゴリ一覧 */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 pb-12 flex flex-col gap-2">
              {categoriesList.length === 0 ? (
                <div className="text-center py-8 text-xs text-[#8a7f72] bg-white/60 rounded-xl border border-dashed border-[#ded6c9] p-4">
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
                        className="flex items-center justify-between p-3 bg-white rounded-xl border border-[#e5ded2] transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-[#3d3731]">
                            🏷️ {cat}
                          </span>
                          <span className="text-[11px] text-[#8a7f72] font-mono">
                            ({count}件のメモ)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCategoryToDelete(cat)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg text-[#9c9184] hover:text-[#b85448] hover:bg-[#fdf2f0] transition-colors text-xs font-bold"
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
          <div className="bg-[#f2efe9] rounded-2xl p-6 border border-[#d5cdc0] shadow-sm">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#ded5c8]">
              <h2
                className={`${
                  fontSize === "large" ? "text-xl" : "text-lg"
                } font-bold text-[#3d3731]`}
              >
                設定
              </h2>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className={`${
                  buttonSize === "large" ? "text-sm py-1 px-2" : "text-xs"
                } text-[#7d7367] hover:text-[#3d3731]`}
              >
                ← ホームへ
              </button>
            </div>

            <div className="flex flex-col gap-4 text-sm">
              {/* 文字の大きさ */}
              <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <div>
                  <span className="font-medium text-[#3d3731] block">文字の大きさ</span>
                  <span className="text-xs text-[#8a7f72]">メモの本文や入力欄の文字サイズ</span>
                </div>
                <div className="flex gap-1.5 bg-[#f4f0e8] p-1 rounded-lg border border-[#e5ded2]">
                  <button
                    type="button"
                    onClick={() => handleFontSizeChange("normal")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      fontSize === "normal"
                        ? "bg-[#3d3731] text-white shadow-xs"
                        : "text-[#6b6257] hover:text-[#2d2926]"
                    }`}
                  >
                    標準
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFontSizeChange("large")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      fontSize === "large"
                        ? "bg-[#3d3731] text-white shadow-xs"
                        : "text-[#6b6257] hover:text-[#2d2926]"
                    }`}
                  >
                    大きめ
                  </button>
                </div>
              </div>

              {/* ボタンの大きさ */}
              <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <div>
                  <span className="font-medium text-[#3d3731] block">ボタンの大きさ</span>
                  <span className="text-xs text-[#8a7f72]">メニューや保存ボタンなどの押しやすさ</span>
                </div>
                <div className="flex gap-1.5 bg-[#f4f0e8] p-1 rounded-lg border border-[#e5ded2]">
                  <button
                    type="button"
                    onClick={() => handleButtonSizeChange("normal")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      buttonSize === "normal"
                        ? "bg-[#3d3731] text-white shadow-xs"
                        : "text-[#6b6257] hover:text-[#2d2926]"
                    }`}
                  >
                    標準
                  </button>
                  <button
                    type="button"
                    onClick={() => handleButtonSizeChange("large")}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all ${
                      buttonSize === "large"
                        ? "bg-[#3d3731] text-white shadow-xs"
                        : "text-[#6b6257] hover:text-[#2d2926]"
                    }`}
                  >
                    大きめ
                  </button>
                </div>
              </div>

              {/* 保存通知 */}
              <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <div>
                  <span className="font-medium text-[#3d3731] block">保存通知</span>
                  <span className="text-xs text-[#8a7f72]">メモ保存時に「保存しました」を表示する</span>
                </div>
                <input
                  type="checkbox"
                  checked={enableToast}
                  onChange={(e) => handleToggleToast(e.target.checked)}
                  className="w-4 h-4 accent-[#3d3731] cursor-pointer"
                />
              </div>

              {/* 編集破棄の確認 */}
              <div className="flex items-center justify-between p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <div>
                  <span className="font-medium text-[#3d3731] block">編集破棄の確認</span>
                  <span className="text-xs text-[#8a7f72]">タイトルやカテゴリを変更中に保存せず閉じる際、確認ダイアログを表示する</span>
                </div>
                <input
                  type="checkbox"
                  checked={confirmDiscardOnEdit}
                  onChange={(e) => handleToggleConfirmDiscard(e.target.checked)}
                  className="w-4 h-4 accent-[#3d3731] cursor-pointer"
                />
              </div>

              {/* 時間帯の設定（アコーディオン形式で折りたたみ可能） */}
              <div className="bg-white rounded-xl border border-[#e5ded2] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setIsTimeSlotsAccordionOpen(!isTimeSlotsAccordionOpen)}
                  className="w-full p-4 flex items-center justify-between text-left hover:bg-[#faf8f5] transition-colors"
                >
                  <div>
                    <span className="font-bold text-[#3d3731] block">
                      ⏰ 時間帯の設定
                    </span>
                    <span className="text-xs text-[#8a7f72]">
                      {isTimeSlotsAccordionOpen
                        ? "バーの操作やボタンで、生活リズムに合わせて調整できます（重なりOK）"
                        : "生活リズムに合わせて調整（タップして設定を展開）"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!isTimeSlotsAccordionOpen && (
                      <span className="text-[11px] text-[#8a7f72] hidden sm:inline">
                        5つの時間帯
                      </span>
                    )}
                    <span
                      className={`text-xs text-[#8a7f72] transition-transform duration-200 ${
                        isTimeSlotsAccordionOpen ? "rotate-90" : ""
                      }`}
                    >
                      ▶
                    </span>
                  </div>
                </button>

                {isTimeSlotsAccordionOpen && (
                  <div className="p-4 pt-1 border-t border-[#f4f0e8]">
                    <div className="flex justify-end pt-1 mb-2">
                      <button
                        type="button"
                        onClick={handleResetTimeSlots}
                        className="text-xs text-[#8a7f72] hover:text-[#3d3731] bg-[#f4f0e8] hover:bg-[#eae3d7] px-2.5 py-1 rounded-lg transition-colors font-medium shrink-0"
                      >
                        標準に戻す
                      </button>
                    </div>

                    {/* ── 24時間タイムラインバー ── */}
                    <div className="my-4 p-3 bg-[#faf8f5] rounded-xl border border-[#ede7dd]">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold text-[#5c5348] flex items-center gap-1.5">
                          <span>📊 24時間タイムライン</span>
                          <span className="text-[10px] font-normal text-[#8a7f72]">
                            （タップで時間帯を選択・調整）
                          </span>
                        </span>
                        <span className="text-[11px] font-medium text-[#7d7367]">
                          調整中: <span className="font-bold text-[#3d3731]">{timeSlots[selectedSlotForEdit]?.icon} {timeSlots[selectedSlotForEdit]?.label}</span>
                        </span>
                      </div>

                      {/* タイムライン上部の目盛りラベル (0:00, 6:00, 12:00, 18:00, 24:00) */}
                      <div className="relative h-4 text-[10px] text-[#9c9184] font-mono select-none">
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
                        className="w-full h-9 rounded-lg overflow-hidden border border-[#d5cdc0] flex shadow-inner relative cursor-pointer"
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
                      <div className="mt-1 flex items-center justify-between text-[11px] text-[#7d7367]">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block w-4 h-3 rounded-xs border border-[#b8aea2]"
                            style={{
                              backgroundImage:
                                "repeating-linear-gradient(135deg, #529961, #529961 3px, #4a7bb0 3px, #4a7bb0 6px)",
                            }}
                          />
                          <span>斜線の区間＝複数時間帯の重複（重なりOK）</span>
                        </span>
                        <span className="text-[10px] text-[#8a7f72]">ピンを左右にドラッグして伸縮</span>
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
                              isSelected
                                ? "bg-[#faf8f5] border-[#3d3731] shadow-xs ring-1 ring-[#3d3731]"
                                : "bg-[#faf8f5]/60 hover:bg-[#faf8f5] border-[#ede7dd]"
                            }`}
                          >
                            {/* 上段：アイコン・名称・現在の範囲・重なりバッジ */}
                            <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs"
                                  style={{ backgroundColor: slot.color }}
                                />
                                <span className="text-base leading-none">{slot.icon}</span>
                                <span className="font-bold text-xs text-[#3d3731]">
                                  {slot.label}
                                </span>
                                <span className="font-mono text-xs font-semibold text-[#5c5348] bg-white px-2 py-0.5 rounded-md border border-[#e5ded2]">
                                  {slot.startHour}:00 〜 {slot.endHour}:59
                                  {slot.endHour < slot.startHour && (
                                    <span className="ml-1 text-[10px] text-[#8a7f72] font-normal">
                                      (翌日)
                                    </span>
                                  )}
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {overlaps.length > 0 && (
                                  <span className="text-[10px] bg-[#f0eade] text-[#6b6257] px-2 py-0.5 rounded-full border border-[#dcd4c6]">
                                    🔄 「{overlaps.join("・")}」と重なり
                                  </span>
                                )}
                                {isSelected && (
                                  <span className="text-[10px] bg-[#3d3731] text-white px-2 py-0.5 rounded-full font-medium">
                                    選択中
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* 下段：開始・終了時間の微調整（[-] / [+] ステッパー ＆ セレクト） */}
                            <div
                              className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-2 border-t border-[#ede7dd]"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* 開始時間 */}
                              <div className="flex items-center justify-between sm:justify-start gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-[#e5ded2]">
                                <span className="text-[#8a7f72] text-[11px] font-medium shrink-0">開始:</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "startHour", -1)}
                                    className="w-6 h-6 rounded flex items-center justify-center bg-[#f4f0e8] hover:bg-[#e8e0d3] active:bg-[#ded5c8] text-[#3d3731] font-bold text-xs transition-colors"
                                    title="1時間戻す"
                                  >
                                    －
                                  </button>
                                  <select
                                    value={slot.startHour}
                                    onChange={(e) =>
                                      handleUpdateTimeSlot(key, "startHour", Number(e.target.value))
                                    }
                                    className="bg-[#faf8f5] border border-[#ded5c8] rounded px-1.5 py-0.5 text-xs font-mono font-bold text-[#2d2926] focus:outline-none focus:border-[#968979]"
                                  >
                                    {Array.from({ length: 24 }, (_, i) => (
                                      <option key={i} value={i}>
                                        {i}:00
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "startHour", 1)}
                                    className="w-6 h-6 rounded flex items-center justify-center bg-[#f4f0e8] hover:bg-[#e8e0d3] active:bg-[#ded5c8] text-[#3d3731] font-bold text-xs transition-colors"
                                    title="1時間進める"
                                  >
                                    ＋
                                  </button>
                                </div>
                              </div>

                              {/* 終了時間 */}
                              <div className="flex items-center justify-between sm:justify-start gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-[#e5ded2]">
                                <span className="text-[#8a7f72] text-[11px] font-medium shrink-0">終了:</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "endHour", -1)}
                                    className="w-6 h-6 rounded flex items-center justify-center bg-[#f4f0e8] hover:bg-[#e8e0d3] active:bg-[#ded5c8] text-[#3d3731] font-bold text-xs transition-colors"
                                    title="1時間戻す"
                                  >
                                    －
                                  </button>
                                  <select
                                    value={slot.endHour}
                                    onChange={(e) =>
                                      handleUpdateTimeSlot(key, "endHour", Number(e.target.value))
                                    }
                                    className="bg-[#faf8f5] border border-[#ded5c8] rounded px-1.5 py-0.5 text-xs font-mono font-bold text-[#2d2926] focus:outline-none focus:border-[#968979]"
                                  >
                                    {Array.from({ length: 24 }, (_, i) => (
                                      <option key={i} value={i}>
                                        {i}:59
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleStepHour(key, "endHour", 1)}
                                    className="w-6 h-6 rounded flex items-center justify-center bg-[#f4f0e8] hover:bg-[#e8e0d3] active:bg-[#ded5c8] text-[#3d3731] font-bold text-xs transition-colors"
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
              <div className="p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <span className="font-medium text-[#3d3731] block mb-2">容量・メモ情報</span>
                <div className="text-xs text-[#7d7367] flex flex-col gap-1">
                  <div>通常メモ：{activeNotes.length} 件</div>
                  <div>ゴミ箱内：{trashNotes.length} 件</div>
                  <div>総データ数：{notes.length} 件</div>
                </div>
              </div>

              {/* アカウント・クラウド同期・復旧キー */}
              <div className="p-3.5 bg-white rounded-xl border border-[#e5ded2] flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#3d3731] flex items-center gap-1.5">
                    <span>🔐</span> クラウド同期・アカウント
                  </span>
                  {currentUser ? (
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="px-2.5 py-1 text-xs text-[#b85448] hover:text-[#9e3a2f] border border-[#e5ded2] rounded-lg transition-colors font-medium"
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
                      className="px-3 py-1 text-xs font-bold bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] rounded-lg transition-all shadow-2xs"
                    >
                      ログイン / 新規登録
                    </button>
                  )}
                </div>

                {currentUser ? (
                  <div className="flex flex-col gap-2.5 pt-1 border-t border-[#f0eae1]">
                    <div className="text-xs text-[#8a7f72] flex items-center justify-between">
                      <span>ログイン中のユーザー名:</span>
                      <strong className="text-[#3d3731] font-mono text-sm">{currentUsername}</strong>
                    </div>

                    {/* 復旧キー枠 */}
                    <div className="p-3 rounded-xl bg-[#faf8f5] border border-[#ded5c8] flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-[#6b6257]">
                          🔑 パスワード復旧キー
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowRecoveryKeyInSettings(!showRecoveryKeyInSettings)}
                          className="text-[11px] text-[#7d7367] hover:text-[#2d2926] underline font-medium"
                        >
                          {showRecoveryKeyInSettings ? "キーを隠す" : "キーを表示する"}
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-1.5 bg-white rounded-lg border border-[#ded5c8] text-xs font-mono font-bold tracking-wider text-[#3d3731] select-all">
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
                          className="px-3 py-1.5 bg-[#3d3731] text-white rounded-lg text-xs font-medium hover:bg-[#292420] transition-colors shrink-0 flex items-center gap-1 shadow-2xs cursor-pointer"
                        >
                          <span>📋</span> {copiedKeyToast ? "コピー完了!" : "コピー"}
                        </button>
                      </div>

                      <div className="text-[10px] text-[#8a7f72] leading-relaxed pt-1 border-t border-[#f0eae1] flex flex-col gap-0.5">
                        <span>⚠️ <strong>誰にも教えてはいけません</strong>（パスワード再設定用の重要キーです）</span>
                        <span>⚠️ <strong>SeedNote内にはメモせず</strong>、スクショや別メモ等に保存してください</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-[#8a7f72] leading-relaxed">
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
            className="bg-[#f4f0e8] rounded-2xl p-6 sm:p-7 max-w-lg w-full max-h-[85vh] flex flex-col border border-[#ded6c9] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘルプモーダルのヘッダー */}
            <div className="shrink-0 flex items-center justify-between pb-3 mb-3 border-b border-[#ded6c9]">
              <div>
                <h2 className="text-base font-bold text-[#3d3731] flex items-center gap-1.5">
                  <span>🌱</span> SeedNote ガイド・ヘルプ
                </h2>
                <span className="text-[11px] text-[#8a7f72]">
                  気になる項目をタップして詳細をご覧ください
                </span>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="w-7 h-7 rounded-full bg-[#e8e0d3] text-xs font-bold text-[#5c5348] hover:bg-[#ded6c9] transition-colors flex items-center justify-center shrink-0"
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
                    className="shrink-0 border border-[#ded6c9] rounded-xl bg-white overflow-hidden transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setOpenHelpSection(isOpen ? null : item.id)
                      }
                      className="w-full flex items-center justify-between p-3.5 text-left text-sm font-bold text-[#3d3731] hover:bg-[#faf8f5] transition-colors min-h-[48px]"
                    >
                      <span>{item.title}</span>
                      <span
                        className={`text-xs text-[#8a7f72] transition-transform duration-200 ${
                          isOpen ? "rotate-90" : ""
                        }`}
                      >
                        ▶
                      </span>
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-1 text-xs sm:text-sm text-[#453f38] leading-relaxed border-t border-[#f4f0e8] bg-[#faf8f5]/50">
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
            className="bg-[#f4f0e8] rounded-2xl p-6 sm:p-7 max-w-sm w-full border border-[#ded6c9] shadow-2xl transition-all"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-[#3d3731] mb-1">
              「{categoryToDelete}」
            </h3>
            <p className="text-sm font-bold text-[#2d2926] mb-3">
              本当にこのカテゴリを消去しますか？
            </p>
            <p className="text-xs text-[#786f66] leading-relaxed mb-6 bg-[#eae4d9] p-3 rounded-xl border border-[#ded6c9]">
              （※このカテゴリに分類されているメモは未分類、または他のカテゴリがついている場合は消去するカテゴリのみなくなります）
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setCategoryToDelete(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#6b6257] hover:bg-[#e8e0d3] transition-colors"
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
            className="bg-[#f4f0e8] rounded-2xl p-6 sm:p-7 max-w-md w-full border border-[#ded6c9] shadow-2xl transition-all max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* モーダルのヘッダー */}
            <div className="shrink-0 pb-3 mb-4 border-b border-[#ded6c9]">
              <h2 className="text-base font-bold text-[#3d3731] flex items-center gap-1.5">
                <span>🏷️</span> タイトル・カテゴリの変更
              </h2>
              <span className="text-[11px] text-[#8a7f72]">
                見出しやジャンルを整理できます（※本文は保護されます）
              </span>
            </div>

            {/* スクロール可能な編集エリア */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-4">
              {/* タイトル入力 */}
              <div>
                <label className="block text-xs font-bold text-[#3d3731] mb-1.5">
                  タイトル
                </label>
                <input
                  type="text"
                  placeholder="タイトルを入力（空欄なら無題）"
                  value={editTitleInput}
                  onChange={(e) => setEditTitleInput(e.target.value)}
                  className={`w-full ${
                    fontSize === "large" ? "px-4 py-2.5 text-base" : "px-3.5 py-2 text-sm"
                  } bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]`}
                />
              </div>

              {/* カテゴリ選択エリア */}
              <div>
                <label className="block text-xs font-bold text-[#3d3731] mb-1.5">
                  カテゴリ
                </label>
                <div className="flex flex-wrap items-center gap-1.5 p-2.5 bg-white/70 rounded-xl border border-[#ded5c8]">
                  {sortedCategories.map((cat) => {
                    const isSelected = editCategories.includes(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => handleToggleEditCategory(cat)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                          isSelected
                            ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                            : "bg-[#e8e0d3] text-[#5c5348] hover:bg-[#ded6c9]"
                        }`}
                      >
                        {cat}
                      </button>
                    );
                  })}

                  {/* モーダル内インライン新規作成 */}
                  {isAddingCategoryInEdit ? (
                    <div className="flex items-center gap-1 bg-white p-0.5 rounded-lg border border-[#ded5c8]">
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
                        className="px-2 py-0.5 text-xs text-[#2d2926] bg-transparent focus:outline-none w-24"
                      />
                      <button
                        type="button"
                        onClick={handleSaveCategoryInEdit}
                        className="px-2 py-0.5 rounded-md bg-[#3d3731] text-[#faf8f5] text-[11px] font-medium hover:bg-[#292420]"
                      >
                        追加
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddingCategoryInEdit(false);
                          setInlineNewCategoryInEdit("");
                        }}
                        className="px-1 text-[11px] text-[#8a7f72] hover:text-[#3d3731]"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAddingCategoryInEdit(true)}
                      className="px-2.5 py-1 rounded-lg border border-dashed border-[#b8aea2] text-[#7d7367] hover:border-[#3d3731] hover:text-[#3d3731] transition-colors text-xs font-medium"
                    >
                      ＋ 新規
                    </button>
                  )}

                  {editCategories.length === 0 && !isAddingCategoryInEdit && (
                    <span className="text-[11px] text-[#a09485] select-none ml-1">
                      （未選択＝未分類）
                    </span>
                  )}
                </div>
              </div>

              {/* 本文の確認プレビュー（編集不可・思考の不可逆性を保護） */}
              <div>
                <label className="block text-xs font-bold text-[#8a7f72] mb-1.5 flex items-center justify-between">
                  <span>本文（プレビュー）</span>
                  <span className="text-[10px] text-[#a09485] font-normal">※本文の編集はできません</span>
                </label>
                <div className="p-3.5 rounded-xl bg-white/50 border border-[#e5ded2] text-xs sm:text-sm text-[#5c5348] whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto select-text">
                  {editingNote.content}
                </div>
              </div>
            </div>

            {/* モーダルのフッターボタン */}
            <div className="shrink-0 flex justify-end gap-2.5 pt-4 mt-3 border-t border-[#ded6c9]">
              <button
                type="button"
                onClick={handleRequestCloseEditModal}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#6b6257] hover:bg-[#e8e0d3] transition-colors"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={handleSaveNoteEdit}
                className="px-5 py-2 rounded-xl text-xs font-medium bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] transition-all shadow-xs"
              >
                保存する
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
            className="bg-[#f4f0e8] rounded-2xl p-6 sm:p-7 max-w-sm w-full border border-[#ded6c9] shadow-2xl transition-all"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-[#3d3731] mb-2">
              変更内容を破棄しますか？
            </h3>
            <p className="text-xs text-[#786f66] leading-relaxed mb-6 bg-[#eae4d9] p-3 rounded-xl border border-[#ded6c9]">
              保存されていないタイトルやカテゴリの変更は失われます。
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowDiscardConfirmModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-[#6b6257] hover:bg-[#e8e0d3] transition-colors"
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
            className="bg-[#f4f0e8] rounded-2xl p-6 sm:p-7 max-w-sm w-full border border-[#ded6c9] shadow-2xl transition-all"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ヘッダー */}
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#ded6c9]">
              <h2 className="text-base font-bold text-[#3d3731] flex items-center gap-1.5">
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
                className="text-[#8a7f72] hover:text-[#3d3731] text-xs px-2 py-1"
              >
                ✕
              </button>
            </div>

            {/* モード切り替えタブ（ログイン / 新規登録 / 再設定時の戻るリンク） */}
            {authMode !== "reset" ? (
              <div className="flex bg-[#e8e0d3] p-1 rounded-xl mb-4 border border-[#ded6c9]">
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
                  className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    authMode === "login"
                      ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                      : "text-[#6b6257] hover:text-[#2d2926]"
                  }`}
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
                  className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${
                    authMode === "signup"
                      ? "bg-[#3d3731] text-[#faf8f5] shadow-xs"
                      : "text-[#6b6257] hover:text-[#2d2926]"
                  }`}
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
                  className="text-xs text-[#7d7367] hover:text-[#3d3731] flex items-center gap-1 font-medium cursor-pointer"
                >
                  <span>←</span> ログイン画面に戻る
                </button>
              </div>
            )}

            {authMode === "reset" ? (
              <form onSubmit={handleResetPasswordSubmit} className="space-y-3.5">
                <p className="text-xs text-[#786f66] leading-relaxed bg-[#eae4d9] p-2.5 rounded-xl border border-[#ded6c9]">
                  登録時に保存した【復旧キー】を入力して、新しいパスワードを設定します。
                </p>

                {/* ユーザー名入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
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
                    className="w-full px-3 py-2 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                  />
                </div>

                {/* 復旧キー入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
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
                    className="w-full px-3 py-2 text-sm font-mono bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                  />
                </div>

                {/* 新しいパスワード入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
                    新しいパスワード（6文字以上）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="新しいパスワードを入力"
                      value={authPasswordInput}
                      onChange={(e) => setAuthPasswordInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 text-[#8a7f72] hover:text-[#3d3731] text-sm p-1 transition-colors"
                      title={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPassword ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>

                {/* 新しいパスワード確認用入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
                    新しいパスワード（確認用）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPasswordConfirm ? "text" : "password"}
                      placeholder="もう一度入力"
                      value={authPasswordConfirmInput}
                      onChange={(e) => setAuthPasswordConfirmInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPasswordConfirm(!showPasswordConfirm)}
                      className="absolute right-2.5 text-[#8a7f72] hover:text-[#3d3731] text-sm p-1 transition-colors"
                      title={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPasswordConfirm ? "🙈" : "👁️"}
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
                    className="w-full py-2.5 rounded-xl bg-[#3d3731] text-[#faf8f5] text-sm font-bold hover:bg-[#292420] active:scale-[0.99] transition-all disabled:opacity-50 shadow-xs cursor-pointer"
                  >
                    {isAuthLoading ? "再設定中..." : "パスワードを再設定してログイン"}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleAuthSubmit} className="space-y-3.5">
                {/* ユーザー名入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
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
                    className="w-full px-3 py-2 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                  />
                </div>

                {/* パスワード入力 */}
                <div>
                  <label className="block text-xs font-bold text-[#3d3731] mb-1">
                    パスワード（6文字以上）
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder="パスワードを入力"
                      value={authPasswordInput}
                      onChange={(e) => setAuthPasswordInput(e.target.value)}
                      required
                      className="w-full px-3 py-2 pr-10 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 text-[#8a7f72] hover:text-[#3d3731] text-sm p-1 transition-colors"
                      title={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                      aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示する"}
                    >
                      {showPassword ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>

                {/* 新規登録時のみ：パスワード確認用入力 */}
                {authMode === "signup" && (
                  <div>
                    <label className="block text-xs font-bold text-[#3d3731] mb-1">
                      パスワード（確認用）
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type={showPasswordConfirm ? "text" : "password"}
                        placeholder="もう一度パスワードを入力"
                        value={authPasswordConfirmInput}
                        onChange={(e) => setAuthPasswordConfirmInput(e.target.value)}
                        required
                        className="w-full px-3 py-2 pr-10 text-sm bg-[#faf8f5] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPasswordConfirm(!showPasswordConfirm)}
                        className="absolute right-2.5 text-[#8a7f72] hover:text-[#3d3731] text-sm p-1 transition-colors"
                        title={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                        aria-label={showPasswordConfirm ? "パスワードを隠す" : "パスワードを表示する"}
                      >
                        {showPasswordConfirm ? "🙈" : "👁️"}
                      </button>
                    </div>
                  </div>
                )}

                {/* プライバシー安心注釈 */}
                <div className="p-2.5 rounded-lg bg-[#eae4d9] border border-[#ded6c9] text-[11px] text-[#6b6257] leading-relaxed">
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
                    className="w-full py-2.5 rounded-xl bg-[#3d3731] text-[#faf8f5] text-sm font-bold hover:bg-[#292420] active:scale-[0.99] transition-all disabled:opacity-50 shadow-xs cursor-pointer"
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
                      className="text-xs text-[#7d7367] hover:text-[#3d3731] underline font-medium cursor-pointer"
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
            className="bg-[#f7f4ed] rounded-2xl p-6 sm:p-7 max-w-sm w-full border border-[#ded6c9] shadow-2xl transition-all flex flex-col gap-4 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center gap-1">
              <span className="text-3xl">🌱</span>
              <h2 className="text-base font-bold text-[#3d3731]">
                アカウントを作成しました！
              </h2>
              <span className="text-xs text-[#8a7f72]">
                万が一パスワードを忘れたときの【復旧キー】です
              </span>
            </div>

            {/* 復旧キー枠 */}
            <div className="p-3.5 bg-white rounded-xl border-2 border-[#d49e35] shadow-xs flex flex-col items-center gap-2">
              <span className="text-[11px] font-bold text-[#8a7f72]">
                あなたの復旧キー
              </span>
              <code className="text-lg font-mono font-bold tracking-widest text-[#2d2926] select-all bg-[#faf8f5] px-3 py-1 rounded-lg border border-[#e5ded2]">
                {newlyRegisteredKey}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(newlyRegisteredKey);
                  setCopiedKeyToast(true);
                  setTimeout(() => setCopiedKeyToast(false), 2000);
                }}
                className="px-3.5 py-1 text-xs font-bold rounded-lg bg-[#f4f0e8] hover:bg-[#eae3d7] text-[#5c5348] border border-[#ded5c8] transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
              >
                <span>📋</span> {copiedKeyToast ? "コピーしました！" : "キーをコピー"}
              </button>
            </div>

            {/* 3大注意点 */}
            <div className="bg-[#fff9ed] border border-[#f0dcaf] rounded-xl p-3 text-left flex flex-col gap-1.5 text-xs text-[#7d5e1b] leading-relaxed">
              <span className="font-bold text-[11px] flex items-center gap-1">
                <span>⚠️</span> 大切なお願い（必ずお読みください）:
              </span>
              <ol className="list-decimal pl-4 space-y-1 text-[11px]">
                <li><strong>誰にも教えないでください</strong>（パスワードと同じ機密情報です）。</li>
                <li><strong>SeedNoteの中にメモしないでください</strong>（ログインできないと見られなくなります）。</li>
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
              className="w-full py-2.5 rounded-xl bg-[#3d3731] text-[#faf8f5] text-sm font-bold hover:bg-[#292420] active:scale-[0.99] transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span>📸</span> スクショを保存したので始める
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
