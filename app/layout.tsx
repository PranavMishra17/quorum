import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";

/*
 * One family, three roles.
 *
 * IBM Plex was drawn for an institution — its brief was corporate, technical
 * documentation, machine-adjacent — which is precisely the register of a
 * clearance system. The condensed cut carries the labels and stamps, where its
 * narrow uppercase reads like a file tab; the regular cut carries prose; the
 * mono carries anything a machine produced (ids, token counts, event names).
 *
 * Using one superfamily rather than a display/body pairing is the restrained
 * choice, and it is the right one here: the page already has a very loud
 * element in the redaction bar, and a second voice in the type would fight it.
 */
const display = IBM_Plex_Sans_Condensed({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = IBM_Plex_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: {
    default: "Quorum",
    template: "%s · Quorum",
  },
  description:
    "A chat workspace where one agent is present everywhere, decides for itself whether to speak, and never carries what it learns across an authorisation boundary.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
