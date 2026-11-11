import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { LiveProvider } from "@/components/LiveProvider";

export const metadata: Metadata = {
  title: "Хөдөлгөөн таних систем",
  description: "MPU6050 + ESP32-S3 мэдрэгчийн өгөгдлөөр хүний хөдөлгөөнийг бодит хугацаанд таних эрүүл мэндийн туслах систем",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f6" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="mn">
      <body className="min-h-dvh font-sans">
        <LiveProvider>
          <Nav />
          <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">{children}</main>
        </LiveProvider>
      </body>
    </html>
  );
}
