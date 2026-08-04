import { useState } from "react";
import { Link } from "react-router";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { loadTests, removeTest } from "@/lib/tests-store";

export function Tests() {
  const [tests, setTests] = useState(loadTests());

  if (tests.length === 0) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="font-display text-3xl">My tests</h1>
        <p className="text-muted-foreground">
          Nothing here yet. Tests are stored in this browser only.
        </p>
        <Button asChild>
          <Link to="/builder">Create your first test</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-3xl">My tests</h1>
        <Button asChild>
          <Link to="/builder">Create a test</Link>
        </Button>
      </div>
      <div className="space-y-3">
        {tests.map(test => (
          <Card key={test.testId}>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <div className="flex-1">
                <CardTitle>
                  <Link
                    className="hover:underline"
                    to={`/tests/${test.testId}`}
                  >
                    {test.name}
                  </Link>
                </CardTitle>
                <CardDescription>
                  created {new Date(test.createdAt).toLocaleString()}
                </CardDescription>
              </div>
              <Badge variant="secondary">{test.testId.slice(0, 8)}</Badge>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Forget test"
                onClick={() => {
                  removeTest(test.testId);
                  setTests(loadTests());
                }}
              >
                <Trash2 />
              </Button>
            </CardHeader>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        "Forget" only removes the entry from this browser; the test itself keeps
        working for anyone holding its URLs.
      </p>
    </div>
  );
}
