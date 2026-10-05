import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "evalkit",
  description: "Code-editing eval harness on free-tier providers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}