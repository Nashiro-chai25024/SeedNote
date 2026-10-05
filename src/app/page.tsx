"use client";

import { useState, useEffect } from "react";

// メモのデータ型定義
interface Note {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
  isTrash?: boolean; // ゴミ箱フラグ（完全削除せず退避する）
  categories?: string[]; // カテゴリタグ一覧
  isFavorite?: boolean; // お気に入りフラグ
}

type TabType = "home" | "list" | "categories" | "trash" | "settings";
type FontSize = "normal" | "large";
type ButtonSize = "normal" | "large";

// ガイド・ヘルプの全11項目データ
const HELP_ITEMS = [
  {
    id: "about",
    title: "SeedNoteとは",
    content: (
      <div className="space-y-1.5">
        <p>自分のアイデアや思いついたことを素早く記録し、あとから簡単に探し出せる自分専用のアプリです。</p>
        <p>創作のアイデア、ゲームやアニメの考察、勉強メモ、英単語、Webサービスの思いつきなど、ジャンルを問わず自由に記録できます。</p>
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
        <p>使い方はとてもシンプルです。</p>
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
    title: "カテゴリ（未分類について）",
    content: (
      <div className="space-y-2.5">
        <div>
          <strong className="block mb-0.5 text-[#3d3731]">カテゴリの作成：</strong>
          <p>「創作」「ゲーム考察」「勉強」など、自分の好きなカテゴリを自由に作れます。一度使ったカテゴリは候補として表示されるので、次からはワンタップで選べます。</p>
        </div>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">未分類での保存：</strong>
          <p>
            カテゴリで迷ったときは、何も選ばず<strong>「未分類」のまま保存して大丈夫</strong>です。「アイデアが浮かんだ瞬間にすぐ書くこと」を一番優先してほしいので、カテゴリは後からいつでも設定・変更できます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "search",
    title: "検索（日付・曜日・時間帯・複合検索）",
    content: (
      <div className="space-y-2">
        <p>過去のメモをいろいろな切り口で探すことができます。</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><strong>キーワード検索：</strong> 覚えている言葉を入力して探せます。</li>
          <li><strong>日付・カレンダー検索：</strong> カレンダーから特定の日を選んで、その日に書いたメモを振り返ることができます。</li>
          <li><strong>曜日検索：</strong> 「土曜日に書いたメモ」「月曜日のメモ」のように曜日で絞り込めます。</li>
          <li><strong>時間帯検索：</strong> 「深夜に書いたアイデア」「朝の勉強メモ」のように時間帯で絞り込めます。</li>
          <li><strong>複合検索：</strong> 「創作 × 深夜」や「ゲーム考察 × 土曜日」のように、複数の条件を掛け合わせてピンポイントに探せます。</li>
        </ul>
      </div>
    ),
  },
  {
    id: "trash",
    title: "ゴミ箱（移動と復元・誤操作防止）",
    content: (
      <div className="space-y-2">
        <div>
          <strong className="block mb-0.5 text-[#3d3731]">ゴミ箱への移動手順：</strong>
          <p>
            メモカードの右上にある「…」ボタンを押すと、「ゴミ箱へ移動」が表示されます。誤タップを防ぐため、2段階で移動する仕組みになっています。
          </p>
          <p className="text-xs text-[#786f66] mt-1">
            ※メニュー以外の場所をタップすると、メニューを閉じることができます。
          </p>
        </div>
        <div className="pt-1.5 border-t border-[#e5ded2]">
          <strong className="block mb-0.5 text-[#3d3731]">データの保持と復元：</strong>
          <p>
            ゴミ箱に入れたメモは一覧からは見えなくなりますが、<strong>データが消えるわけではありません</strong>。
          </p>
          <p className="mt-1">
            「間違えて入れちゃった！」という時も、左メニューの「ゴミ箱」画面から「↩️ 元に戻す」を押せば、いつでも元の場所に戻せます。
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "archive",
    title: "アーカイブ",
    content: (
      <div className="space-y-1.5">
        <p>「削除したくはないけれど、普段の一覧には出しておきたくないメモ」をしまっておく場所です。</p>
        <p>終了した企画や、過去の古い勉強メモ、今は使わない資料などを整理するのに役立ちます。</p>
      </div>
    ),
  },
  {
    id: "timezone",
    title: "時間帯設定",
    content: (
      <div className="space-y-1.5">
        <p>「深夜」や「夕方」と感じる時間は人によって違います。</p>
        <p>そのため、「自分の深夜は何時から何時までか」を自由に設定できます（例: 0:00〜4:59、2:00〜6:59など）。</p>
        <p>ここで決めた自分だけの時間帯は、検索機能にもそのまま反映されます。</p>
      </div>
    ),
  },
  {
    id: "theme",
    title: "外観設定（テーマ）",
    content: (
      <div className="space-y-1.5">
        <p>画面の見た目をお好みのテーマに変更できます。</p>
        <p>目に優しいライトモードやダークモード、やわらかなパステルモード、黒を基調としたカスタムモードなどから選べます。</p>
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
          <p className="mt-1 text-xs text-[#5c5348]">A. 「未分類」のまま保存してください。後からいつでも変更できます。</p>
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
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

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
    } catch (e) {
      console.error("データの読み込みに失敗しました", e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

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
    if (categoriesList.includes(trimmed)) return;

    const updated = [...categoriesList, trimmed];
    setCategoriesList(updated);
    try {
      localStorage.setItem("seednote_categories", JSON.stringify(updated));
    } catch (e) {
      console.error("カテゴリの保存に失敗しました", e);
    }
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

    // 選択中カテゴリからも除外
    setSelectedCategories((prev) => prev.filter((c) => c !== categoryToDelete));

    // 既存メモから該当カテゴリのみを除外
    const updatedNotes = notes.map((note) => {
      if (!note.categories) return note;
      const filtered = note.categories.filter((c) => c !== categoryToDelete);
      return {
        ...note,
        categories: filtered.length > 0 ? filtered : undefined,
      };
    });
    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));

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
    setActiveMenuNoteId(null); // メニューを閉じる
  };

  // ゴミ箱から元に戻す処理
  const handleRestoreFromTrash = (id: string) => {
    const updatedNotes = notes.map((note) =>
      note.id === id ? { ...note, isTrash: false } : note
    );
    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));
  };

  // 通知設定の切り替え
  const handleToggleToast = (checked: boolean) => {
    setEnableToast(checked);
    localStorage.setItem("seednote_enable_toast", String(checked));
  };

  // 編集破棄時の確認設定の切り替え（フールプルーフ）
  const handleToggleConfirmDiscard = (checked: boolean) => {
    setConfirmDiscardOnEdit(checked);
    localStorage.setItem("seednote_confirm_discard", String(checked));
  };

  // 文字サイズの切り替え
  const handleFontSizeChange = (size: FontSize) => {
    setFontSize(size);
    localStorage.setItem("seednote_font_size", size);
  };

  // ボタンの大きさの切り替え
  const handleButtonSizeChange = (size: ButtonSize) => {
    setButtonSize(size);
    localStorage.setItem("seednote_button_size", size);
  };

  // Ctrl + Enter (または Cmd + Enter) で素早く保存
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
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
    const updatedNotes = notes.map((note) =>
      note.id === id ? { ...note, isFavorite: !note.isFavorite } : note
    );
    setNotes(updatedNotes);
    localStorage.setItem("seednote_items", JSON.stringify(updatedNotes));
  };

  const hasContent = content.trim().length > 0;
  const activeNotes = notes.filter((n) => !n.isTrash);
  const trashNotes = notes.filter((n) => n.isTrash);

  // 検索・絞り込み適用後のメモ一覧
  const displayedNotes = activeNotes.filter((note) => {
    if (filterOnlyFavorite && !note.isFavorite) return false;
    if (filterCategory !== null) {
      if (filterCategory === "uncategorized") {
        if (note.categories && note.categories.length > 0) return false;
      } else {
        if (!note.categories || !note.categories.includes(filterCategory)) return false;
      }
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

      {/* 保存通知トースト */}
      <div
        className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 pointer-events-none ${
          showToast ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"
        }`}
      >
        <div className="bg-[#3d3731] text-[#faf8f5] px-4 py-2 rounded-full text-xs font-medium shadow-md flex items-center gap-1.5">
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

        {/* 中央：控えめなロゴ */}
        <span className="text-sm font-semibold tracking-wide text-[#6b6257] flex items-center gap-1.5 select-none">
          <span>🌱</span> SeedNote
        </span>

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
          <div className="flex items-center justify-between mb-8 pb-3 border-b border-[#ded6c9]">
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
              <span>⌂</span> ホーム
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
                <span>🔍</span> メモを見る
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
      <main className="max-w-xl w-full mx-auto my-auto py-8">
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

                  {/* 登録済みカテゴリチップ */}
                  {categoriesList.map((cat) => {
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
          <div className="flex flex-col max-h-[78vh]">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0]">
              <h2
                className={`${
                  fontSize === "large" ? "text-xl" : "text-lg"
                } font-bold text-[#3d3731]`}
              >
                メモ一覧 ({activeNotes.length}件)
              </h2>
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

            {/* 検索・絞り込み機能エリア（スケッチの実装） */}
            {!isSearchPanelOpen ? (
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setIsSearchPanelOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-[#ded5c8] text-xs font-bold text-[#5c5348] hover:bg-[#faf8f5] shadow-2xs transition-all"
                >
                  <span>🔍</span> 検索機能
                  {(filterOnlyFavorite || filterCategory !== null) && (
                    <span className="w-2 h-2 rounded-full bg-[#d49e35]" title="絞り込み中" />
                  )}
                </button>
                {(filterOnlyFavorite || filterCategory !== null) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterOnlyFavorite(false);
                      setFilterCategory(null);
                    }}
                    className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline font-medium"
                  >
                    絞り込みを解除
                  </button>
                )}
              </div>
            ) : (
              <div className="mb-3 p-3.5 bg-white rounded-xl border border-[#ded5c8] shadow-xs flex flex-col gap-3 transition-all">
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

                {/* ① お気に入り表示 */}
                <div>
                  <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
                    ⭐ お気に入り
                  </span>
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
                    {filterOnlyFavorite ? "お気に入りのみ表示中" : "お気に入りのみ表示"}
                  </button>
                </div>

                {/* ② タグからさがす */}
                <div>
                  <span className="block text-[11px] font-bold text-[#8a7f72] mb-1.5">
                    🏷️ タグからさがす
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFilterCategory(null)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                        filterCategory === null
                          ? "bg-[#3d3731] text-white shadow-xs"
                          : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                      }`}
                    >
                      すべて
                    </button>
                    {categoriesList.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() =>
                          setFilterCategory(filterCategory === cat ? null : cat)
                        }
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                          filterCategory === cat
                            ? "bg-[#3d3731] text-white shadow-xs"
                            : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setFilterCategory(
                          filterCategory === "uncategorized" ? null : "uncategorized"
                        )
                      }
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                        filterCategory === "uncategorized"
                          ? "bg-[#3d3731] text-white shadow-xs"
                          : "bg-[#f4f0e8] text-[#6b6257] hover:bg-[#eae3d7]"
                      }`}
                    >
                      未分類
                    </button>
                  </div>
                </div>

                {/* ヒット件数 */}
                {(filterOnlyFavorite || filterCategory !== null) && (
                  <div className="text-[11px] text-[#8a7f72] pt-1 border-t border-[#f4f0e8] flex items-center justify-between">
                    <span>該当するメモ: {displayedNotes.length}件</span>
                    <button
                      type="button"
                      onClick={() => {
                        setFilterOnlyFavorite(false);
                        setFilterCategory(null);
                      }}
                      className="text-[11px] text-[#8a7f72] hover:text-[#3d3731] underline"
                    >
                      条件をリセット
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="overflow-y-auto flex flex-col gap-3 pr-1">
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
                      setFilterCategory(null);
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
                      className="p-4 rounded-xl bg-white border border-[#e5ded2] shadow-2xs relative"
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <h3
                          className={`font-bold text-[#3d3731] ${
                            fontSize === "large" ? "text-base" : "text-sm"
                          } pr-6`}
                        >
                          {note.title || <span className="text-[#b0a598] font-normal italic">（無題）</span>}
                        </h3>

                        {/* 右上：お気に入りボタン ＆ 控えめな「…」メニューボタン */}
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
                    </article>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ③ ゴミ箱画面（二層化） */}
        {activeTab === "trash" && (
          <div className="flex flex-col max-h-[78vh]">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0]">
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

            <div className="overflow-y-auto flex flex-col gap-3 pr-1">
              {trashNotes.length === 0 ? (
                <div className="text-center py-10 text-sm text-[#8a7f72]">
                  ゴミ箱は空です。
                </div>
              ) : (
                trashNotes.map((note) => (
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
                      } text-[#5c5348] whitespace-pre-wrap leading-relaxed mb-3`}
                    >
                      {note.content}
                    </p>
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
        )}

        {/* ③-2 カテゴリ管理画面（二層化） */}
        {activeTab === "categories" && (
          <div className="flex flex-col max-h-[78vh]">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#d5cdc0]">
              <div>
                <h2
                  className={`${
                    fontSize === "large" ? "text-xl" : "text-lg"
                  } font-bold text-[#3d3731]`}
                >
                  カテゴリ管理 ({categoriesList.length}件)
                </h2>
                <span className="text-[11px] text-[#8a7f72]">
                  メモを分類するタグの作成と整理ができます
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
            <div className="mb-4 p-3.5 bg-white rounded-xl border border-[#e5ded2]">
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

            {/* エリアの仕切り線と余白 */}
            <div className="border-b border-[#ded5c8] my-4" />

            {/* 登録済みカテゴリ一覧 */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 flex flex-col gap-2">
              <span className="text-xs font-bold text-[#3d3731] mb-0.5">
                登録済みカテゴリ
              </span>
              {categoriesList.length === 0 ? (
                <div className="text-center py-8 text-xs text-[#8a7f72] bg-white/60 rounded-xl border border-dashed border-[#ded6c9] p-4">
                  まだ登録されたカテゴリはありません。<br />
                  上の入力欄から追加するか、メモを書くときに「＋ 新規」から作成できます。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {categoriesList.map((cat) => {
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

              {/* 編集破棄の確認（フールプルーフ設定） */}
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

              {/* 容量・メモ情報 */}
              <div className="p-3.5 bg-white rounded-xl border border-[#e5ded2]">
                <span className="font-medium text-[#3d3731] block mb-2">容量・メモ情報</span>
                <div className="text-xs text-[#7d7367] flex flex-col gap-1">
                  <div>通常メモ：{activeNotes.length} 件</div>
                  <div>ゴミ箱内：{trashNotes.length} 件</div>
                  <div>総データ数：{notes.length} 件</div>
                </div>
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
                  {categoriesList.map((cat) => {
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
    </div>
  );
}
