import type { Metadata } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { IconShield, IconServer, IconPlus, IconCpu } from "@tabler/icons-react";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Aegis: Workload Provisioning Console",
  description: "Self-service Kubernetes workload provisioning and policy governance console",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${spaceMono.variable}`}>
      <body className="min-h-screen bg-[#F6F4EE] text-[#1A1816] font-sans antialiased flex flex-col selection:bg-[#FF4F00]/20 selection:text-[#1A1816]">
        {/* Engineering Console Top Header */}
        <header className="border-b border-[#E2DDD4] bg-[#F6F4EE]/90 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            {/* Brand Logo & Context */}
            <div className="flex items-center space-x-4">
              <Link href="/" className="flex items-center space-x-3 group">
                <div className="h-8 w-8 rounded-lg bg-[#FF4F00] flex items-center justify-center group-hover:bg-[#E04500] transition-colors shadow-sm">
                  <IconShield size={18} className="text-white" stroke={2.5} />
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-bold tracking-tight text-[#1A1816]">Aegis</span>
                  <span className="text-xs text-[#6B665E] hidden sm:inline">Infrastructure Console</span>
                </div>
              </Link>
            </div>

            {/* Target Cluster Telemetry Pill & Actions */}
            <div className="flex items-center space-x-4">
              {/* Cluster Status Badge */}
              <div className="flex items-center space-x-2 px-3 py-1.5 rounded-md bg-[#EFECE4] border border-[#E2DDD4] text-xs font-mono">
                <span className="inline-flex rounded-full h-2 w-2 bg-[#1D7A46]"></span>
                <IconServer size={14} className="text-[#6B665E]" stroke={1.5} />
                <span className="text-[#6B665E]">Cluster:</span>
                <span className="text-[#1A1816] font-bold">kind-aegis</span>
              </div>

              {/* New Deployment Button */}
              <Link
                href="/"
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-[#FF4F00] hover:bg-[#E04500] text-white font-medium text-xs shadow-sm transition-all active:scale-[0.98]"
              >
                <IconPlus size={15} stroke={2.5} />
                <span>New Deployment</span>
              </Link>
            </div>
          </div>
        </header>

        {/* Main Content Viewport */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>

        {/* Console Footer */}
        <footer className="border-t border-[#E2DDD4] bg-[#EFECE4] text-[#6B665E] text-xs py-4">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <IconCpu size={14} className="text-[#6B665E]" stroke={1.5} />
              <span className="font-medium text-[#1A1816]">Aegis Developer Platform</span>
            </div>
            <div className="font-mono text-[11px] text-[#6B665E]">
              Kind Cluster Provisioner &middot; Isolated Terraform Workspaces
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
