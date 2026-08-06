# @livevariant/react

Embeddable React components for [LiveVariant](https://livevariant.com):
drop the test-creation flow (email/image tests, page redirect tests,
website tests) into your own React app. Stats and management components
are on the way.

```tsx
import { CreateTest } from "@livevariant/react";
import "@livevariant/react/styles.css";

<CreateTest
  serverUrl="https://livevariant.link"
  onCreated={record => save(record)}
/>;
```

Styling is plain CSS under the `lv-` prefix, themeable through
`--lv-*` custom properties; no Tailwind or other framework required.
