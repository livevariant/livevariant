import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The agent-first install card, prompt-first: the default tab is a
 * paste-into-any-AI prompt that points the agent at this deployment
 * (zero install; the agent discovers the tools itself), with skills,
 * Claude Code / Cowork plugin, Codex plugin and bare MCP one tab away.
 * Shared between the landing page and the create flow's "use your LLM
 * to do the heavy lifting" card.
 */
function CopyButton({
  text,
  onCopied
}: {
  text: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Copy command"
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            onCopied?.();
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            // Clipboard can be denied; showing a green check would lie.
          });
      }}
    >
      {copied ? <Check className="text-live" /> : <Copy />}
    </Button>
  );
}

function CommandRow({
  command,
  prompt = true,
  wrap = false,
  onCopied
}: {
  command: string;
  /** False for values that are not shell commands (URLs). */
  prompt?: boolean;
  /** True for prose (a chat prompt): wraps instead of scrolling. */
  wrap?: boolean;
  onCopied?: () => void;
}) {
  return (
    <div
      className={`flex justify-between gap-2 rounded-md border border-border bg-background px-3 py-1.5 ${
        wrap ? "items-start" : "items-center"
      }`}
    >
      <code
        className={`font-mono text-sm ${
          wrap ? "py-1" : "overflow-x-auto whitespace-nowrap"
        }`}
      >
        {prompt && <span className="text-muted-foreground">$ </span>}
        {command}
      </code>
      <CopyButton text={command} onCopied={onCopied} />
    </div>
  );
}

export function InstallCard({ onConvert }: { onConvert?: () => void }) {
  return (
    <Card className="border-border bg-card shadow-none">
      <CardContent className="pt-6">
        <Tabs defaultValue="ask">
          {/* Five tabs outgrow a phone: the strip swipes within itself
              (no visible scrollbar) instead of widening the page. */}
          <TabsList className="max-w-full overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsTrigger value="ask">ask any AI agent</TabsTrigger>
            <TabsTrigger value="skills">skills</TabsTrigger>
            <TabsTrigger value="claude">Claude Code / Cowork</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
            <TabsTrigger value="mcp">any agent (MCP)</TabsTrigger>
          </TabsList>
          <TabsContent value="ask" className="space-y-2">
            <CommandRow
              command={`I want to A/B test my next "Daily brew" newsletter with ${window.location.host}. Give me some ideas and set it up.`}
              prompt={false}
              wrap
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              Nothing to install: paste this into any AI chat, and naming the
              site is enough for the agent to discover the tools and take it
              from there.
            </p>
          </TabsContent>
          <TabsContent value="skills" className="space-y-2">
            <CommandRow
              command="npx skills add livevariant/livevariant"
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              Installs the LiveVariant skills for your coding agent.
            </p>
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <CommandRow
              command="/plugin marketplace add livevariant/livevariant"
              onCopied={onConvert}
            />
            <CommandRow
              command="/plugin install livevariant@livevariant"
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              The repository is the marketplace; the plugin bundles the skills
              and the hosted MCP endpoint.
            </p>
          </TabsContent>
          <TabsContent value="codex" className="space-y-2">
            <CommandRow
              command="codex plugin marketplace add livevariant/livevariant"
              onCopied={onConvert}
            />
            <CommandRow
              command="codex plugin add livevariant/livevariant"
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              The plugin bundles the skills and the hosted MCP endpoint.
            </p>
          </TabsContent>
          <TabsContent value="mcp" className="space-y-2">
            <CommandRow
              command={`${window.location.origin}/mcp`}
              prompt={false}
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              The hosted endpoint: paste it into any MCP-capable agent. No API
              keys; a test's config and stats secret carry all the authority
              there is.
            </p>
            <CommandRow
              command="npx -y @livevariant/mcp"
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              Or run the same server locally over stdio.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
