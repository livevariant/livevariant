import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * The agent-first install card: skills, Claude Code / Cowork plugin,
 * Codex plugin, or bare MCP. Shared between the landing page's
 * "let your LLM run it" section and the create flow's "use your LLM
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
  onCopied
}: {
  command: string;
  onCopied?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-1.5">
      <code className="overflow-x-auto whitespace-nowrap font-mono text-sm">
        <span className="text-muted-foreground">$ </span>
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
        <Tabs defaultValue="skills">
          <TabsList>
            <TabsTrigger value="skills">skills</TabsTrigger>
            <TabsTrigger value="claude">Claude Code / Cowork</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
            <TabsTrigger value="mcp">any agent (MCP)</TabsTrigger>
          </TabsList>
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
              command="npx -y @livevariant/mcp"
              onCopied={onConvert}
            />
            <p className="text-sm text-muted-foreground">
              Or connect to the hosted endpoint at{" "}
              <code className="font-mono">https://livevariant.com/mcp</code>. No
              API keys; a test's config and stats secret carry all the authority
              there is.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
