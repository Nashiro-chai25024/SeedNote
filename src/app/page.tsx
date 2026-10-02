"use client";

import { useState, useEffect } from "react";

// メモのデータ型定義
interface Note {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
  isTrash?: boolean; // ゴミ箱フラグ（完全削除せず退避する）
}

type TabType = "home" | "list" | "trash" | "settings";

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
    title: "ゴミ箱",
    content: (
      <div className="space-y-1.5">
        <p>使わなくなったメモは「ゴミ箱」へ移動できます。</p>
        <p>ゴミ箱に入れたメモは普段の一覧や検索からは見えなくなりますが、<strong>データが消えるわけではありません</strong>。</p>
        <p>「間違えて入れちゃった！」という時も、ゴミ箱画面からいつでも元の場所に戻せます。また、ゴミ箱の中だけを対象にした検索もできます。</p>
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
  const [showToast, setShowToast] = useState(false);
  const [enableToast, setEnableToast] = useState(true);
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
    } catch (e) {
      console.error("データの読み込みに失敗しました", e);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // メモを保存する処理
  const handleSave = () => {
    if (!content.trim()) return;

    const newNote: Note = {
      id: crypto.randomUUID(),
      title: title.trim() || undefined,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      isTrash: false,
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

  const hasContent = content.trim().length > 0;
  const activeNotes = notes.filter((n) => !n.isTrash);
  const trashNotes = notes.filter((n) => n.isTrash);

  return (
    <div className="min-h-screen bg-[#e8e2d5] text-[#2d2926] font-sans flex flex-col justify-between p-4 sm:p-8 relative overflow-x-hidden">
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
          className="w-9 h-9 flex items-center justify-center rounded-xl text-[#6b6257] hover:bg-[#ded6c9] active:bg-[#d5ccbe] transition-colors"
          aria-label="メニューを開く"
        >
          <span className="text-xl leading-none">≡</span>
        </button>

        {/* 中央：控えめなロゴ */}
        <span className="text-sm font-semibold tracking-wide text-[#6b6257] flex items-center gap-1.5 select-none">
          <span>🌱</span> SeedNote
        </span>

        {/* 右上：ガイド・ヘルプボタン ？ */}
        <button
          type="button"
          onClick={() => setIsHelpOpen(true)}
          className="w-8 h-8 flex items-center justify-center rounded-full text-xs font-bold border border-[#b8aea2] text-[#6b6257] hover:bg-[#ded6c9] transition-colors"
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
              className="text-xs text-[#8a7f72] hover:text-[#3d3731] px-2 py-1"
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
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors text-left ${
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
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors text-left ${
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

            <div className="my-2 border-t border-[#ded6c9]" />

            <button
              type="button"
              onClick={() => {
                setActiveTab("trash");
                setIsMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors text-left ${
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
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors text-left ${
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
                className="w-full px-3.5 py-2 text-sm bg-[#faf7f2] rounded-xl border border-[#ded5c8] focus:outline-none focus:border-[#968979] text-[#2d2926] placeholder-[#b0a598]"
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
                className="w-full text-base bg-transparent border-0 focus:outline-none resize-none text-[#2d2926] leading-relaxed relative z-10"
              />
            </div>

            {/* 本文に文字が入った時だけ現れる保存ボタン */}
            <div
              className={`flex justify-end pt-3 transition-all duration-300 ease-out ${
                hasContent ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              <button
                type="button"
                onClick={handleSave}
                className="px-6 py-2 rounded-xl text-sm font-medium bg-[#3d3731] text-[#faf8f5] hover:bg-[#292420] transition-all shadow-sm"
              >
                保存
              </button>
            </div>
          </div>
        )}

        {/* ② メモを見る（通常一覧） */}
        {activeTab === "list" && (
          <div className="bg-[#f2efe9] rounded-2xl p-6 border border-[#d5cdc0] shadow-sm max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#ded5c8]">
              <h2 className="text-sm font-bold text-[#3d3731]">
                メモ一覧 ({activeNotes.length}件)
              </h2>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className="text-xs text-[#7d7367] hover:text-[#3d3731]"
              >
                ← ホームへ
              </button>
            </div>

            <div className="overflow-y-auto flex flex-col gap-3 pr-1">
              {!isLoaded ? (
                <div className="text-center py-8 text-sm text-[#b0a598]">
                  読み込み中...
                </div>
              ) : activeNotes.length === 0 ? (
                <div className="text-center py-10 text-sm text-[#8a7f72]">
                  まだメモがありません。ホームから思いつきを書いてみましょう。
                </div>
              ) : (
                activeNotes.map((note) => (
                  <article
                    key={note.id}
                    className="p-4 rounded-xl bg-white border border-[#e5ded2] shadow-2xs"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <h3 className="font-bold text-[#3d3731] text-sm">
                        {note.title || <span className="text-[#b0a598] font-normal italic">（無題）</span>}
                      </h3>
                      <time className="text-xs text-[#8a7f72] shrink-0 font-mono">
                        {formatDate(note.createdAt)}
                      </time>
                    </div>
                    <p className="text-sm text-[#453f38] whitespace-pre-wrap leading-relaxed mb-3">
                      {note.content}
                    </p>
                    <div className="flex justify-end pt-2 border-t border-[#f4f0e8]">
                      <button
                        type="button"
                        onClick={() => handleMoveToTrash(note.id)}
                        className="text-xs text-[#9c9184] hover:text-[#b85448] flex items-center gap-1 transition-colors px-2 py-1 rounded"
                      >
                        <span>🗑️</span> ゴミ箱へ
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        )}

        {/* ③ ゴミ箱画面 */}
        {activeTab === "trash" && (
          <div className="bg-[#f2efe9] rounded-2xl p-6 border border-[#d5cdc0] shadow-sm max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#ded5c8]">
              <div>
                <h2 className="text-sm font-bold text-[#3d3731]">
                  ゴミ箱 ({trashNotes.length}件)
                </h2>
                <span className="text-[11px] text-[#8a7f72]">
                  ※データは安全に保持されています
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className="text-xs text-[#7d7367] hover:text-[#3d3731]"
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
                      <h3 className="font-bold text-[#3d3731] text-sm">
                        {note.title || <span className="text-[#b0a598] font-normal italic">（無題）</span>}
                      </h3>
                      <time className="text-xs text-[#8a7f72] shrink-0 font-mono">
                        {formatDate(note.createdAt)}
                      </time>
                    </div>
                    <p className="text-sm text-[#5c5348] whitespace-pre-wrap leading-relaxed mb-3">
                      {note.content}
                    </p>
                    <div className="flex justify-end pt-2 border-t border-[#f4f0e8]">
                      <button
                        type="button"
                        onClick={() => handleRestoreFromTrash(note.id)}
                        className="text-xs text-[#6b6257] hover:text-[#2d2926] bg-[#eae3d7] px-3 py-1 rounded-lg transition-colors flex items-center gap-1 font-medium"
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

        {/* ④ 設定画面 */}
        {activeTab === "settings" && (
          <div className="bg-[#f2efe9] rounded-2xl p-6 border border-[#d5cdc0] shadow-sm">
            <div className="flex items-center justify-between mb-6 pb-2 border-b border-[#ded5c8]">
              <h2 className="text-sm font-bold text-[#3d3731]">設定</h2>
              <button
                type="button"
                onClick={() => setActiveTab("home")}
                className="text-xs text-[#7d7367] hover:text-[#3d3731]"
              >
                ← ホームへ
              </button>
            </div>

            <div className="flex flex-col gap-5 text-sm">
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
    </div>
  );
}
