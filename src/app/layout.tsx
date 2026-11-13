import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#f5efe6",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://seed-note-ten.vercel.app"),
  title: "ライトNote - 今すぐ、光のように思考を書くノート",
  description: "認知的ノイズゼロで今すぐ書き留められる、自分専用の思考ノートアプリ「ライトNote（RaitoNote）」",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    title: "ライトNote - 今すぐ、光のように思考を書くノート",
    description: "認知的ノイズゼロで今すぐ書き留められる、自分専用の思考ノートアプリ「ライトNote（RaitoNote）」",
    url: "https://seed-note-ten.vercel.app",
    siteName: "ライトNote",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ライトNote (RaitoNote) - 公式思考ノートアプリ",
      },
    ],
    locale: "ja_JP",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ライトNote - 今すぐ、光のように思考を書くノート",
    description: "認知的ノイズゼロで今すぐ書き留められる、自分専用の思考ノートアプリ「ライトNote（RaitoNote）」",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Klee+One:wght@400;600&family=Shippori+Mincho:wght@400;600&family=Yomogi&family=Zen+Maru+Gothic:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
