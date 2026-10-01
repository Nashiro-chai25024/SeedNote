"use client";

import { useState, useEffect } from "react";

// メモのデータ型定義
interface Note {
  id: string;
  title?: string;
  content: string;
  createdAt: string;
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // 初回読み込み時にブラウザの保存領域 (localStorage) からメモを復元
  useEffect(() => {
    try {
      const saved = localStorage.getItem("seednote_items");
      if (saved) {
        setNotes(JSON.parse(saved));
      }
    } catch (e) {
      console.error("メモの読み込みに失敗しました", e);
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

  // 本文に1文字以上入力されているかどうかの判定
  const hasContent = content.trim().length > 0;

  return (
    <div className="min-h-screen bg-[#e8e2d5] text-[#2d2926] font-sans flex flex-col justify-between p-4 sm:p-8 transition-colors">
      {/* 画面上部：極めて控えめなロゴ */}
      <header className="flex justify-between items-center max-w-xl w-full mx-auto pt-2">
        <span className="text-sm font-semibold tracking-wide text-[#6b6257] flex items-center gap-1.5 select-none">
          <span>🌱</span> SeedNote
        </span>

        {/* 過去ログを見るボタン（控えめに右上に配置） */}
        <button
          type="button"
          onClick={() => setShowHistory(!showHistory)}
          className="text-xs text-[#7d7367] hover:text-[#453f38] transition-colors px-2 py-1 rounded-md"
        >
          {showHistory ? "✕ 閉じる" : `記録を見る (${notes.length})`}
        </button>
      </header>

      {/* 画面中央：ノイズゼロのメモ書きスペース */}
      <main className="max-w-xl w-full mx-auto my-auto py-8">
        {!showHistory ? (
          /* メモ入力カード：白浮きしない、わずかにグレーがかった目に優しい色合い */
          <div className="relative bg-[#f2efe9] rounded-2xl p-6 sm:p-8 shadow-sm border border-[#d5cdc0] transition-all">
            {/* 本文に文字が入った時だけ、スッと現れるタイトル欄 */}
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

            {/* 本文入力欄（文字はゼロ、大きめの鉛筆マークが薄く佇む） */}
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

            {/* 本文に文字が入った時だけ、スッと現れる保存ボタン */}
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
        ) : (
          /* 記録を見るボタンを押した時だけ展開される過去ログ */
          <div className="bg-white rounded-2xl p-6 border border-[#d5cdc0] shadow-sm max-h-[70vh] overflow-y-auto">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#7d7367] mb-4">
              過去の記録 ({notes.length}件)
            </h2>

            {!isLoaded ? (
              <div className="text-center py-8 text-sm text-[#b0a598]">
                読み込み中...
              </div>
            ) : notes.length === 0 ? (
              <div className="text-center py-8 text-sm text-[#7d7367]">
                まだ記録がありません。
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {notes.map((note) => (
                  <article
                    key={note.id}
                    className="p-4 rounded-xl bg-[#faf7f2] border border-[#e5ded2]"
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      {note.title ? (
                        <h3 className="font-bold text-[#3d3731] text-sm">
                          {note.title}
                        </h3>
                      ) : (
                        <span className="text-xs text-[#b0a598] italic">
                          （無題）
                        </span>
                      )}
                      <time className="text-xs text-[#7d7367] shrink-0 font-mono">
                        {formatDate(note.createdAt)}
                      </time>
                    </div>
                    <p className="text-sm text-[#453f38] whitespace-pre-wrap leading-relaxed">
                      {note.content}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* フッター */}
      <footer className="text-center py-2 text-xs text-transparent select-none">
        SeedNote
      </footer>
    </div>
  );
}
