import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import "./globals.css";
import { mockAuthEnabled } from "@/lib/auth/config";
import { signInProviders } from "@/lib/auth/oidc";
import { currentSession } from "@/lib/auth/viewer";
import SessionProvider from "@/components/SessionProvider";

const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-barlow" });
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Fantasy Hoops",
  description: "Season averages for our 9-category league",
};

// viewport-fit=cover so the phone tab bar can pad for the home indicator.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

// Runs before first paint so the page never flashes the wrong theme. Keep the
// storage key in sync with THEME_STORAGE_KEY in components/ThemeToggle.tsx.
const themeScript = `try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <html lang="en" className={`${barlow.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <SessionProvider value={{ user: session?.user ?? null, mock: mockAuthEnabled(), providers: signInProviders() }}>{children}</SessionProvider>
      </body>
    </html>
  );
}
