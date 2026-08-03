import type { AssetStore, StoredAsset } from "@livevariant/server";

/**
 * AssetStore over an R2 bucket. Deliberately does NOT implement the
 * optional `redirectUrl` presign hook: Cloudflare charges nothing for
 * egress, streaming through the Worker costs I/O rather than billed CPU,
 * and staying on our own origin keeps mail proxies and link scanners
 * looking at a domain they already trust. The hook exists for backends
 * where relaying bytes costs real money; R2 is not one of them.
 */
export class R2AssetStore implements AssetStore {
  constructor(private bucket: R2Bucket) {}

  async put(id: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(id, data, {
      httpMetadata: { contentType }
    });
  }

  async get(id: string): Promise<StoredAsset | null> {
    const object = await this.bucket.get(id);
    if (!object) {
      return null;
    }
    return {
      body: object.body,
      contentType:
        object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size
    };
  }
}
