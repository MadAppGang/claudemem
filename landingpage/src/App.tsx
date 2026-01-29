import React, { useState } from "react";
import LandingPage from "./components/LandingPage";
import HeroSection from "./components/HeroSection";
import FeatureSection from "./components/FeatureSection";
import BenchmarkPage from "./components/BenchmarkPage";
import DocsPage from "./components/DocsPage";

const App: React.FC = () => {
	const [view, setView] = useState<
		"new-landing" | "old-landing" | "benchmarks" | "docs"
	>("new-landing");

	// New landing page has its own nav/footer
	if (view === "new-landing") {
		return (
			<div className="min-h-screen bg-[#0a0a0a] text-white selection:bg-[#00d4aa] selection:text-black font-sans scroll-smooth">
				{/* Minimal Nav for New Landing */}
				<nav className="fixed top-0 left-0 right-0 z-[100] bg-[#0a0a0a]/90 border-b border-white/5 backdrop-blur-xl">
					<div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
						<button
							onClick={() => setView("new-landing")}
							className="text-white font-black text-xl flex items-center gap-2 focus:outline-none hover:opacity-80 transition-opacity"
						>
							<div className="w-7 h-7 bg-[#00d4aa] rounded flex items-center justify-center text-[12px] text-black font-bold">
								M
							</div>
							claudemem
						</button>
						<div className="flex items-center gap-6 text-sm">
							<button
								onClick={() => setView("benchmarks")}
								className="text-gray-500 hover:text-white transition-colors"
							>
								Benchmarks
							</button>
							<button
								onClick={() => setView("docs")}
								className="text-gray-500 hover:text-white transition-colors"
							>
								Docs
							</button>
							<a
								href="https://github.com/MadAppGang/claudemem"
								target="_blank"
								rel="noreferrer"
								className="flex items-center gap-2 bg-white/5 px-4 py-2 rounded-lg border border-white/10 hover:bg-white/10 transition-colors text-white"
							>
								<svg
									className="w-4 h-4"
									fill="currentColor"
									viewBox="0 0 24 24"
								>
									<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
								</svg>
								GitHub
							</a>
						</div>
					</div>
				</nav>

				{/* Main Content */}
				<main className="pt-16">
					<LandingPage />
				</main>

				{/* Version Toggle (for development) */}
				<div className="fixed bottom-4 right-4 z-50">
					<button
						onClick={() => setView("old-landing")}
						className="bg-gray-800 text-gray-400 text-xs px-3 py-2 rounded-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors"
					>
						View Old Version
					</button>
				</div>
			</div>
		);
	}

	// Old landing page and other views
	return (
		<div className="min-h-screen bg-[#0f0f0f] text-white selection:bg-[#00d4aa] selection:text-black font-sans scroll-smooth">
			{/* Original Nav */}
			<nav className="fixed top-0 left-0 right-0 z-[100] bg-[#0f0f0f]/90 border-b border-white/5 backdrop-blur-xl">
				<div className="max-w-7xl mx-auto px-8 h-20 flex items-center justify-between">
					<button
						onClick={() => setView("new-landing")}
						className="text-white font-mono font-black text-2xl tracking-tighter flex items-center gap-3 focus:outline-none hover:opacity-80 transition-opacity"
					>
						<div className="w-8 h-8 bg-[#00d4aa] rounded flex items-center justify-center text-[14px] text-black">
							M
						</div>
						claudemem
					</button>
					<div className="hidden md:flex items-center gap-10 text-[11px] font-mono text-gray-500 uppercase tracking-[0.2em] font-black">
						<button
							onClick={() => setView("benchmarks")}
							className={`hover:text-[#00d4aa] transition-colors focus:outline-none ${view === "benchmarks" ? "text-white" : ""}`}
						>
							Benchmarks
						</button>
						<button
							onClick={() => setView("docs")}
							className={`hover:text-[#00d4aa] transition-colors focus:outline-none ${view === "docs" ? "text-white" : ""}`}
						>
							Docs
						</button>
						<a
							href="https://github.com/MadAppGang/claudemem"
							target="_blank"
							rel="noreferrer"
							className="group flex items-center gap-2 bg-white/5 px-5 py-2.5 border border-white/10 rounded-full hover:bg-white/10 hover:border-white/30 transition-all text-white"
						>
							<svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.744.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
							GitHub
						</a>
					</div>
				</div>
			</nav>

			<main>
				{view === "old-landing" ? (
					<>
						<HeroSection
							onNavigateToBenchmarks={() => setView("benchmarks")}
							onNavigateToDocs={() => setView("docs")}
						/>
						<FeatureSection />
					</>
				) : view === "benchmarks" ? (
					<BenchmarkPage />
				) : (
					<DocsPage />
				)}
			</main>

			{/* Footer for old views */}
			<footer className="py-20 bg-[#050505] border-t border-white/5">
				<div className="max-w-6xl mx-auto px-8">
					<div className="flex flex-col md:flex-row justify-between items-start gap-12 mb-12">
						<div className="space-y-4">
							<div className="text-white font-mono font-black text-2xl tracking-tighter flex items-center gap-3">
								<div className="w-8 h-8 bg-[#00d4aa] rounded flex items-center justify-center text-[14px] text-black">
									M
								</div>
								claudemem
							</div>
							<p className="text-gray-500 text-sm max-w-xs">
								Local-first semantic code intelligence for AI agents.
							</p>
						</div>
						<div className="flex gap-12">
							<div>
								<h4 className="text-white font-bold mb-4 text-sm uppercase tracking-wider">
									Product
								</h4>
								<ul className="space-y-2 text-sm text-gray-500">
									<li>
										<button
											onClick={() => setView("docs")}
											className="hover:text-[#00d4aa] transition-colors"
										>
											Documentation
										</button>
									</li>
									<li>
										<button
											onClick={() => setView("benchmarks")}
											className="hover:text-[#00d4aa] transition-colors"
										>
											Benchmarks
										</button>
									</li>
								</ul>
							</div>
							<div>
								<h4 className="text-white font-bold mb-4 text-sm uppercase tracking-wider">
									Community
								</h4>
								<ul className="space-y-2 text-sm text-gray-500">
									<li>
										<a
											href="https://github.com/MadAppGang/claudemem"
											className="hover:text-[#00d4aa] transition-colors"
										>
											GitHub
										</a>
									</li>
								</ul>
							</div>
						</div>
					</div>
					<div className="pt-8 border-t border-white/5 text-center text-gray-600 text-sm">
						© 2025 MadAppGang. MIT License.
					</div>
				</div>
			</footer>

			{/* Version Toggle (for development) */}
			{view === "old-landing" && (
				<div className="fixed bottom-4 right-4 z-50">
					<button
						onClick={() => setView("new-landing")}
						className="bg-[#00d4aa] text-black text-xs font-bold px-3 py-2 rounded-lg hover:bg-[#00d4aa]/90 transition-colors"
					>
						View New Version
					</button>
				</div>
			)}
		</div>
	);
};

export default App;
