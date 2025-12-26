import React, { useState, useEffect } from 'react';
import { TerminalWindow } from './TerminalWindow';

const DocsPage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'installation' | 'cli' | 'integration' | 'framework-docs'>('installation');

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const navItems = [
    { id: 'installation', label: 'Installation & Setup' },
    { id: 'cli', label: 'CLI Usage' },
    { id: 'framework-docs', label: 'Framework Docs' },
    { id: 'integration', label: 'Claude Code Integration' },
  ];

  const Table = ({ headers, rows }: { headers: string[], rows: string[][] }) => (
    <div className="overflow-x-auto border border-white/10 rounded-lg">
        <table className="w-full text-left border-collapse font-mono text-xs md:text-sm">
            <thead className="bg-[#1a1a1a] text-gray-300">
                <tr>
                    {headers.map((h, i) => (
                        <th key={i} className="p-3 border-b border-white/10 whitespace-nowrap">{h}</th>
                    ))}
                </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-gray-400 bg-[#0c0c0c]">
                {rows.map((row, i) => (
                    <tr key={i}>
                        {row.map((cell, j) => (
                            <td key={j} className="p-3 align-top" dangerouslySetInnerHTML={{__html: cell}} />
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
  );

  return (
    <div className="pt-28 pb-24 px-4 md:px-8 min-h-screen bg-[#0f0f0f]">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-12">
        
        {/* Sidebar Navigation */}
        <aside className="md:w-64 flex-shrink-0">
          <div className="sticky top-32 space-y-8">
            <div>
              <h3 className="text-sm font-bold text-white uppercase tracking-widest mb-4">Documentation</h3>
              <nav className="flex flex-col space-y-1">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id as any)}
                    className={`text-left px-4 py-2 rounded-lg text-sm font-mono transition-colors ${
                      activeSection === item.id
                        ? 'bg-claude-ish/10 text-claude-ish font-bold border border-claude-ish/20'
                        : 'text-gray-500 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
            
            <div className="p-4 rounded-xl bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-white/5 hidden md:block">
                <div className="text-xs text-gray-400 mb-2">Need help?</div>
                <a href="https://github.com/MadAppGang/claudemem/issues" target="_blank" rel="noreferrer" className="text-xs font-bold text-white hover:text-claude-ish flex items-center gap-2">
                    Open an issue <span aria-hidden="true">→</span>
                </a>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 min-w-0">
            {activeSection === 'installation' && (
                <div className="space-y-12 animate-fadeIn">
                    {/* Title */}
                    <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">Installation & Setup</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Local semantic code search for Claude Code. Index your codebase once, search it with natural language.
                        </p>
                    </div>

                    {/* Installation Methods */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">1. Install</h2>
                        
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-gray-200">NPM (Recommended)</h3>
                                <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                    <div className="p-4 text-sm text-gray-300 font-mono">
                                        <div className="flex gap-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>npm install -g claude-codemem</span>
                                        </div>
                                    </div>
                                </TerminalWindow>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-gray-200">Homebrew (macOS)</h3>
                                <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                    <div className="p-4 text-sm text-gray-300 font-mono">
                                        <div className="flex gap-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>brew tap MadAppGang/claude-mem</span>
                                        </div>
                                        <div className="flex gap-2 mt-2">
                                            <span className="text-claude-ish select-none">$</span>
                                            <span>brew install --cask claudemem</span>
                                        </div>
                                    </div>
                                </TerminalWindow>
                            </div>
                        </div>

                        <div className="mt-4">
                            <h3 className="text-lg font-bold text-gray-200 mb-2">Curl (Linux/macOS)</h3>
                            <div className="bg-[#111] border border-white/10 rounded-lg p-4 font-mono text-sm text-gray-400 break-all">
                                curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudemem/main/install.sh | bash
                            </div>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                            <h4 className="text-blue-400 font-bold text-sm uppercase tracking-wider mb-2">Requirements</h4>
                            <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1 font-mono">
                                <li>Node.js 18+ (for npm install)</li>
                                <li>macOS 12+ or Linux (glibc 2.31+)</li>
                                <li>An embedding provider (OpenRouter, Ollama, etc.)</li>
                            </ul>
                        </div>
                    </div>

                    {/* Quick Start */}
                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">2. Quick Start</h2>
                         <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                             <div className="p-6 text-sm text-gray-300 font-mono space-y-4">
                                <div>
                                    <div className="text-gray-500 mb-1"># Initialize configuration (select provider)</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem init</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-gray-500 mb-1"># Index your project</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem index</span>
                                    </div>
                                </div>
                                <div>
                                    <div className="text-gray-500 mb-1"># Search</div>
                                    <div className="flex gap-2">
                                        <span className="text-claude-ish select-none">$</span>
                                        <span>claudemem search "authentication flow"</span>
                                    </div>
                                </div>
                             </div>
                         </TerminalWindow>
                    </div>

                    {/* Embedding Providers */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">3. Configure Embeddings</h2>
                        <p className="text-gray-400">claudemem needs an embedding provider to generate vector representations of your code.</p>
                        
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">OpenRouter</h3>
                                    <span className="text-[10px] bg-claude-ish/20 text-claude-ish px-2 py-1 rounded border border-claude-ish/30 uppercase font-bold">Recommended</span>
                                </div>
                                <p className="text-sm text-gray-400">Best quality and easiest setup for cloud usage.</p>
                                <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-300">
                                    export OPENROUTER_API_KEY="your-key"<br/>
                                    claudemem init <span className="text-gray-500"># select "OpenRouter"</span>
                                </div>
                                <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-xs text-claude-ish hover:underline">Get API Key →</a>
                            </div>

                            <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">Ollama</h3>
                                    <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/30 uppercase font-bold">Local & Free</span>
                                </div>
                                <p className="text-sm text-gray-400">Run entirely offline. Requires <a href="https://ollama.ai" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Ollama</a> installed.</p>
                                <div className="bg-black/50 p-3 rounded border border-white/10 font-mono text-xs text-gray-300">
                                    ollama pull nomic-embed-text<br/>
                                    claudemem init <span className="text-gray-500"># select "Ollama"</span>
                                </div>
                                <div className="text-[10px] text-gray-500 font-mono">
                                    Recommended: nomic-embed-text (768d)
                                </div>
                            </div>
                        </div>
                        
                        <div className="bg-[#151515] p-4 rounded-xl border border-white/5">
                             <h4 className="text-white font-bold text-sm mb-2">Custom Endpoint</h4>
                             <p className="text-xs text-gray-400 mb-2">Compatible with any OpenAI-style embedding endpoint.</p>
                             <div className="font-mono text-xs text-gray-500">claudemem init # select "Custom endpoint"</div>
                        </div>
                    </div>

                    {/* LLM Enrichment */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">4. LLM Enrichment</h2>
                        <p className="text-gray-400">
                            Configure which LLM to use for generating semantic summaries. Use the unified spec format: <code className="text-claude-ish">provider/model</code>
                        </p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse font-mono text-sm border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Prefix</th>
                                        <th className="p-3 border-b border-white/10">Provider</th>
                                        <th className="p-3 border-b border-white/10">Example</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 text-gray-400 bg-[#0c0c0c]">
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">cc/</td>
                                        <td className="p-3">Claude Code (Subscription)</td>
                                        <td className="p-3 text-gray-500">cc/sonnet, cc/opus</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">a/</td>
                                        <td className="p-3">Anthropic API</td>
                                        <td className="p-3 text-gray-500">a/sonnet, a/opus</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">or/</td>
                                        <td className="p-3">OpenRouter</td>
                                        <td className="p-3 text-gray-500">or/openai/gpt-4o</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-claude-ish font-bold">ollama/</td>
                                        <td className="p-3">Ollama (Local)</td>
                                        <td className="p-3 text-gray-500">ollama/llama3.2</td>
                                    </tr>
                                     <tr>
                                        <td className="p-3 text-claude-ish font-bold">lmstudio/</td>
                                        <td className="p-3">LM Studio (Local)</td>
                                        <td className="p-3 text-gray-500">lmstudio/</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-[#151515] p-6 rounded-xl border border-white/5 space-y-4">
                            <h3 className="text-lg font-bold text-white">Using Claude Code Subscription</h3>
                            <p className="text-sm text-gray-400">
                                If you have a Claude Pro/Teams subscription via Claude Code CLI, we can use it directly. Zero extra API cost.
                            </p>
                            <div className="bg-black/50 p-4 rounded border border-white/10 font-mono text-sm text-gray-300">
                                <span className="text-claude-ish">export</span> CLAUDEMEM_LLM="cc/sonnet"
                            </div>
                        </div>
                    </div>

                    {/* Reference */}
                     <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Reference</h2>
                        
                        <div className="grid lg:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-white">Environment Variables</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                        <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                            <tr>
                                                <td className="p-3 text-blue-300">OPENROUTER_API_KEY</td>
                                                <td className="p-3">Embeddings + LLM</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">ANTHROPIC_API_KEY</td>
                                                <td className="p-3">Anthropic LLM</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">VOYAGE_API_KEY</td>
                                                <td className="p-3">Voyage AI embeddings</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">CLAUDEMEM_MODEL</td>
                                                <td className="p-3">Override embedding model</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-blue-300">CLAUDEMEM_LLM</td>
                                                <td className="p-3">Enrichment LLM Spec</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-white">Config Files</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                        <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                            <tr>
                                                <td className="p-3 text-yellow-300">~/.claudemem/config.json</td>
                                                <td className="p-3">Global config</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-yellow-300">.claudemem/</td>
                                                <td className="p-3">Project index (add to .gitignore)</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3 text-yellow-300">claudemem.json</td>
                                                <td className="p-3">Project-specific config</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {activeSection === 'cli' && (
                <div className="space-y-12 animate-fadeIn">
                    <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">CLI Reference</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Complete command-line interface documentation for claudemem.
                        </p>
                    </div>

                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Quick Start</h2>
                         <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                             <div className="p-6 text-sm text-gray-300 font-mono space-y-4">
                                <div><span className="text-gray-500"># 1. First time setup</span></div>
                                <div className="flex gap-2 mb-4"><span className="text-claude-ish">$</span> claudemem init</div>
                                
                                <div><span className="text-gray-500"># 2. Index your project</span></div>
                                <div className="flex gap-2 mb-4"><span className="text-claude-ish">$</span> claudemem index</div>
                                
                                <div><span className="text-gray-500"># 3. Search</span></div>
                                <div className="flex gap-2"><span className="text-claude-ish">$</span> claudemem search "authentication flow"</div>
                             </div>
                         </TerminalWindow>
                    </div>

                    {/* Core Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Core Commands</h2>
                        
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">init</span></h3>
                            <p className="text-gray-400">Configure embedding and LLM providers interactively.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem init
                                </div>
                            </TerminalWindow>
                        </div>
                        
                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">index</span> <span className="text-gray-500 text-sm">[path]</span></h3>
                             <p className="text-gray-400">Parse and index your codebase for semantic search.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">-f, --force</code>', 'Force re-index all files (ignore cache)'],
                                    ['<code class="text-white">--no-llm</code>', 'Disable LLM enrichment (faster, code-only)'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">search</span> <span className="text-gray-500 text-sm">&lt;query&gt;</span></h3>
                             <p className="text-gray-400">Search indexed code using natural language queries.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">-n, --limit &lt;n&gt;</code>', 'Maximum results (default: 10)'],
                                    ['<code class="text-white">-l, --language &lt;lang&gt;</code>', 'Filter by programming language'],
                                    ['<code class="text-white">--no-reindex</code>', 'Skip auto-reindexing changed files'],
                                    ['<code class="text-white">-k, --keyword</code>', 'Keyword-only search (BM25, no embeddings)'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">status</span></h3>
                             <p className="text-gray-400">Display information about the current index size, chunks, and embedding model.</p>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">clear</span></h3>
                             <p className="text-gray-400">Remove all indexed data for a project.</p>
                        </div>
                    </div>

                    {/* Symbol Graph Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Symbol Graph Commands</h2>
                        <p className="text-gray-400">Query the dependency graph directly. Optimized for agent use.</p>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">map</span> <span className="text-gray-500 text-sm">[query]</span></h3>
                             <p className="text-gray-400">Get a high-level map of the codebase prioritized by PageRank.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-claude-ish">$</span> claudemem map "auth"
                             </div>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">callers</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Find what code calls or references a specific symbol.</p>
                        </div>
                        
                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">callees</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Find what dependencies a symbol uses.</p>
                        </div>
                    </div>

                    {/* Code Analysis */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Code Analysis</h2>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">dead-code</span></h3>
                             <p className="text-gray-400">Detect potentially dead code (zero callers + low PageRank).</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">--max-pagerank &lt;n&gt;</code>', 'PageRank threshold (default: 0.001)'],
                                    ['<code class="text-white">--include-exported</code>', 'Include exported symbols'],
                                ]}
                             />
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">test-gaps</span></h3>
                             <p className="text-gray-400">Find high-importance code that lacks test coverage.</p>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">impact</span> <span className="text-gray-500 text-sm">&lt;symbol&gt;</span></h3>
                             <p className="text-gray-400">Analyze the "blast radius" of changing a symbol.</p>
                        </div>
                    </div>

                    {/* Benchmark Commands */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Benchmark Commands</h2>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">benchmark</span></h3>
                             <p className="text-gray-400">Compare embedding models for speed and quality on your code.</p>
                             <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-claude-ish">$</span> claudemem benchmark --models=voyage-code-3,openai/text-embedding-3-small
                             </div>
                        </div>

                        <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">benchmark-llm</span></h3>
                             <p className="text-gray-400">Evaluate LLM summarizer quality using LLM-as-a-Judge.</p>
                             <Table 
                                headers={['Flag', 'Description']}
                                rows={[
                                    ['<code class="text-white">--generators=&lt;list&gt;</code>', 'Models to test (comma-separated)'],
                                    ['<code class="text-white">--judges=&lt;list&gt;</code>', 'Judge models for evaluation'],
                                    ['<code class="text-white">--local-parallelism=&lt;n&gt;</code>', 'Concurrency for local models'],
                                ]}
                             />
                        </div>
                    </div>

                     {/* Server Modes */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Server Modes</h2>
                        
                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono">MCP Server</h3>
                            <p className="text-gray-400">Run as a Model Context Protocol server for Claude Code.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem --mcp
                                </div>
                            </TerminalWindow>
                        </div>

                        <div className="space-y-4">
                            <h3 className="text-xl font-bold text-white font-mono">Autocomplete Server</h3>
                            <p className="text-gray-400">Run a JSONL server for editor autocomplete.</p>
                            <TerminalWindow title="bash" className="bg-[#0c0c0c]" noPadding>
                                <div className="p-4 text-sm text-gray-300 font-mono">
                                    <span className="text-claude-ish">$</span> claudemem --autocomplete-server --project .
                                </div>
                            </TerminalWindow>
                        </div>
                    </div>

                    {/* Developer Experience */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Developer Experience</h2>
                        
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">watch</span></h3>
                                <p className="text-gray-400">Run in daemon mode, watching for file changes.</p>
                                <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                    <span className="text-claude-ish">$</span> claudemem watch
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">hooks</span></h3>
                                <p className="text-gray-400">Install git post-commit hook for auto-indexing.</p>
                                <div className="font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                    <span className="text-claude-ish">$</span> claudemem hooks install
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Agent Instructions */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">AI Agent Instructions</h2>
                         <div className="space-y-4">
                             <h3 className="text-xl font-bold text-white font-mono flex items-center gap-2"><span className="text-claude-ish">ai</span> <span className="text-gray-500 text-sm">&lt;role&gt;</span></h3>
                             <p className="text-gray-400">Get role-based prompts to teach agents how to use claudemem.</p>
                             <Table 
                                headers={['Role', 'Description']}
                                rows={[
                                    ['<code class="text-white">skill</code>', 'Full tool skill documentation'],
                                    ['<code class="text-white">architect</code>', 'System design & dead-code detection'],
                                    ['<code class="text-white">developer</code>', 'Implementation & impact analysis'],
                                    ['<code class="text-white">tester</code>', 'Test coverage planning'],
                                ]}
                             />
                             <div className="mt-4 font-mono text-sm bg-black/30 p-3 rounded border border-white/10 text-gray-300">
                                <span className="text-gray-500"># Append to CLAUDE.md for Claude Code</span><br/>
                                <span className="text-claude-ish">$</span> claudemem ai skill --raw &gt;&gt; CLAUDE.md
                             </div>
                        </div>
                    </div>

                    {/* Environment Variables */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Configuration</h2>
                        <h3 className="text-lg font-bold text-white mb-2">Environment Variables</h3>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left font-mono text-xs border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Variable</th>
                                        <th className="p-3 border-b border-white/10">Description</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                    <tr>
                                        <td className="p-3 text-blue-300">OPENROUTER_API_KEY</td>
                                        <td className="p-3">API key for OpenRouter (embeddings + LLM)</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">ANTHROPIC_API_KEY</td>
                                        <td className="p-3">API key for Anthropic LLM</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">VOYAGE_API_KEY</td>
                                        <td className="p-3">API key for Voyage AI embeddings</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">CLAUDEMEM_MODEL</td>
                                        <td className="p-3">Override embedding model</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-blue-300">CLAUDEMEM_LLM</td>
                                        <td className="p-3">LLM spec for enrichment</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        
                        <h3 className="text-lg font-bold text-white mt-8 mb-2">Supported Languages</h3>
                        <p className="text-sm text-gray-400 mb-4">Full AST-aware parsing is available for:</p>
                        <div className="flex flex-wrap gap-2 font-mono text-xs">
                            {['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'C', 'C++', 'Java'].map(lang => (
                                <span key={lang} className="bg-white/10 text-white px-2 py-1 rounded">{lang}</span>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {activeSection === 'integration' && (
                <div className="space-y-12 animate-fadeIn">
                     {/* Title */}
                     <div>
                        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">Integration Guide</h1>
                        <p className="text-xl text-gray-400 leading-relaxed">
                            Complete guide for using claudemem with Claude Code and the Code Analysis Plugin.
                        </p>
                    </div>

                    {/* Overview & Diagram */}
                    <div className="space-y-6">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Overview</h2>
                        <div className="grid lg:grid-cols-2 gap-8 items-start">
                             <div className="space-y-4">
                                 <p className="text-gray-400 text-sm leading-relaxed">
                                     When combined with the <strong>Code Analysis Plugin</strong>, claudemem gives Claude "detective skills" to navigate your codebase. Instead of guessing files or running grep, it can trace calls, find definitions, and understand architecture.
                                 </p>
                                 <Table 
                                    headers={['Component', 'Purpose']}
                                    rows={[
                                        ['<strong class="text-white">claudemem CLI</strong>', 'Local semantic search engine & graph builder'],
                                        ['<strong class="text-white">Code Analysis Plugin</strong>', 'Claude Code plugin with detective skills'],
                                        ['<strong class="text-white">Detective Skills</strong>', 'Role-based patterns (Architect, Debugger, etc.)'],
                                    ]}
                                 />
                             </div>
                             <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-[10px] text-gray-400 overflow-x-auto leading-relaxed whitespace-pre shadow-2xl">
{`┌────────────────────────────────────────────────────────┐
│               CLAUDE CODE + CLAUDEMEM                  │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  CLAUDE CODE                     │  │
│  │ User Query → Plugin → Detective Skill            │  │
│  └──────────────────────────────────────────────────┘  │
│                           ↓                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │                 CLAUDEMEM CLI                    │  │
│  │ map | symbol | callers | callees | search        │  │
│  └──────────────────────────────────────────────────┘  │
│                           ↓                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  LOCAL INDEX                     │  │
│  │ AST Parse → PageRank → Vector DB                 │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘`}
                             </div>
                        </div>
                    </div>

                    {/* Quick Start */}
                    <div className="space-y-6">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Quick Start</h2>
                         
                         <div className="space-y-4">
                             <h3 className="text-lg font-bold text-white">1. Install & Index</h3>
                             <TerminalWindow title="terminal" className="bg-[#0c0c0c]" noPadding>
                                 <div className="p-4 text-sm text-gray-300 font-mono space-y-2">
                                     <div><span className="text-claude-ish">$</span> npm install -g claude-codemem</div>
                                     <div><span className="text-claude-ish">$</span> claudemem init</div>
                                     <div><span className="text-claude-ish">$</span> claudemem index</div>
                                 </div>
                             </TerminalWindow>
                         </div>

                         <div className="space-y-6">
                             <h3 className="text-lg font-bold text-white">2. Install Plugin</h3>
                             
                             <div className="space-y-4">
                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-xs">1</div>
                                         <h4 className="font-bold text-white text-sm">Add Marketplace (Global)</h4>
                                     </div>
                                     <TerminalWindow title="claude" className="bg-[#0c0c0c]" noPadding>
                                         <div className="p-3 text-xs text-gray-300 font-mono">
                                             <span className="text-purple-400">/plugin</span> marketplace add MadAppGang/claude-code
                                         </div>
                                     </TerminalWindow>
                                 </div>

                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-xs">2</div>
                                         <h4 className="font-bold text-white text-sm">Enable for Project</h4>
                                     </div>
                                     <p className="text-xs text-gray-400 mb-2 font-mono">.claude/settings.json</p>
                                     <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-3 font-mono text-xs text-blue-300">
{`{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true
  }
}`}
                                     </div>
                                 </div>
                                 
                                 <div className="bg-[#151515] border border-white/5 rounded-xl p-6">
                                     <div className="flex items-center gap-4 mb-4">
                                         <div className="w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center font-bold text-xs">3</div>
                                         <h4 className="font-bold text-white text-sm">Update</h4>
                                     </div>
                                     <TerminalWindow title="claude" className="bg-[#0c0c0c]" noPadding>
                                         <div className="p-3 text-xs text-gray-300 font-mono">
                                             <span className="text-purple-400">/plugin</span> marketplace update mag-claude-plugins
                                         </div>
                                     </TerminalWindow>
                                 </div>
                             </div>
                             
                             <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-lg mt-4">
                                 <h4 className="text-blue-400 text-xs font-bold uppercase tracking-widest mb-1">Why this flow?</h4>
                                 <p className="text-xs text-gray-300 leading-relaxed">
                                     Marketplace registration is one-time per developer. Plugin enablement is per-project via <code className="bg-blue-500/20 px-1 rounded">settings.json</code>, ensuring your whole team gets the same tools automatically.
                                 </p>
                             </div>
                         </div>

                         <div className="bg-claude-ish/10 border border-claude-ish/20 p-4 rounded-lg">
                             <p className="text-sm text-gray-300">
                                 <strong className="text-claude-ish">That's it!</strong> Now just ask natural questions like <em>"How does auth work?"</em> or <em>"Find usages of User class"</em>.
                             </p>
                         </div>
                    </div>

                    {/* Detective Skills */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Detective Skills</h2>
                        <p className="text-gray-400">
                            The plugin automatically selects the right "detective" based on your question.
                        </p>

                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">developer-detective</h3>
                                    <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded border border-blue-500/30 uppercase font-bold">Implementation</span>
                                </div>
                                <p className="text-sm text-gray-400">Traces code execution and implementation details.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "How does X work?" • "Trace data flow"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">architect-detective</h3>
                                    <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-1 rounded border border-purple-500/30 uppercase font-bold">Structure</span>
                                </div>
                                <p className="text-sm text-gray-400">Analyzes system design, layers, and dead code.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "Map the system" • "Find dead code"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">tester-detective</h3>
                                    <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-1 rounded border border-green-500/30 uppercase font-bold">Coverage</span>
                                </div>
                                <p className="text-sm text-gray-400">Identifies test gaps in critical code.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "What is untested?" • "Coverage analysis"
                                </div>
                            </div>

                            <div className="bg-[#151515] p-5 rounded-xl border border-white/5 space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-bold text-white">debugger-detective</h3>
                                    <span className="text-[10px] bg-red-500/20 text-red-500 px-2 py-1 rounded border border-red-500/30 uppercase font-bold">Fixing</span>
                                </div>
                                <p className="text-sm text-gray-400">Investigates bugs by tracing error paths.</p>
                                <div className="text-xs font-mono text-gray-500 bg-black/30 p-2 rounded">
                                    "Why is X broken?" • "Trace error"
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Workflows */}
                    <div className="space-y-8">
                         <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Workflow Examples</h2>
                         
                         <div className="space-y-6">
                             <div>
                                 <h3 className="text-lg font-bold text-white mb-2">Refactoring Safely</h3>
                                 <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-sm space-y-2">
                                     <div className="flex gap-2">
                                         <span className="text-claude-ish">User:</span>
                                         <span className="text-gray-300">"I want to rename DatabaseConnection to DatabasePool"</span>
                                     </div>
                                     <div className="w-full h-[1px] bg-white/5 my-2"></div>
                                     <div className="text-gray-500 italic">Claude Actions:</div>
                                     <div className="text-blue-300">1. claudemem symbol DatabaseConnection</div>
                                     <div className="text-blue-300">2. claudemem callers DatabaseConnection</div>
                                     <div className="text-gray-400 pl-4">→ Finds 12 usages in 5 files</div>
                                     <div className="text-blue-300">3. [Edits files]</div>
                                 </div>
                             </div>

                             <div>
                                 <h3 className="text-lg font-bold text-white mb-2">Understanding Architecture</h3>
                                 <div className="bg-[#0c0c0c] border border-white/10 rounded-lg p-4 font-mono text-sm space-y-2">
                                     <div className="flex gap-2">
                                         <span className="text-claude-ish">User:</span>
                                         <span className="text-gray-300">"How is the payment flow structured?"</span>
                                     </div>
                                     <div className="w-full h-[1px] bg-white/5 my-2"></div>
                                     <div className="text-gray-500 italic">Claude Actions:</div>
                                     <div className="text-blue-300">1. claudemem map "payment flow"</div>
                                     <div className="text-gray-400 pl-4">→ Identifies PaymentService (Rank 0.8) and StripeAdapter (Rank 0.4)</div>
                                     <div className="text-blue-300">2. claudemem callees PaymentService</div>
                                     <div className="text-gray-400 pl-4">→ Maps dependencies: User, Config, StripeAdapter</div>
                                 </div>
                             </div>
                         </div>
                    </div>

                    {/* Best Practices */}
                    <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Best Practices</h2>
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-[#3fb950] flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                                    DO
                                </h3>
                                <ul className="space-y-3 text-sm text-gray-400">
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Start with <code>claudemem map</code> to get the big picture.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Check <code>callers</code> before changing any shared code.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Focus on high PageRank symbols ({">"} 0.05) first.</li>
                                    <li className="flex gap-2"><span className="text-[#3fb950]">•</span> Use <code>--nologo --raw</code> in scripts/hooks.</li>
                                </ul>
                            </div>
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-[#ff5f56] flex items-center gap-2">
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                    DON'T
                                </h3>
                                <ul className="space-y-3 text-sm text-gray-400">
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't use <code>grep</code> for concept searches.</li>
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't read entire files when you only need a function.</li>
                                    <li className="flex gap-2"><span className="text-[#ff5f56]">•</span> Don't modify code without checking <code>impact</code>.</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    {/* Requirements */}
                     <div className="space-y-8">
                        <h2 className="text-2xl font-bold text-white border-b border-white/10 pb-4">Requirements</h2>
                         <div className="overflow-x-auto">
                            <table className="w-full text-left font-mono text-sm border border-white/10 rounded-lg">
                                <thead className="bg-[#1a1a1a] text-gray-300">
                                    <tr>
                                        <th className="p-3 border-b border-white/10">Requirement</th>
                                        <th className="p-3 border-b border-white/10">Version</th>
                                        <th className="p-3 border-b border-white/10">Notes</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 bg-[#0c0c0c] text-gray-400">
                                    <tr>
                                        <td className="p-3 text-white">claudemem</td>
                                        <td className="p-3">0.3.0+</td>
                                        <td className="p-3">Core commands (map, symbol)</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-white">Claude Code</td>
                                        <td className="p-3">Latest</td>
                                        <td className="p-3">Plugin support required</td>
                                    </tr>
                                    <tr>
                                        <td className="p-3 text-white">Node.js</td>
                                        <td className="p-3">18+</td>
                                        <td className="p-3">For installation</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default DocsPage;