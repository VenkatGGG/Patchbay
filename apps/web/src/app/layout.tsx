import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Patchbay Control Plane",
  description: "Session-scoped multi-agent diagnostics for on-call teams"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

